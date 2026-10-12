//go:build !windows

package sysproc

import "os/exec"

// HideConsole 在非 Windows 平台没有控制台窗口分配问题，保持空实现以统一调用面。
func HideConsole(_ *exec.Cmd) {}
