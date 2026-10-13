package main

import (
	"context"
	"crypto/rand"
	_ "embed"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"infinite-canvas/backend/internal/systemstats"
)

//go:embed index.html
var indexHTML []byte

func randomToken() string {
	buf := make([]byte, 24)
	if _, err := rand.Read(buf); err != nil {
		return strconv.FormatInt(time.Now().UnixNano(), 16)
	}
	return hex.EncodeToString(buf)
}

type dashboardServer struct {
	cfg       config
	token     string
	mgr       *serviceManager
	collector *systemstats.Collector
	ownerToken string

	comfyMu   sync.Mutex
	comfyAt   time.Time
	comfyData map[string]any

	tasksMu   sync.Mutex
	tasksAt   time.Time
	tasksData map[string]any
}

func newServer(cfg config, token string, mgr *serviceManager, collector *systemstats.Collector) *dashboardServer {
	ownerToken := ""
	if data, err := os.ReadFile(filepath.Join(cfg.DataDir, "agent_owner_token")); err == nil {
		ownerToken = strings.TrimSpace(string(data))
	}
	return &dashboardServer{cfg: cfg, token: token, mgr: mgr, collector: collector, ownerToken: ownerToken}
}

// Handler 组装路由。所有 /api 除 hello 外都要求随机 token；
// Host 校验防 DNS rebinding，整个服务只绑定 127.0.0.1。
func (s *dashboardServer) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /{$}", s.handleIndex)
	mux.HandleFunc("GET /api/hello", s.handleHello)
	mux.HandleFunc("GET /api/state", s.guard(s.handleState))
	mux.HandleFunc("GET /api/hw", s.guard(s.handleHardware))
	mux.HandleFunc("GET /api/comfy", s.guard(s.handleComfy))
	mux.HandleFunc("GET /api/tasks", s.guard(s.handleTasks))
	mux.HandleFunc("GET /api/gpu-procs", s.guard(s.handleGpuProcs))
	mux.HandleFunc("POST /api/guardian", s.guard(s.handleGuardian))
	mux.HandleFunc("GET /api/logs", s.guard(s.handleLogs))
	mux.HandleFunc("POST /api/start", s.guard(s.handleStart))
	mux.HandleFunc("POST /api/stop", s.guard(s.handleStop))
	mux.HandleFunc("POST /api/open", s.guard(s.handleOpen))
	mux.HandleFunc("POST /api/rebuild-backend", s.guard(s.handleRebuild))
	mux.HandleFunc("POST /api/shutdown", s.guard(s.handleShutdown))
	return mux
}

func (s *dashboardServer) guard(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		host := r.Host
		if i := strings.LastIndex(host, ":"); i >= 0 && !strings.Contains(host[i:], "]") {
			host = host[:i]
		}
		if host != "127.0.0.1" && host != "localhost" {
			http.Error(w, "forbidden host", http.StatusForbidden)
			return
		}
		if r.Header.Get("X-Dashboard-Token") != s.token {
			http.Error(w, "forbidden token", http.StatusForbidden)
			return
		}
		next(w, r)
	}
}

func (s *dashboardServer) handleIndex(w http.ResponseWriter, r *http.Request) {
	html := strings.Replace(string(indexHTML), "__TOKEN__", s.token, 1)
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	_, _ = w.Write([]byte(html))
}

func (s *dashboardServer) handleHello(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"app": helloAppID, "version": dashboardVersion})
}

func (s *dashboardServer) handleState(w http.ResponseWriter, r *http.Request) {
	state := s.mgr.Snapshot()
	state["frontendUrl"] = s.mgr.FrontendURL()
	// 模板参数控制台内嵌在视频网关进程里（/admin），看板页面据此决定 iframe 还是降级提示。
	state["gatewayAdminUrl"] = fmt.Sprintf("http://127.0.0.1:%d/admin", s.cfg.GatewayPort)
	if s.mgr.guardian != nil {
		state["guardian"] = s.mgr.guardian.State()
	}
	writeJSON(w, http.StatusOK, state)
}

func (s *dashboardServer) handleHardware(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, s.collector.Snapshot(r.Context()))
}

// handleComfy 聚合 ComfyUI 的 system_stats 与 queue 接口，缓存 1.5s 合并多页轮询。
func (s *dashboardServer) handleComfy(w http.ResponseWriter, r *http.Request) {
	s.comfyMu.Lock()
	defer s.comfyMu.Unlock()
	if s.comfyData != nil && time.Since(s.comfyAt) < 1500*time.Millisecond {
		writeJSON(w, http.StatusOK, s.comfyData)
		return
	}
	s.comfyData = fetchComfySnapshot(r.Context(), s.cfg.ComfyURL, s.cfg.GatewayPort)
	s.comfyAt = time.Now()
	writeJSON(w, http.StatusOK, s.comfyData)
}

func fetchComfySnapshot(ctx context.Context, comfyURL string, gatewayPort int) map[string]any {
	out := map[string]any{"up": false, "url": comfyURL}
	if stats, ok := getJSON(ctx, comfyURL+"/system_stats", 3*time.Second); ok {
		out["up"] = true
		if system, ok := stats["system"].(map[string]any); ok {
			if v, ok := system["comfyui_version"].(string); ok {
				out["version"] = v
			}
			out["ramFree"], _ = system["ram_free"].(float64)
			out["ramTotal"], _ = system["ram_total"].(float64)
		}
		if devices, ok := stats["devices"].([]any); ok && len(devices) > 0 {
			if dev, ok := devices[0].(map[string]any); ok {
				if v, ok := dev["name"].(string); ok {
					out["deviceName"] = v
				}
				out["vramTotal"], _ = dev["vram_total"].(float64)
				out["vramFree"], _ = dev["vram_free"].(float64)
			}
		}
	}
	if queue, ok := getJSON(ctx, comfyURL+"/queue", 3*time.Second); ok {
		running, _ := queue["queue_running"].([]any)
		pending, _ := queue["queue_pending"].([]any)
		out["queueRunning"] = len(running)
		out["queuePending"] = len(pending)
	} else {
		out["queueRunning"] = nil
		out["queuePending"] = nil
	}
	out["gatewayPort"] = gatewayPort
	return out
}

func getJSON(ctx context.Context, url string, timeout time.Duration) (map[string]any, bool) {	reqCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	req, err := http.NewRequestWithContext(reqCtx, http.MethodGet, url, nil)
	if err != nil {
		return nil, false
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, false
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, false
	}
	var payload map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		return nil, false
	}
	return payload, true
}

func (s *dashboardServer) handleLogs(w http.ResponseWriter, r *http.Request) {
	name := r.URL.Query().Get("name")
	after, _ := strconv.ParseInt(r.URL.Query().Get("after"), 10, 64)
	lines, next, ok := s.mgr.Logs(name, after)
	if !ok {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "unknown service " + name})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"lines": lines, "next": next})
}

func (s *dashboardServer) handleStart(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Name string `json:"name"`
	}
	if !readJSONBody(w, r, &body) {
		return
	}
	if body.Name == "all" {
		go s.mgr.StartAll(context.Background())
		writeJSON(w, http.StatusAccepted, map[string]string{"status": "starting all"})
		return
	}
	if _, ok := s.mgr.get(body.Name); !ok {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "unknown service " + body.Name})
		return
	}
	name := body.Name
	go func() { _ = s.mgr.Start(name) }()
	writeJSON(w, http.StatusAccepted, map[string]string{"status": "starting " + name})
}

func (s *dashboardServer) handleStop(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Name string `json:"name"`
	}
	if !readJSONBody(w, r, &body) {
		return
	}
	name := body.Name
	if name == "all" {
		go s.mgr.StopEverything()
		writeJSON(w, http.StatusAccepted, map[string]string{"status": "stopping all (including external)"})
		return
	}
	if _, ok := s.mgr.get(name); !ok {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "unknown service " + name})
		return
	}
	go func() { _ = s.mgr.Stop(name) }()
	writeJSON(w, http.StatusAccepted, map[string]string{"status": "stopping " + name})
}

func (s *dashboardServer) handleOpen(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Name string `json:"name"`
	}
	if !readJSONBody(w, r, &body) {
		return
	}
	var url string
	switch body.Name {
	case "frontend":
		url = s.mgr.FrontendURL()
	case "backend":
		url = s.cfg.BackendURL
	case "dashboard":
		url = "http://127.0.0.1:8899"
	case "comfy":
		url = s.cfg.ComfyURL
	case "datadir":
		go openExplorer(s.cfg.DataDir)
		writeJSON(w, http.StatusOK, map[string]string{"path": s.cfg.DataDir})
		return
	case "localdir":
		go openExplorer(filepath.Join(s.cfg.RepoRoot, ".local"))
		writeJSON(w, http.StatusOK, map[string]string{"path": filepath.Join(s.cfg.RepoRoot, ".local")})
		return
	default:
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "unknown target " + body.Name})
		return
	}
	go openBrowser(url)
	writeJSON(w, http.StatusOK, map[string]string{"url": url})
}

func (s *dashboardServer) handleRebuild(w http.ResponseWriter, r *http.Request) {
	err := s.mgr.rebuildBackend()
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "built"})
}

func (s *dashboardServer) handleShutdown(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "shutting down"})
	go func() {
		time.Sleep(300 * time.Millisecond)
		s.mgr.StopAll()
		os.Exit(0)
	}()
}

// handleTasks 聚合后端最近生成任务（owner 凭据直连 /api/tasks），缓存 2s。
// 供看板任务流视图展示：排队/运行/失败一目了然，挂机时不必开工作台也能盯进度。
func (s *dashboardServer) handleTasks(w http.ResponseWriter, r *http.Request) {
	s.tasksMu.Lock()
	defer s.tasksMu.Unlock()
	if s.tasksData != nil && time.Since(s.tasksAt) < 2*time.Second {
		writeJSON(w, http.StatusOK, s.tasksData)
		return
	}
	s.tasksData = s.fetchTasks(r.Context())
	s.tasksAt = time.Now()
	writeJSON(w, http.StatusOK, s.tasksData)
}

func (s *dashboardServer) fetchTasks(ctx context.Context) map[string]any {
	if s.ownerToken == "" {
		return map[string]any{"available": false, "reason": "owner token 缺失（后端未初始化数据目录）", "tasks": []any{}}
	}
	reqCtx, cancel := context.WithTimeout(ctx, 4*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(reqCtx, http.MethodGet,
		s.cfg.BackendURL+"/api/tasks?pageSize=15", nil)
	if err != nil {
		return map[string]any{"available": false, "reason": err.Error(), "tasks": []any{}}
	}
	req.Header.Set("X-Beeftv-Owner", s.ownerToken)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return map[string]any{"available": false, "reason": "后端未运行", "tasks": []any{}}
	}
	defer resp.Body.Close()
	var envelope struct {
		Code int             `json:"code"`
		Msg  string          `json:"msg"`
		Data json.RawMessage `json:"data"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&envelope); err != nil || envelope.Code != 0 {
		return map[string]any{"available": false, "reason": "后端返回错误", "tasks": []any{}}
	}
	var rows []map[string]any
	if err := json.Unmarshal(envelope.Data, &rows); err != nil {
		rows = nil
	}
	tasks := make([]map[string]any, 0, len(rows))
	for _, row := range rows {
		tasks = append(tasks, map[string]any{
			"id":        row["id"],
			"type":      row["type"],
			"status":    row["status"],
			"progress":  row["progress"],
			"stage":     row["stage"],
			"prompt":    truncateRunes(asString(row["prompt"]), 90),
			"model":     row["model"],
			"provider":  row["provider"],
			"errorCode": row["errorCode"],
			"error":     truncateRunes(asString(row["error"]), 140),
			"attempts":  row["attempts"],
			"createdAt": row["createdAt"],
			"updatedAt": row["updatedAt"],
		})
	}
	return map[string]any{"available": true, "tasks": tasks}
}

func asString(v any) string {
	s, _ := v.(string)
	return s
}

func truncateRunes(s string, limit int) string {
	runes := []rune(s)
	if len(runes) <= limit {
		return s
	}
	return string(runes[:limit]) + "…"
}

// handleGpuProcs 列出占用 GPU 显存的进程（nvidia-smi compute apps），回答
// “显存被谁吃了”——ComfyUI 常驻与浏览器/其他任务混跑时尤其有用。
func (s *dashboardServer) handleGpuProcs(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "nvidia-smi",
		"--query-compute-apps=pid,process_name,used_memory",
		"--format=csv,noheader,nounits").Output()
	procs := []map[string]any{}
	if err == nil {
		for _, line := range strings.Split(strings.ReplaceAll(string(out), "\r\n", "\n"), "\n") {
			fields := strings.Split(line, ",")
			if len(fields) != 3 {
				continue
			}
			pid, _ := strconv.Atoi(strings.TrimSpace(fields[0]))
			mem, _ := strconv.ParseFloat(strings.TrimSpace(fields[2]), 64)
			procs = append(procs, map[string]any{
				"pid":    pid,
				"name":   filepath.Base(strings.TrimSpace(fields[1])),
				"memMiB": mem,
			})
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"procs": procs})
}

func (s *dashboardServer) handleGuardian(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Enabled bool `json:"enabled"`
	}
	if !readJSONBody(w, r, &body) {
		return
	}
	if s.mgr.guardian != nil {
		s.mgr.guardian.SetEnabled(body.Enabled)
		writeJSON(w, http.StatusOK, s.mgr.guardian.State())
		return
	}
	writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "guardian unavailable"})
}

func readJSONBody(w http.ResponseWriter, r *http.Request, target any) bool {
	defer r.Body.Close()
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8192))
	if err := dec.Decode(target); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid json body"})
		return false
	}
	return true
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}
