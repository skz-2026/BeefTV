package main

// 过夜守护：看板进程内轮询 ComfyUI 健康，确认崩溃后归档控制台日志并通过
// ComfyUI-Start 计划任务重新拉起。取代已删除的 comfy-watchdog/patrol 计划任务，
// 全程不创建窗口。比旧看门狗更保守：6 秒超时 + 连续两次（间隔 30 秒）探测失败
// 才重启，避免模型加载导致的短暂无响应被误判；用户手动停止 ComfyUI 后暂停守护。
// 开关持久化在 .local/dashboard-settings.json，默认关闭。

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"time"
)

const guardianInterval = 30 * time.Second

// manualStopPause 用户手动停止 ComfyUI 后守护暂停的时长：期间不自动拉起。
const manualStopPause = 15 * time.Minute

type guardian struct {
	mgr *serviceManager

	mu         sync.Mutex
	enabled    bool
	restart    int
	lastNote   string
	pauseUntil time.Time
	stopCh     chan struct{}
}

type dashboardSettings struct {
	GuardianEnabled bool `json:"guardianEnabled"`
}

func settingsPath(repo string) string {
	return filepath.Join(repo, ".local", "dashboard-settings.json")
}

func newGuardian(mgr *serviceManager) *guardian {
	g := &guardian{mgr: mgr, stopCh: make(chan struct{})}
	if g.loadSettings().GuardianEnabled {
		g.setEnabled(true)
	}
	return g
}

func (g *guardian) loadSettings() dashboardSettings {
	var s dashboardSettings
	if data, err := os.ReadFile(settingsPath(g.mgr.cfg.RepoRoot)); err == nil {
		_ = json.Unmarshal(data, &s)
	}
	return s
}

func (g *guardian) saveSettings() {
	g.mu.Lock()
	enabled := g.enabled
	g.mu.Unlock()
	data, _ := json.MarshalIndent(dashboardSettings{GuardianEnabled: enabled}, "", "  ")
	_ = os.WriteFile(settingsPath(g.mgr.cfg.RepoRoot), data, 0o644)
}

// SetEnabled 切换守护并持久化；开启时立即启动轮询协程。
func (g *guardian) SetEnabled(on bool) {
	g.setEnabled(on)
	g.saveSettings()
}

func (g *guardian) setEnabled(on bool) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.enabled == on {
		return
	}
	g.enabled = on
	if on {
		go g.run()
		s, _ := g.mgr.get("comfy")
		s.logs.write("[guardian] 过夜守护已开启：每 30s 探测 ComfyUI，连续两次失败自动拉起")
	}
}

func (g *guardian) Enabled() bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.enabled
}

func (g *guardian) State() map[string]any {
	g.mu.Lock()
	defer g.mu.Unlock()
	return map[string]any{
		"enabled":  g.enabled,
		"restarts": g.restart,
		"lastNote": g.lastNote,
	}
}

// PauseManualStop 在用户手动停止 ComfyUI 后调用，暂停守护一段时间。
func (g *guardian) PauseManualStop() {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.enabled {
		g.pauseUntil = time.Now().Add(manualStopPause)
		g.lastNote = time.Now().Format("15:04:05") + " 手动停止，守护暂停 15 分钟"
	}
}

func (g *guardian) paused() bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	return time.Now().Before(g.pauseUntil)
}

func (g *guardian) run() {
	ticker := time.NewTicker(guardianInterval)
	defer ticker.Stop()
	misses := 0
	for {
		select {
		case <-g.stopCh:
			return
		case <-ticker.C:
		}
		if !g.Enabled() {
			return
		}
		if g.paused() {
			misses = 0
			continue
		}
		if g.probeComfy() {
			misses = 0
			continue
		}
		misses++
		if misses < 2 {
			continue
		}
		misses = 0
		g.restartComfy()
	}
}

// probeComfy 用宽松超时（6s）探测 ComfyUI；模型加载期间的短暂卡顿不算死亡。
func (g *guardian) probeComfy() bool {
	client := &http.Client{Timeout: 6 * time.Second}
	resp, err := client.Get(g.mgr.cfg.ComfyURL + "/system_stats")
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	return resp.StatusCode < 500
}

func (g *guardian) restartComfy() {
	s, _ := g.mgr.get("comfy")
	ts := time.Now().Format("20060102-150405")
	dst := filepath.Join(filepath.Dir(g.mgr.cfg.ComfyLogPath), fmt.Sprintf("comfy-crash-%s.log", ts))
	if data, err := os.ReadFile(g.mgr.cfg.ComfyLogPath); err == nil {
		_ = os.WriteFile(dst, data, 0o644)
		s.logs.write("[guardian] ComfyUI 崩溃，现场已归档 " + filepath.Base(dst))
	}
	s.logs.write("[guardian] 触发 " + g.mgr.cfg.ComfyTask + " 重新拉起 ComfyUI")
	_ = exec.Command("schtasks", "/Run", "/TN", g.mgr.cfg.ComfyTask).Run()
	g.mu.Lock()
	g.restart++
	g.lastNote = time.Now().Format("15:04:05") + " 自动重启 ComfyUI"
	g.mu.Unlock()
	// 等待模型加载，避免下一轮立刻再次判定死亡。
	time.Sleep(90 * time.Second)
}
