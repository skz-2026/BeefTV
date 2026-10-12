//go:build windows

// Package sysproc 集中管理子进程的平台级属性。GUI 宿主（桌面版）没有控制台，
// exec 拉起控制台程序（nvidia-smi、ffmpeg、taskkill 等）时 Windows 会为新进程
// 分配一个可见的控制台窗口，形成反复闪现的黑框；所有从 GUI 宿主发起的
// exec.Command 都应在启动前调用 HideConsole。
package sysproc

import (
	"os/exec"
	"syscall"

	"golang.org/x/sys/windows"
)

// HideConsole 阻止子进程分配新的控制台窗口；已设置的 SysProcAttr 与 CreationFlags 保持不变。
func HideConsole(cmd *exec.Cmd) {
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	cmd.SysProcAttr.HideWindow = true
	cmd.SysProcAttr.CreationFlags |= windows.CREATE_NO_WINDOW
}
