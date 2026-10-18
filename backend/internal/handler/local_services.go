package handler

import (
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"infinite-canvas/backend/internal/sysproc"

	"github.com/gin-gonic/gin"
)

// 本地开发期服务（ComfyUI 与它的视频网关）不属于后端进程，默认由 start-dev-stack 拉起。
// 它们挂掉时页面只会看到"连接被拒绝"，所以这里提供最小的自启能力：
// 只允许拉起下面写死的几个服务，命令与目录来自环境变量，永不接受调用方传入命令。
const (
	localServiceGateway     = "comfy-gateway"
	localServiceComfyUI     = "comfyui"
	localServiceVideoStack  = "video-stack"
	localServiceLaunchLimit = 45 * time.Second
)

type localServiceSpec struct {
	name    string
	command string
	args    []string
	// entry 是相对 dir 的入口文件，只用于启动前确认目录没配错。
	entry string
	dir   string
	port  int
	hint  string
}

type localServiceStatus struct {
	Name    string `json:"name"`
	Running bool   `json:"running"`
	Started bool   `json:"started"`
	Port    int    `json:"port"`
	Message string `json:"message,omitempty"`
}

// LocalServiceLauncher 探测端口并拉起白名单内的本地服务。零值不可用，用 NewLocalServiceLauncher。
type LocalServiceLauncher struct {
	mu    sync.Mutex
	specs map[string]localServiceSpec
}

func NewLocalServiceLauncher() *LocalServiceLauncher {
	specs := map[string]localServiceSpec{}
	if spec, ok := comfyUISpec(); ok {
		specs[localServiceComfyUI] = spec
	}
	// 网关即使没配到目录也保留一条记录：状态接口据此告诉用户"目录不存在"，
	// 比静默 404 更容易排查。
	specs[localServiceGateway] = gatewaySpec()
	return &LocalServiceLauncher{specs: specs}
}

func gatewaySpec() localServiceSpec {
	spec := localServiceSpec{
		name:    localServiceGateway,
		command: firstNonEmpty(strings.TrimSpace(os.Getenv("CANVAS_BUN_BIN")), "bun"),
		args:    []string{"gateway.ts"},
		entry:   "gateway.ts",
		dir:     discoverGatewayDir(),
		port:    8765,
		hint:    "在 local/comfy-video-gateway 下运行 bun gateway.ts",
	}
	return spec
}

func comfyUISpec() (localServiceSpec, bool) {
	for _, dir := range comfyUICandidates() {
		python := filepath.Join(dir, "python_embeded", "python.exe")
		if _, err := os.Stat(python); err != nil {
			continue
		}
		return localServiceSpec{
			name:    localServiceComfyUI,
			command: python,
			args:    []string{"-s", filepath.ToSlash(filepath.Join("ComfyUI", "main.py")), "--windows-standalone-build"},
			entry:   filepath.Join("ComfyUI", "main.py"),
			dir:     dir,
			port:    8188,
			hint:    "设置 CANVAS_COMFYUI_DIR 后重启后端，或手动运行 ComfyUI",
		}, true
	}
	return localServiceSpec{}, false
}

// comfyUICandidates 按「显式配置 → 常见安装位置」排序，只保留真实存在的目录。
// 桌面版由安装器拉起后端时不会带环境变量，兜底目录保证开箱也能一键拉起。
func comfyUICandidates() []string {
	var dirs []string
	if v := strings.TrimSpace(os.Getenv("CANVAS_COMFYUI_DIR")); v != "" {
		dirs = append(dirs, v)
	}
	if home, err := os.UserHomeDir(); err == nil {
		dirs = append(dirs,
			filepath.Join(home, "ComfyUI-Portable"),
			filepath.Join(home, "ComfyUI_windows_portable"),
			filepath.Join(home, "ComfyUI"),
			filepath.Join(home, "Documents", "ComfyUI"),
		)
	}
	dirs = append(dirs, `C:\AI\ComfyUI-Portable`, `D:\AI\ComfyUI-Portable`)
	return dirs
}

// discoverGatewayDir 从当前目录与可执行文件目录逐级向上找仓库内的网关目录。
func discoverGatewayDir() string {
	if v := strings.TrimSpace(os.Getenv("CANVAS_COMFY_GATEWAY_DIR")); v != "" {
		return v
	}
	var roots []string
	if wd, err := os.Getwd(); err == nil {
		roots = append(roots, wd)
	}
	if exe, err := os.Executable(); err == nil {
		roots = append(roots, filepath.Dir(exe))
	}
	for _, root := range roots {
		dir := root
		for depth := 0; depth < 6; depth++ {
			candidate := filepath.Join(dir, "local", "comfy-video-gateway")
			if _, err := os.Stat(filepath.Join(candidate, "gateway.ts")); err == nil {
				return candidate
			}
			parent := filepath.Dir(dir)
			if parent == dir {
				break
			}
			dir = parent
		}
	}
	return ""
}

func portOpen(port int, timeout time.Duration) bool {
	if port <= 0 {
		return false
	}
	conn, err := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", port), timeout)
	if err != nil {
		return false
	}
	_ = conn.Close()
	return true
}

// waitPort 在超时内轮询端口。ComfyUI 冷启动要加载依赖，比网关慢得多。
func waitPort(port int, limit time.Duration) bool {
	deadline := time.Now().Add(limit)
	for time.Now().Before(deadline) {
		if portOpen(port, 400*time.Millisecond) {
			return true
		}
		time.Sleep(500 * time.Millisecond)
	}
	return false
}

func (l *LocalServiceLauncher) status(name string) (localServiceStatus, bool) {
	spec, ok := l.specs[name]
	if !ok {
		return localServiceStatus{Name: name}, false
	}
	return localServiceStatus{Name: name, Running: portOpen(spec.port, 600*time.Millisecond), Port: spec.port}, true
}

// start 拉起单个服务；已在运行则直接返回 running=true。
func (l *LocalServiceLauncher) start(name string) (localServiceStatus, error) {
	spec, ok := l.specs[name]
	if !ok {
		return localServiceStatus{Name: name}, fmt.Errorf("未知的本地服务：%s", name)
	}
	status := localServiceStatus{Name: name, Port: spec.port}
	if portOpen(spec.port, 600*time.Millisecond) {
		status.Running = true
		status.Message = "服务已在运行"
		return status, nil
	}
	if spec.dir == "" {
		status.Message = "未找到服务目录"
		return status, fmt.Errorf("没有找到 %s 的目录（%s）", name, spec.hint)
	}
	if _, err := os.Stat(filepath.Join(spec.dir, spec.entry)); err != nil {
		status.Message = "缺少入口文件"
		return status, fmt.Errorf("%s 缺少入口文件 %s（%s）", name, spec.args[0], spec.hint)
	}

	l.mu.Lock()
	defer l.mu.Unlock()

	// 双检：拿锁期间可能已被别的请求拉起
	if portOpen(spec.port, 400*time.Millisecond) {
		status.Running = true
		return status, nil
	}

	cmd := exec.Command(spec.command, spec.args...)
	cmd.Dir = spec.dir
	cmd.Env = os.Environ()
	// 系统代理会让网关把 127.0.0.1 的请求也绕出去，必须让子进程直连。
	cmd.Env = append(cmd.Env, "NO_PROXY=127.0.0.1,localhost", "no_proxy=127.0.0.1,localhost")
	sysproc.HideConsole(cmd)
	if logFile, err := os.OpenFile(filepath.Join(os.TempDir(), "beefTv-"+name+".log"), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600); err == nil {
		cmd.Stdout = logFile
		cmd.Stderr = logFile
		defer logFile.Close()
	} else {
		cmd.Stdout = io.Discard
		cmd.Stderr = io.Discard
	}
	if err := cmd.Start(); err != nil {
		status.Message = "启动失败"
		return status, fmt.Errorf("启动 %s 失败：%w", name, err)
	}
	// 有意不 Wait：子进程要脱离本进程独立存活，后端重启后仍可用。
	_ = cmd.Process.Release()

	if waitPort(spec.port, localServiceLaunchLimit) {
		status.Running = true
		status.Started = true
		status.Message = "已启动"
		return status, nil
	}
	status.Message = "启动超时"
	return status, errors.New("服务已拉起但端口未就绪，请查看 " + filepath.Join(os.TempDir(), "beefTv-"+name+".log"))
}

// startStack 按顺序拉起 video-stack 的成员；已经运行的服务跳过。
func (l *LocalServiceLauncher) startStack(name string) ([]localServiceStatus, error) {
	order := []string{localServiceComfyUI, localServiceGateway}
	if name == localServiceGateway {
		order = []string{localServiceGateway}
	}
	var out []localServiceStatus
	for _, item := range order {
		if _, ok := l.specs[item]; !ok {
			continue
		}
		status, err := l.start(item)
		out = append(out, status)
		if err != nil {
			return out, err
		}
	}
	return out, nil
}

// RegisterLocalServiceRoutes 暴露本地服务状态与自启接口。只接受本机同源请求：
// 该接口能拉起本机进程，不能对局域网开放。
func RegisterLocalServiceRoutes(api *gin.RouterGroup, launcher *LocalServiceLauncher) {
	if launcher == nil {
		return
	}
	api.GET("/local-services/:name", func(c *gin.Context) {
		if !isLoopbackRequest(c.Request) {
			c.JSON(http.StatusForbidden, gin.H{"code": http.StatusForbidden, "msg": "仅本机可用", "reason": "local_only"})
			return
		}
		name := c.Param("name")
		if name == localServiceVideoStack {
			// 视频链路要 ComfyUI 与网关同时在线；任何一个缺了都算没就绪。
			steps := make([]localServiceStatus, 0, 2)
			running := true
			for _, member := range []string{localServiceComfyUI, localServiceGateway} {
				if _, ok := launcher.specs[member]; !ok {
					continue
				}
				status, _ := launcher.status(member)
				steps = append(steps, status)
				running = running && status.Running
			}
			c.JSON(http.StatusOK, gin.H{"code": 0, "data": gin.H{"name": name, "running": running, "steps": steps}, "msg": "ok"})
			return
		}
		status, ok := launcher.status(name)
		if !ok {
			c.JSON(http.StatusNotFound, gin.H{"code": http.StatusNotFound, "msg": "未知的本地服务", "reason": "not_found"})
			return
		}
		c.JSON(http.StatusOK, gin.H{"code": 0, "data": status, "msg": "ok"})
	})
	api.POST("/local-services/:name/start", func(c *gin.Context) {
		if !isLoopbackRequest(c.Request) {
			c.JSON(http.StatusForbidden, gin.H{"code": http.StatusForbidden, "msg": "仅本机可用", "reason": "local_only"})
			return
		}
		name := c.Param("name")
		if name != localServiceVideoStack && name != localServiceGateway && name != localServiceComfyUI {
			c.JSON(http.StatusNotFound, gin.H{"code": http.StatusNotFound, "msg": "未知的本地服务", "reason": "not_found"})
			return
		}
		statuses, err := launcher.startStack(name)
		running := len(statuses) > 0
		for _, status := range statuses {
			if !status.Running {
				running = false
			}
		}
		payload := gin.H{"name": name, "running": running, "steps": statuses}
		if err != nil {
			payload["message"] = err.Error()
			c.JSON(http.StatusBadGateway, gin.H{"code": http.StatusBadGateway, "data": payload, "msg": err.Error(), "reason": "start_failed"})
			return
		}
		c.JSON(http.StatusOK, gin.H{"code": 0, "data": payload, "msg": "ok"})
	})
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}
