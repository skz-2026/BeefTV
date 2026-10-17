// Package mediatools resolves the desktop-owned native media runtime.
package mediatools

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

const FFmpegPathEnv = "CANVAS_FFMPEG_PATH"
const FFprobePathEnv = "CANVAS_FFPROBE_PATH"

func ResolveFFmpeg() (string, error) {
	return resolveTool("ffmpeg", FFmpegPathEnv)
}

func ResolveFFprobe() (string, error) {
	return resolveTool("ffprobe", FFprobePathEnv)
}

func resolveTool(name, env string) (string, error) {
	if configured := strings.TrimSpace(os.Getenv(env)); configured != "" {
		return configured, nil
	}
	executable, err := os.Executable()
	if err == nil {
		if resolved, e := filepath.EvalSymlinks(executable); e == nil {
			executable = resolved
		}
		if bundled := bundledTool(executable, name); bundled != "" {
			return bundled, nil
		}
	}
	if path, err := exec.LookPath(name); err == nil {
		return path, nil
	}
	return "", fmt.Errorf("视频处理工具不可用，请重新安装应用")
}

func bundledFFmpeg(executable string) string {
	return bundledTool(executable, "ffmpeg")
}

func bundledTool(executable, tool string) string {
	dir := filepath.Dir(executable)
	if filepath.Base(dir) == "cli" {
		dir = filepath.Dir(dir)
	}
	mediaDirs := []string{filepath.Join(dir, "agent-host", "media-runtime"), filepath.Join(dir, "media-runtime")}
	if filepath.Base(dir) == "MacOS" && filepath.Base(filepath.Dir(dir)) == "Contents" {
		mediaDirs = append([]string{filepath.Join(filepath.Dir(dir), "Resources", "agent-host", "media-runtime")}, mediaDirs...)
	}
	for _, media := range mediaDirs {
		for _, name := range []string{tool + ".exe", tool} {
			candidate := filepath.Join(media, name)
			if info, err := os.Lstat(candidate); err == nil && info.Mode().IsRegular() {
				return candidate
			}
		}
	}
	return ""
}

// ResolveFFprobe 与 ffmpeg 同源解析：CANVAS_FFMPEG_PATH 同目录的 ffprobe 优先，
// 其次可执行文件旁的 media-runtime，最后 PATH。桌面安装包两者始终同目录分发。
func ResolveFFprobe() (string, error) {
	probeNames := []string{"ffprobe.exe", "ffprobe"}
	if configured := strings.TrimSpace(os.Getenv(FFmpegPathEnv)); configured != "" {
		dir := filepath.Dir(configured)
		for _, name := range probeNames {
			candidate := filepath.Join(dir, name)
			if info, err := os.Lstat(candidate); err == nil && info.Mode().IsRegular() {
				return candidate, nil
			}
		}
	}
	if executable, err := os.Executable(); err == nil {
		if resolved, e := filepath.EvalSymlinks(executable); e == nil {
			executable = resolved
		}
		dir := filepath.Dir(executable)
		if filepath.Base(dir) == "cli" {
			dir = filepath.Dir(dir)
		}
		for _, media := range []string{filepath.Join(dir, "agent-host", "media-runtime"), filepath.Join(dir, "media-runtime")} {
			for _, name := range probeNames {
				candidate := filepath.Join(media, name)
				if info, err := os.Lstat(candidate); err == nil && info.Mode().IsRegular() {
					return candidate, nil
				}
			}
		}
	}
	if path, err := exec.LookPath("ffprobe"); err == nil {
		return path, nil
	}
	return "", fmt.Errorf("媒体探测工具不可用，请重新安装应用")
}
