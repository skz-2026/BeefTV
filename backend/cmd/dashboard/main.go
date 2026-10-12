// 控制看板：启动/停止 BeefTV 本机前后端（后端 exe、owner 代理、Vite 前端），
// 并展示本机硬件遥测（CPU/内存/GPU/温度/磁盘）。只监听 127.0.0.1，
// 页面与 API 内嵌在本 exe 中，无需浏览器扩展或前端构建。
//
// 用法：双击 .local/tools/beeftv-dashboard.exe，或命令行运行后访问打印出的地址。
// 环境变量 BEEFTV_DASHBOARD_REPO 可显式指定仓库根目录；-no-open 禁止自动打开浏览器。
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"infinite-canvas/backend/internal/systemstats"
)

const dashboardVersion = "1.0.0"

// helloAppID 用于识别本机上已在运行的看板实例，避免双开。
const helloAppID = "beeftv-dashboard"

type config struct {
	RepoRoot     string
	DataDir      string
	BackendExe   string
	GoBin        string
	PluginDir    string
	ProxyScript  string
	WebDir       string
	GatewayDir   string
	GatewayPort  int
	ComfyURL     string
	ComfyAddr    string
	ComfyTask    string
	ComfyLogPath string
	BackendURL   string
	ProxyPort    int
	FrontendPort int
	NoOpen       bool
}

func main() {
	log.SetFlags(log.Ltime)
	initConsole()
	noOpen := flag.Bool("no-open", os.Getenv("BEEFTV_DASHBOARD_NO_OPEN") == "1", "do not open the browser automatically")
	flag.Parse()

	repo, err := detectRepoRoot()
	if err != nil {
		log.Fatalf("cannot locate BeefTV repo root: %v (set BEEFTV_DASHBOARD_REPO)", err)
	}
	cfg := buildConfig(repo, *noOpen)

	// 已有实例在运行时直接打开它，避免两个看板争抢同一批服务。
	if existing, ok := findExistingInstance(); ok {
		log.Printf("dashboard already running at %s, opening it", existing)
		openBrowser(existing)
		return
	}

	addr, ln, err := listenLocal()
	if err != nil {
		log.Fatalf("no free local port in 8899..8919: %v", err)
	}
	token := randomToken()

	if err := setupJobObject(); err != nil {
		log.Printf("job object unavailable (%v); closing the console still stops services on graceful exit only", err)
	}

	mgr := newServiceManager(cfg)
	server := newServer(cfg, token, mgr, systemstats.NewCollector())

	fmt.Printf("BeefTV dashboard v%s\n", dashboardVersion)
	fmt.Printf("  repo:     %s\n", cfg.RepoRoot)
	fmt.Printf("  url:      http://%s\n", addr)
	fmt.Printf("  services: backend :8080, owner-proxy :%d, vite :%d, gateway :%d, comfy 8188\n",
		cfg.ProxyPort, cfg.FrontendPort, cfg.GatewayPort)
	fmt.Printf("  closing this window stops dashboard-started services only\n")

	if !cfg.NoOpen {
		go func() {
			time.Sleep(300 * time.Millisecond)
			openBrowser(fmt.Sprintf("http://%s", addr))
		}()
	}

	ctx, stop := signalContext()
	defer stop()
	httpSrv := &http.Server{Handler: server.Handler()}
	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
		defer cancel()
		_ = httpSrv.Shutdown(shutdownCtx)
	}()
	if err := httpSrv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Printf("http server: %v", err)
	}
	mgr.StopAll()
	fmt.Println("dashboard stopped")
}

func buildConfig(repo string, noOpen bool) config {
	return config{
		RepoRoot:     repo,
		DataDir:      filepath.Join(repo, ".local", "project-workbench-debug"),
		BackendExe:   filepath.Join(repo, ".local", "tools", "infinite-canvas-backend.exe"),
		GoBin:        filepath.Join(repo, ".local", "tools", "go", "bin", "go.exe"),
		PluginDir:    filepath.Join(repo, "plugin-packages"),
		ProxyScript:  filepath.Join(repo, "local", "dev-owner-proxy", "proxy.ts"),
		WebDir:       filepath.Join(repo, "web"),
		GatewayDir:   filepath.Join(repo, "local", "comfy-video-gateway"),
		GatewayPort:  gatewayPort(repo),
		ComfyURL:     "http://127.0.0.1:8188",
		ComfyAddr:    "127.0.0.1:8188",
		ComfyTask:    "ComfyUI-Start",
		ComfyLogPath: filepath.Join(repo, ".local", "comfy-console.log"),
		BackendURL:   "http://127.0.0.1:8080",
		ProxyPort:    8090,
		FrontendPort: 3000,
		NoOpen:       noOpen,
	}
}

// gatewayPort 优先读网关 config.json 的端口，读不到用默认 8765。
func gatewayPort(repo string) int {
	data, err := os.ReadFile(filepath.Join(repo, "local", "comfy-video-gateway", "config.json"))
	if err != nil {
		return 8765
	}
	var parsed struct {
		Port int `json:"port"`
	}
	if json.Unmarshal(data, &parsed) == nil && parsed.Port > 0 {
		return parsed.Port
	}
	return 8765
}

// detectRepoRoot 依次从环境变量、当前目录、可执行文件所在目录向上查找
// 含 VERSION 与 backend/go.mod 的目录作为仓库根。
func detectRepoRoot() (string, error) {
	if env := os.Getenv("BEEFTV_DASHBOARD_REPO"); env != "" {
		if isRepoRoot(env) {
			return env, nil
		}
		return "", fmt.Errorf("BEEFTV_DASHBOARD_REPO=%s is not a repo root", env)
	}
	for _, start := range []string{cwd(), exeDir()} {
		if start == "" {
			continue
		}
		if root, ok := findRootUp(start); ok {
			return root, nil
		}
	}
	return "", errors.New("VERSION + backend/go.mod not found upward from cwd or exe dir")
}

func findRootUp(start string) (string, bool) {
	dir := start
	for i := 0; i < 8; i++ {
		if isRepoRoot(dir) {
			return dir, true
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return "", false
		}
		dir = parent
	}
	return "", false
}

func isRepoRoot(dir string) bool {
	info, err := os.Stat(filepath.Join(dir, "VERSION"))
	return err == nil && !info.IsDir() && dirExists(filepath.Join(dir, "backend"))
}

func dirExists(dir string) bool {
	info, err := os.Stat(dir)
	return err == nil && info.IsDir()
}

func cwd() string {
	dir, err := os.Getwd()
	if err != nil {
		return ""
	}
	return dir
}

func exeDir() string {
	exe, err := os.Executable()
	if err != nil {
		return ""
	}
	return filepath.Dir(exe)
}

// listenLocal 在 127.0.0.1:8899 起依次尝试第一个空闲端口。
func listenLocal() (string, net.Listener, error) {
	for port := 8899; port <= 8919; port++ {
		addr := fmt.Sprintf("127.0.0.1:%d", port)
		ln, err := net.Listen("tcp", addr)
		if err == nil {
			return addr, ln, nil
		}
	}
	return "", nil, errors.New("all candidate ports are busy")
}

// findExistingInstance 探测默认端口上是否有本看板的实例。
func findExistingInstance() (string, bool) {
	client := &http.Client{Timeout: 600 * time.Millisecond}
	resp, err := client.Get("http://127.0.0.1:8899/api/hello")
	if err != nil {
		return "", false
	}
	defer resp.Body.Close()
	buf := make([]byte, 256)
	n, _ := resp.Body.Read(buf)
	return "http://127.0.0.1:8899", strings.Contains(string(buf[:n]), helloAppID)
}

// signalContext 在 Ctrl+C 或 SIGTERM 时触发整树停止。
func signalContext() (context.Context, context.CancelFunc) {
	return signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
}
