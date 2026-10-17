package motion

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"infinite-canvas/backend/internal/sysproc"
)

// RenderResult 是一次模板渲染的产物描述。
type RenderResult struct {
	Path       string
	Size       int64
	DurationMs int64
	Width      int
	Height     int
	Frames     int
}

// Runner 在模板解包目录内驱动官方 adapter 完成本地渲染。
// FFmpegBin 是后端解析出的 ffmpeg 可执行文件绝对路径，其所在目录会被
// 前置到子进程 PATH（render.mjs 与 mix.py 直接按名调用 ffmpeg/ffprobe）。
// Entry 是模板声明的 runtime 入口（缺省 adapter.py）。
// RuntimeDir 是模板 Node 依赖的安装目录：导入的模板目录保持纯净（内容
// 摘要才能校验），render.mjs 的 require 通过 NODE_PATH 找到这里的 node_modules。
type Runner struct {
	TemplateDir string
	Entry       string
	FFmpegBin   string
	RuntimeDir  string
}

type motionPlan struct {
	DurationS float64 `json:"duration_s"`
	Frames    int     `json:"frames"`
	Width     int     `json:"width"`
	Height    int     `json:"height"`
}

// Run 依次执行 plan → prepare → render，返回最终成片（模板混音后文件名
// 以 -with-audio.mp4 结尾）。progress 在各阶段被回调。
func (r *Runner) Run(ctx context.Context, params []byte, workDir string, progress func(stage string, percent int) error) (*RenderResult, error) {
	if !isJSONObject(params) {
		return nil, errors.New("模板参数必须是 JSON 对象")
	}
	if err := os.MkdirAll(workDir, 0o755); err != nil {
		return nil, err
	}
	env, err := r.childEnv()
	if err != nil {
		return nil, err
	}
	if err := r.ensureNodeRuntime(ctx, env, progress); err != nil {
		return nil, err
	}
	env = append(env, "NODE_PATH="+filepath.Join(r.nodeRuntimeDir(), "node_modules"))
	userJSON := filepath.Join(workDir, "user.json")
	planJSON := filepath.Join(workDir, "plan.json")
	instanceDir := filepath.Join(workDir, "instance")
	silentVideo := filepath.Join(workDir, "motion-render.mp4")
	if err := os.WriteFile(userJSON, params, 0o644); err != nil {
		return nil, err
	}

	if progress != nil {
		if err := progress("校验模板参数…", 8); err != nil {
			return nil, err
		}
	}
	var planBuf bytes.Buffer
	if err := r.runAdapter(ctx, env, []string{"plan", "--input", userJSON, "--out", planJSON}, &planBuf, nil); err != nil {
		return nil, fmt.Errorf("模板参数校验失败：%w", err)
	}
	planRaw, err := os.ReadFile(planJSON)
	if err != nil {
		return nil, fmt.Errorf("模板未产出渲染计划：%w", err)
	}
	var plan motionPlan
	if err := json.Unmarshal(planRaw, &plan); err != nil || plan.DurationS <= 0 || plan.Frames <= 0 {
		return nil, errors.New("模板渲染计划无效")
	}

	if progress != nil {
		if err := progress("准备渲染实例…", 15); err != nil {
			return nil, err
		}
	}
	var prepareBuf bytes.Buffer
	if err := r.runAdapter(ctx, env, []string{"prepare", "--input", userJSON, "--out", instanceDir}, &prepareBuf, nil); err != nil {
		return nil, fmt.Errorf("模板实例准备失败：%w", err)
	}

	if progress != nil {
		if err := progress("逐帧渲染中…", 22); err != nil {
			return nil, err
		}
	}
	var renderLog bytes.Buffer
	if err := r.runAdapter(ctx, env, []string{"render", "--instance", instanceDir, "--out", silentVideo}, &renderLog, func(line string) {
		if progress == nil {
			return
		}
		var tick struct {
			Seconds float64 `json:"seconds"`
			Total   float64 `json:"total"`
		}
		if !strings.HasPrefix(line, "{") || json.Unmarshal([]byte(line), &tick) != nil || tick.Total <= 0 {
			return
		}
		percent := 22 + int(tick.Seconds/tick.Total*70)
		if percent > 95 {
			percent = 95
		}
		_ = progress("逐帧渲染中…", percent)
	}); err != nil {
		return nil, fmt.Errorf("模板渲染失败：%w", err)
	}

	final := strings.TrimSuffix(silentVideo, ".mp4") + "-with-audio.mp4"
	if _, err := os.Stat(final); err != nil {
		if _, silentErr := os.Stat(silentVideo); silentErr != nil {
			return nil, errors.New("模板没有产出视频文件")
		}
		final = silentVideo
	}
	info, err := os.Stat(final)
	if err != nil {
		return nil, err
	}
	return &RenderResult{
		Path:       final,
		Size:       info.Size(),
		DurationMs: int64(plan.DurationS * 1000),
		Width:      plan.Width,
		Height:     plan.Height,
		Frames:     plan.Frames,
	}, nil
}

// runAdapter 执行 `uv run adapter.py <args…>`；stdout 逐行回调（渲染进度），
// 失败时把 stdout/stderr 尾部并入错误信息。
func (r *Runner) runAdapter(ctx context.Context, env []string, args []string, out *bytes.Buffer, onLine func(string)) error {
	if ctx.Err() != nil {
		return ctx.Err()
	}
	entry := strings.TrimSpace(r.Entry)
	if entry == "" {
		entry = "adapter.py"
	}
	command := exec.CommandContext(ctx, "uv", append([]string{"run", entry}, args...)...)
	command.Dir = r.TemplateDir
	command.Env = env
	sysproc.HideConsole(command)
	stdout, err := command.StdoutPipe()
	if err != nil {
		return fmt.Errorf("无法启动模板运行器: %w", err)
	}
	var stderr bytes.Buffer
	command.Stderr = &stderr
	if err := command.Start(); err != nil {
		return fmt.Errorf("无法启动模板运行器（需要本机安装 uv）: %w", err)
	}
	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for scanner.Scan() {
		line := scanner.Text()
		if out != nil {
			if out.Len() < 16<<10 {
				out.WriteString(line)
				out.WriteByte('\n')
			}
		}
		if onLine != nil {
			onLine(line)
		}
	}
	scanErr := scanner.Err()
	runErr := command.Wait()
	if scanErr != nil && runErr == nil {
		return scanErr
	}
	if runErr != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		message := stderr.String()
		if strings.TrimSpace(message) == "" && out != nil {
			message = out.String()
		}
		tail := tailText(message, 4000)
		if strings.TrimSpace(tail) == "" {
			tail = runErr.Error()
		}
		return errors.New(tail)
	}
	return nil
}

// childEnv 构造子进程环境：最小白名单 + ffmpeg 目录前置 PATH。
// 不透传后端凭据、owner token 或内部 URL；模板渲染不需要它们。
func (r *Runner) childEnv() ([]string, error) {
	if strings.TrimSpace(r.FFmpegBin) == "" {
		return nil, errors.New("本机 ffmpeg 不可用，无法执行模板渲染")
	}
	for _, tool := range []string{"uv", "node"} {
		if _, err := exec.LookPath(tool); err != nil {
			return nil, fmt.Errorf("本机未安装 %s，无法执行模板渲染（模板运行时需要 uv 与 Node.js 22+）", tool)
		}
	}
	pathValue := os.Getenv("PATH")
	if dir := filepath.Dir(r.FFmpegBin); dir != "" {
		pathValue = dir + string(os.PathListSeparator) + pathValue
	}
	keep := []string{"PATH", "PATHEXT", "SYSTEMROOT", "SYSTEMDRIVE", "TEMP", "TMP", "USERPROFILE", "HOMEDRIVE", "HOMEDOWN", "LOCALAPPDATA", "APPDATA", "COMPUTERNAME", "OS", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "PLAYWRIGHT_BROWSERS_PATH", "CHROME"}
	env := []string{"PATH=" + pathValue}
	for _, name := range keep {
		if name == "PATH" {
			continue
		}
		if value, ok := os.LookupEnv(name); ok {
			env = append(env, name+"="+value)
		}
	}
	return env, nil
}

func isJSONObject(raw []byte) bool {
	var probe map[string]any
	return json.Unmarshal(raw, &probe) == nil && probe != nil
}

func tailText(text string, limit int) string {
	trimmed := strings.TrimSpace(text)
	if len(trimmed) <= limit {
		return trimmed
	}
	return trimmed[len(trimmed)-limit:]
}

// nodeRuntimeDir 返回 Node 依赖安装目录；未配置时返回空串表示模板无需 Node 依赖。
func (r *Runner) nodeRuntimeDir() string {
	return strings.TrimSpace(r.RuntimeDir)
}

// ensureNodeRuntime 首次渲染时把模板声明的 package.json/lock 复制到共享
// 运行时目录并执行 npm ci。安装目录在模板目录之外，不参与内容摘要。
func (r *Runner) ensureNodeRuntime(ctx context.Context, env []string, progress func(stage string, percent int) error) error {
	runtimeDir := r.nodeRuntimeDir()
	if runtimeDir == "" {
		return nil
	}
	packageJSON := filepath.Join(r.TemplateDir, "package.json")
	if _, err := os.Stat(packageJSON); err != nil {
		return nil
	}
	if err := os.MkdirAll(runtimeDir, 0o755); err != nil {
		return err
	}
	changed := false
	for _, name := range []string{"package.json", "package-lock.json"} {
		source := filepath.Join(r.TemplateDir, name)
		if _, err := os.Stat(source); err != nil {
			continue
		}
		target := filepath.Join(runtimeDir, name)
		want, err := os.ReadFile(source)
		if err != nil {
			return err
		}
		have, readErr := os.ReadFile(target)
		if readErr != nil || !bytes.Equal(have, want) {
			if err := os.WriteFile(target, want, 0o644); err != nil {
				return err
			}
			changed = true
		}
	}
	modulesDir := filepath.Join(runtimeDir, "node_modules")
	if !changed {
		if _, err := os.Stat(modulesDir); err == nil {
			return nil
		}
	}
	if progress != nil {
		if err := progress("准备模板运行依赖…", 3); err != nil {
			return err
		}
	}
	if _, err := exec.LookPath("npm"); err != nil {
		return errors.New("本机未安装 npm，无法准备模板运行依赖（模板渲染需要 Node.js 22+ 与 npm）")
	}
	command := exec.CommandContext(ctx, "npm", "ci", "--no-audit", "--no-fund", "--loglevel=error")
	command.Dir = runtimeDir
	command.Env = env
	sysproc.HideConsole(command)
	var stderr bytes.Buffer
	command.Stderr = &stderr
	if err := command.Run(); err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		message := tailText(stderr.String(), 2000)
		if strings.TrimSpace(message) == "" {
			message = err.Error()
		}
		return fmt.Errorf("模板 Node 依赖安装失败：%s", message)
	}
	return nil
}
