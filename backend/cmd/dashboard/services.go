package main

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	gopsnet "github.com/shirou/gopsutil/v4/net"
	gopsprocess "github.com/shirou/gopsutil/v4/process"
	utf16x "unicode/utf16"
)

// 服务状态：stopped 未启动；starting 已拉起、健康探测未通过；running 探测通过；
// external 端口健康但进程不是本看板拉起的（如 .local 里的 cmd 脚本启动的）。
const (
	statusStopped  = "stopped"
	statusStarting = "starting"
	statusRunning  = "running"
	statusExternal = "external"
)

const logRingCap = 3000

type logLine struct {
	Seq  int64  `json:"seq"`
	Text string `json:"text"`
}

type logBuffer struct {
	mu    sync.Mutex
	seq   int64
	lines []logLine
}

func (b *logBuffer) write(text string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.seq++
	b.lines = append(b.lines, logLine{Seq: b.seq, Text: text})
	if len(b.lines) > logRingCap {
		b.lines = b.lines[len(b.lines)-logRingCap:]
	}
}

func (b *logBuffer) snapshot(after int64) ([]logLine, int64) {
	b.mu.Lock()
	defer b.mu.Unlock()
	out := make([]logLine, 0, len(b.lines))
	for _, line := range b.lines {
		if line.Seq > after {
			out = append(out, line)
		}
	}
	return out, b.seq
}

type service struct {
	name      string
	mu        sync.Mutex
	cmd       *exec.Cmd
	proc      *os.Process
	pid       int
	status    string
	started   time.Time
	exited    bool
	exitErr   string
	logs      logBuffer
	probeKind string // "http" 健康探测；"tcp" 仅端口连通
	probeURL  string
	probeAddr string
	openURL   string
	// externalPid/externalName 记录非本看板拉起的监听进程（如 .local 脚本启动的服务），
	// 让看板可以展示并停止它们。
	externalPid  int
	externalName string
}

func (s *service) managed() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return !s.exited && s.proc != nil
}

func (s *service) snapshot() map[string]any {
	s.mu.Lock()
	defer s.mu.Unlock()
	state := map[string]any{
		"name":      s.name,
		"status":    s.status,
		"pid":       s.pid,
		"exitError": s.exitErr,
		"openUrl":   s.openURL,
		"startedAt": nil,
	}
	if !s.started.IsZero() {
		state["startedAt"] = s.started.Format(time.RFC3339)
		state["uptimeSec"] = int(time.Since(s.started).Seconds())
	}
	if s.status == statusExternal && s.externalPid != 0 {
		state["externalPid"] = s.externalPid
		state["externalName"] = s.externalName
	}
	return state
}

type serviceManager struct {
	cfg      config
	services map[string]*service
	order    []string // 依赖顺序：backend -> proxy -> frontend -> gateway -> comfy
	guardian *guardian
}

func newServiceManager(cfg config) *serviceManager {
	m := &serviceManager{
		cfg: cfg,
		services: map[string]*service{
			"backend": {name: "backend", status: statusStopped, probeKind: "http",
				probeURL:  cfg.BackendURL + "/api/health/live",
				probeAddr: "127.0.0.1:8080", openURL: cfg.BackendURL},
			"proxy": {name: "proxy", status: statusStopped, probeKind: "tcp",
				probeAddr: fmt.Sprintf("127.0.0.1:%d", cfg.ProxyPort)},
			"frontend": {name: "frontend", status: statusStopped, probeKind: "tcp",
				probeAddr: fmt.Sprintf("127.0.0.1:%d", cfg.FrontendPort)},
			"gateway": {name: "gateway", status: statusStopped, probeKind: "tcp",
				probeAddr: fmt.Sprintf("127.0.0.1:%d", cfg.GatewayPort)},
			// ComfyUI 由计划任务 ComfyUI-Start 启动（模型加载可达数分钟），
			// 看板只做健康等待与停止，不持有进程句柄。
			"comfy": {name: "comfy", status: statusStopped, probeKind: "http",
				probeURL: cfg.ComfyURL + "/system_stats", probeAddr: cfg.ComfyAddr, openURL: cfg.ComfyURL},
		},
		order: []string{"backend", "proxy", "frontend", "gateway", "comfy"},
	}
	m.guardian = newGuardian(m)
	go m.tailComfyConsole()
	return m
}

func (m *serviceManager) get(name string) (*service, bool) {
	s, ok := m.services[name]
	return s, ok
}

func (m *serviceManager) Snapshot() map[string]any {
	owners := m.portOwners()
	for _, name := range m.order {
		m.refreshStatus(m.services[name], owners)
	}
	services := make([]map[string]any, 0, len(m.order))
	for _, name := range m.order {
		services = append(services, m.services[name].snapshot())
	}
	return map[string]any{
		"version":          dashboardVersion,
		"repo":             m.cfg.RepoRoot,
		"services":         services,
		"frontendUrl":      m.FrontendURL(),
		"backendExeExists": fileExists(m.cfg.BackendExe),
	}
}

// portOwners 一次性枚举 TCP 监听表，得到 端口 -> PID 映射，用于识别外部进程。
func (m *serviceManager) portOwners() map[int]int {
	conns, err := gopsnet.Connections("tcp")
	if err != nil {
		return nil
	}
	owners := make(map[int]int)
	for _, conn := range conns {
		if conn.Status == "LISTEN" && conn.Laddr.Port != 0 && conn.Pid > 0 {
			owners[int(conn.Laddr.Port)] = int(conn.Pid)
		}
	}
	return owners
}

// refreshStatus 更新健康状态：本看板拉起的进程探测通过 -> running；
// 未拉起但端口有健康服务 -> external，并通过端口监听表定位其 PID 与进程名。
func (m *serviceManager) refreshStatus(s *service, owners map[int]int) {
	healthy := m.probe(s)
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.exited && s.proc != nil {
		s.externalPid = 0
		s.externalName = ""
		if healthy && s.status == statusStarting {
			s.status = statusRunning
		}
		return
	}
	switch {
	case healthy && s.status == statusStopped:
		s.status = statusExternal
	case !healthy && s.status == statusExternal:
		s.status = statusStopped
	}
	if s.status == statusExternal {
		if pid, ok := owners[servicePort(s.probeAddr)]; ok {
			s.externalPid = pid
			if proc, err := gopsprocess.NewProcess(int32(pid)); err == nil {
				s.externalName, _ = proc.Name()
			}
		}
	} else {
		s.externalPid = 0
		s.externalName = ""
	}
}

// servicePort 从 "127.0.0.1:8080" 形式的地址解析端口。
func servicePort(addr string) int {
	_, portStr, err := net.SplitHostPort(addr)
	if err != nil {
		return 0
	}
	port, _ := strconv.Atoi(portStr)
	return port
}

func (m *serviceManager) probe(s *service) bool {
	ctx, cancel := context.WithTimeout(context.Background(), 800*time.Millisecond)
	defer cancel()
	if s.probeKind == "http" {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, s.probeURL, nil)
		if err != nil {
			return false
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			return false
		}
		defer resp.Body.Close()
		return resp.StatusCode < 500
	}
	return tcpOpen(ctx, s.probeAddr)
}

func tcpOpen(ctx context.Context, addr string) bool {
	var d net.Dialer
	conn, err := d.DialContext(ctx, "tcp", addr)
	if err != nil {
		return false
	}
	_ = conn.Close()
	return true
}

// portBusy 探测端口是否有任意监听（含健康检查未过的进程），用于启动前的冲突预检。
func (m *serviceManager) portBusy(s *service) bool {
	ctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
	defer cancel()
	return tcpOpen(ctx, s.probeAddr)
}

// StartAll 一键启动：ComfyUI 加载模型最慢（1-3 分钟），先异步点火不等它；
// 其余服务按依赖顺序同步拉起并等待健康。
func (m *serviceManager) StartAll(ctx context.Context) {
	if comfy, ok := m.get("comfy"); ok && !comfy.managed() && !m.portBusy(comfy) {
		go func() { _ = m.Start("comfy") }()
	}
	for _, name := range []string{"backend", "proxy", "frontend", "gateway"} {
		if err := m.Start(name); err != nil {
			m.services[name].logs.write("[dashboard] start failed: " + err.Error())
		}
		m.waitHealthy(ctx, name, 45*time.Second)
	}
}

// StopAll 只停止本看板拉起的服务；退出看板时调用，不影响用户自行启动的服务。
func (m *serviceManager) StopAll() {
	for i := len(m.order) - 1; i >= 0; i-- {
		s := m.services[m.order[i]]
		if s.managed() {
			_ = m.stopService(s)
		}
	}
}

// StopEverything 连同外部启动的服务一起停止，仅供「一键停止」按钮使用。
func (m *serviceManager) StopEverything() {
	// 先刷新一遍状态，确保外部进程的 PID 已按端口解析到位。
	m.Snapshot()
	for i := len(m.order) - 1; i >= 0; i-- {
		_ = m.stopService(m.services[m.order[i]])
	}
}

func (m *serviceManager) waitHealthy(ctx context.Context, name string, timeout time.Duration) {
	s := m.services[name]
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		select {
		case <-ctx.Done():
			return
		default:
		}
		if !s.managed() {
			return
		}
		if m.probe(s) {
			s.mu.Lock()
			if s.status == statusStarting {
				s.status = statusRunning
			}
			s.mu.Unlock()
			return
		}
		time.Sleep(700 * time.Millisecond)
	}
}

func (m *serviceManager) Start(name string) error {
	s, ok := m.get(name)
	if !ok {
		return fmt.Errorf("unknown service %q", name)
	}
	if s.managed() {
		s.logs.write(fmt.Sprintf("[dashboard] already running (pid %d)", s.pid))
		return nil
	}

	// 端口被其他进程（包括外部方式启动的同名服务）占用时拒绝启动，避免端口冲突。
	if m.portBusy(s) {
		err := fmt.Errorf("port %s is already in use by an external process", s.probeAddr)
		s.logs.write("[dashboard] " + err.Error())
		return err
	}

	// ComfyUI 走计划任务拉起，进程归任务计划程序所有，不进入托管进程路径。
	if name == "comfy" {
		return m.startComfy(s)
	}

	var cmd *exec.Cmd
	var err error
	switch name {
	case "backend":
		cmd, err = m.backendCommand()
	case "proxy":
		cmd, err = m.proxyCommand()
	case "frontend":
		cmd, err = m.frontendCommand()
	case "gateway":
		cmd, err = m.gatewayCommand()
	default:
		err = fmt.Errorf("unknown service %q", name)
	}
	if err != nil {
		s.logs.write("[dashboard] " + err.Error())
		return err
	}

	stdout, pipeErr := cmd.StdoutPipe()
	if pipeErr != nil {
		return pipeErr
	}
	stderr, pipeErr := cmd.StderrPipe()
	if pipeErr != nil {
		return pipeErr
	}
	prepareChildCmd(cmd)
	go scannerFeed(s, stdout)
	go scannerFeed(s, stderr)

	s.mu.Lock()
	s.exited = false
	s.exitErr = ""
	s.status = statusStarting
	s.started = time.Now()
	s.mu.Unlock()

	if err := cmd.Start(); err != nil {
		s.mu.Lock()
		s.status = statusStopped
		s.exited = true
		s.exitErr = err.Error()
		s.mu.Unlock()
		s.logs.write("[dashboard] spawn failed: " + err.Error())
		return err
	}

	s.mu.Lock()
	s.cmd = cmd
	s.proc = cmd.Process
	s.pid = cmd.Process.Pid
	s.mu.Unlock()
	assignToJobObject(s.pid)

	go s.awaitExit()
	s.logs.write(fmt.Sprintf("[dashboard] started %s (pid %d)", name, s.pid))
	return nil
}

func (s *service) awaitExit() {
	s.mu.Lock()
	cmd := s.cmd
	s.mu.Unlock()
	err := cmd.Wait()
	s.mu.Lock()
	s.exited = true
	s.proc = nil
	s.status = statusStopped
	if err != nil {
		s.exitErr = err.Error()
	} else {
		s.exitErr = ""
	}
	s.mu.Unlock()
	s.logs.write(fmt.Sprintf("[dashboard] %s exited: %v", s.name, err))
}

func (m *serviceManager) Stop(name string) error {
	s, ok := m.get(name)
	if !ok {
		return fmt.Errorf("unknown service %q", name)
	}
	return m.stopService(s)
}

func (m *serviceManager) stopService(s *service) error {
	if s.managed() {
		s.mu.Lock()
		pid := s.pid
		proc := s.proc
		s.mu.Unlock()
		s.logs.write(fmt.Sprintf("[dashboard] stopping %s (pid %d)", s.name, pid))
		if err := gracefulStop(proc, pid); err != nil {
			// 控制台事件不可达（例如看板运行在无真实控制台的环境）时直接强杀。
			s.logs.write("[dashboard] signal not deliverable (" + err.Error() + "), force kill")
			killTreeForce(pid)
		} else if m.waitGone(s, 10*time.Second) {
			return nil
		} else {
			s.logs.write("[dashboard] still alive after signal, force kill")
			killTreeForce(pid)
		}
		if !m.waitGone(s, 5*time.Second) {
			s.logs.write("[dashboard] force kill did not take effect")
		}
		return nil
	}

	// 外部进程（如 .local 脚本启动的服务）：按端口定位到的 PID 强制结束进程树。
	s.mu.Lock()
	xpid := s.externalPid
	xname := s.externalName
	s.mu.Unlock()
	if xpid == 0 {
		return nil
	}
	if s.name == "comfy" {
		s.logs.write("[dashboard] note: guardian auto-restart is paused for 15 min after manual stop")
		if m.guardian != nil {
			m.guardian.PauseManualStop()
		}
	}
	s.logs.write(fmt.Sprintf("[dashboard] stopping external %s (pid %d, port %d)", xname, xpid, servicePort(s.probeAddr)))
	killTreeForce(xpid)
	deadline := time.Now().Add(8 * time.Second)
	for time.Now().Before(deadline) {
		if !m.probe(s) {
			s.logs.write("[dashboard] external process stopped")
			return nil
		}
		time.Sleep(300 * time.Millisecond)
	}
	s.logs.write("[dashboard] external process still listening after kill")
	return nil
}

// waitGone 等待进程退出（awaitExit 落账 exited 标记）。
func (m *serviceManager) waitGone(s *service, d time.Duration) bool {
	deadline := time.Now().Add(d)
	for time.Now().Before(deadline) {
		if !s.managed() {
			return true
		}
		time.Sleep(150 * time.Millisecond)
	}
	return !s.managed()
}

// backendCommand 优先复用 .local/tools 里的预编译后端 exe（与 start-backend-detached.cmd
// 同一套环境变量）；exe 不存在时回退到 .local/tools/go 现场构建。
func (m *serviceManager) backendCommand() (*exec.Cmd, error) {
	if !fileExists(m.cfg.BackendExe) {
		if err := m.rebuildBackend(); err != nil {
			return nil, fmt.Errorf("backend exe missing and rebuild failed: %w", err)
		}
	}
	env := append(os.Environ(),
		"CANVAS_BACKEND_DATA_DIR="+m.cfg.DataDir,
		"CANVAS_OFFICIAL_PLUGIN_DIR="+m.cfg.PluginDir,
		"CANVAS_BACKEND_ADDR=:8080",
		"CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS=127.0.0.1",
		"BEEFTV_ALLOWED_ORIGINS=http://localhost:3000,http://127.0.0.1:3000",
	)
	cmd := exec.Command(m.cfg.BackendExe)
	cmd.Dir = m.cfg.RepoRoot
	cmd.Env = env
	return cmd, nil
}

func (m *serviceManager) proxyCommand() (*exec.Cmd, error) {
	node, err := exec.LookPath("node")
	if err != nil {
		return nil, errors.New("node not found on PATH; install Node.js first")
	}
	if !fileExists(m.cfg.ProxyScript) {
		return nil, fmt.Errorf("owner proxy script missing: %s", m.cfg.ProxyScript)
	}
	cmd := exec.Command(node, m.cfg.ProxyScript)
	cmd.Dir = m.cfg.RepoRoot
	cmd.Env = os.Environ()
	return cmd, nil
}

func (m *serviceManager) gatewayCommand() (*exec.Cmd, error) {
	bun, err := exec.LookPath("bun")
	if err != nil {
		return nil, errors.New("bun not found on PATH; install Bun first")
	}
	cmd := exec.Command(bun, "gateway.ts")
	cmd.Dir = m.cfg.GatewayDir
	cmd.Env = os.Environ()
	return cmd, nil
}

// startComfy 通过注册好的计划任务 ComfyUI-Start 拉起 ComfyUI；进程由任务计划程序
// 持有，看板只做健康等待。停止仍走端口定位的外部进程路径。
func (m *serviceManager) startComfy(s *service) error {
	s.logs.write("[dashboard] schtasks /Run /TN " + m.cfg.ComfyTask)
	cmd := exec.Command("schtasks", "/Run", "/TN", m.cfg.ComfyTask)
	if out, err := cmd.CombinedOutput(); err != nil {
		s.logs.write("[dashboard] schtasks failed: " + strings.TrimSpace(string(out)) + ": " + err.Error())
		return err
	}
	s.logs.write("[dashboard] ComfyUI starting via scheduled task (model loading can take 1-3 min)...")
	deadline := time.Now().Add(180 * time.Second)
	for time.Now().Before(deadline) {
		if m.probe(s) {
			s.logs.write("[dashboard] ComfyUI is healthy")
			return nil
		}
		time.Sleep(3 * time.Second)
	}
	s.logs.write("[dashboard] ComfyUI did not become healthy within 180s; check comfy-console.log")
	return nil
}

// tailComfyConsole 把 .local/comfy-console.log 的尾部增量喂进 comfy 日志缓冲：
// 启动时回放最后 64KB，之后每 2 秒轮询追加内容；日志被截断时自动从头跟。
// PowerShell 重定向产生的文件可能混编码（历史段 UTF-8、追加段 UTF-16 LE），
// 因此按读取块判定编码而不是对整个文件只判一次。
func (m *serviceManager) tailComfyConsole() {
	s := m.services["comfy"]
	var offset int64 = -1
	for {
		time.Sleep(2 * time.Second)
		f, err := os.Open(m.cfg.ComfyLogPath)
		if err != nil {
			if offset > 0 {
				offset = -1
			}
			continue
		}
		st, err := f.Stat()
		if err != nil {
			f.Close()
			continue
		}
		if offset < 0 {
			offset = st.Size() - 64*1024
			if offset < 0 {
				offset = 0
			} else {
				// 从半行位置起对齐到下一个换行。
				buf := make([]byte, 1)
				for offset < st.Size() {
					if _, err := f.ReadAt(buf, offset); err != nil || buf[0] == '\n' {
						break
					}
					offset++
				}
			}
		}
		if st.Size() < offset {
			offset = 0
		}
		if st.Size() > offset {
			buf := make([]byte, st.Size()-offset)
			n, _ := f.ReadAt(buf, offset)
			text, consumed := decodeConsoleChunk(buf[:n])
			offset += int64(consumed)
			for _, line := range splitLines(text) {
				s.logs.write(stripANSI(line))
			}
		}
		f.Close()
	}
}

// decodeConsoleChunk 解码一段日志内容：空字节密度高按 UTF-16 LE 处理，
// 并在两种字节对齐里选可打印 ASCII 占比高的一种（控制台日志以英文为主，
// 错位解码会整体变成生僻汉字，得分骤降）。consumed 是安全消费的字节数，
// UTF-16 段末尾残缺的半个码元留到下一轮。
func decodeConsoleChunk(buf []byte) (string, int) {
	nulls := 0
	for _, b := range buf {
		if b == 0 {
			nulls++
		}
	}
	if nulls*4 <= len(buf) {
		return string(buf), len(buf)
	}
	best := ""
	bestScore := -1.0
	bestConsumed := 0
	for shift := 0; shift < 2; shift++ {
		body := buf[shift:]
		n := len(body) &^ 1
		units := make([]uint16, n/2)
		for i := range units {
			units[i] = uint16(body[2*i]) | uint16(body[2*i+1])<<8
		}
		text := string(utf16x.Decode(units))
		if score := asciiPrintableScore(text); score > bestScore {
			best = text
			bestScore = score
			bestConsumed = shift + n
			if score > 0.95 {
				break
			}
		}
	}
	return best, bestConsumed
}

// asciiPrintableScore 返回可打印 ASCII（含换行制表）占总字符的比例。
func asciiPrintableScore(s string) float64 {
	if s == "" {
		return 0
	}
	ok := 0
	for _, r := range s {
		if (r >= 0x20 && r < 0x7F) || r == '\n' || r == '\r' || r == '\t' {
			ok++
		}
	}
	return float64(ok) / float64(len([]rune(s)))
}

func (m *serviceManager) frontendCommand() (*exec.Cmd, error) {
	bun, err := exec.LookPath("bun")
	if err != nil {
		return nil, errors.New("bun not found on PATH; install Bun first")
	}
	if !dirExists(filepath.Join(m.cfg.WebDir, "node_modules")) {
		s := m.services["frontend"]
		s.logs.write("[dashboard] web/node_modules missing, running bun install --frozen-lockfile ...")
		install := exec.Command(bun, "install", "--frozen-lockfile")
		install.Dir = m.cfg.WebDir
		install.Env = os.Environ()
		out, installErr := install.CombinedOutput()
		for _, line := range splitLines(string(out)) {
			s.logs.write("[bun install] " + line)
		}
		if installErr != nil {
			return nil, fmt.Errorf("bun install failed: %w", installErr)
		}
	}
	cmd := exec.Command(bun, "run", "dev")
	cmd.Dir = m.cfg.WebDir
	cmd.Env = append(os.Environ(), "VITE_API_PROXY_TARGET=http://127.0.0.1:8090")
	return cmd, nil
}

// rebuildBackend 用仓库内置的便携 Go 重新编译后端 exe，输出写进 backend 日志。
func (m *serviceManager) rebuildBackend() error {
	s := m.services["backend"]
	if !fileExists(m.cfg.GoBin) {
		return fmt.Errorf("portable go not found at %s", m.cfg.GoBin)
	}
	if s.managed() {
		return errors.New("stop backend before rebuilding")
	}
	buildDir := filepath.Join(m.cfg.RepoRoot, ".local", "cache", "go-build")
	_ = os.MkdirAll(buildDir, 0o755)
	s.logs.write("[build] go build -o .local/tools/infinite-canvas-backend.exe ./cmd/server")
	cmd := exec.Command(m.cfg.GoBin, "build", "-trimpath", "-o", m.cfg.BackendExe, "./cmd/server")
	cmd.Dir = filepath.Join(m.cfg.RepoRoot, "backend")
	cmd.Env = append(os.Environ(), "GOCACHE="+buildDir)
	out, err := cmd.CombinedOutput()
	for _, line := range splitLines(string(out)) {
		s.logs.write("[build] " + line)
	}
	if err != nil {
		s.logs.write("[build] failed: " + err.Error())
		return err
	}
	s.logs.write("[build] done")
	return nil
}

// Logs 返回某个服务 after 序号之后的日志行。
func (m *serviceManager) Logs(name string, after int64) ([]logLine, int64, bool) {
	s, ok := m.services[name]
	if !ok {
		return nil, 0, false
	}
	lines, next := s.logs.snapshot(after)
	return lines, next, true
}

// FrontendURL 从 vite 日志解析实际地址（3000 被占用时 vite 会顺延端口）。
func (m *serviceManager) FrontendURL() string {
	s := m.services["frontend"]
	lines, _ := s.logs.snapshot(0)
	re := regexp.MustCompile(`Local:\s*(https?://\S+)`)
	for i := len(lines) - 1; i >= 0; i-- {
		if match := re.FindStringSubmatch(lines[i].Text); match != nil {
			return strings.TrimSuffix(match[1], "/")
		}
	}
	return fmt.Sprintf("http://localhost:%d", m.cfg.FrontendPort)
}

func fileExists(path string) bool {
	info, err := os.Stat(path)
	return err == nil && !info.IsDir()
}

func splitLines(out string) []string {
	normalized := strings.ReplaceAll(out, "\r\n", "\n")
	normalized = strings.ReplaceAll(normalized, "\r", "\n")
	parts := strings.Split(normalized, "\n")
	lines := make([]string, 0, len(parts))
	for _, line := range parts {
		line = strings.TrimRight(line, " ")
		if line != "" {
			lines = append(lines, line)
		}
	}
	return lines
}

// scannerFeed 把管道按行喂进环形缓冲，同时带前缀打到看板自己的控制台。
func scannerFeed(s *service, pipe io.ReadCloser) {
	scanner := bufio.NewScanner(pipe)
	scanner.Buffer(make([]byte, 0, 64*1024), 512*1024)
	for scanner.Scan() {
		line := stripANSI(scanner.Text())
		if strings.TrimSpace(line) == "" {
			continue
		}
		s.logs.write(line)
		fmt.Printf("[%s] %s\n", s.name, line)
	}
}

var ansiRe = regexp.MustCompile(`\x1b\[[0-9;]*[a-zA-Z]`)

func stripANSI(s string) string { return ansiRe.ReplaceAllString(s, "") }
