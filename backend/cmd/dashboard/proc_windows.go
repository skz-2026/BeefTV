//go:build windows

package main

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

// jobHandle 关闭时整组子进程一并结束（JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE），
// 保证用户直接关掉看板控制台窗口时，后端/代理/前端不会变成孤儿进程。
var jobHandle windows.Handle

func setupJobObject() error {
	h, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		return err
	}
	info := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{}
	info.BasicLimitInformation.LimitFlags = windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
	if _, err := windows.SetInformationJobObject(h, windows.JobObjectExtendedLimitInformation,
		uintptr(unsafe.Pointer(&info)), uint32(unsafe.Sizeof(info))); err != nil {
		_ = windows.CloseHandle(h)
		return err
	}
	jobHandle = h
	return nil
}

func assignToJobObject(pid int) {
	if jobHandle == 0 {
		return
	}
	h, err := windows.OpenProcess(windows.PROCESS_SET_QUOTA|windows.PROCESS_TERMINATE, false, uint32(pid))
	if err != nil {
		return
	}
	_ = windows.AssignProcessToJobObject(jobHandle, h)
	_ = windows.CloseHandle(h)
}

// prepareChildCmd 为子进程创建独立进程组，使 Ctrl+Break 可以只发给目标进程。
func prepareChildCmd(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: syscall.CREATE_NEW_PROCESS_GROUP}
}

// gracefulStop 直接向子进程组发送 CTRL_BREAK 事件（子进程在启动时以
// CREATE_NEW_PROCESS_GROUP 创建，组 id == pid）：Go 后端映射为 SIGTERM 走优雅退出，
// node/bun 默认终止。os.Process.Signal(os.Interrupt) 在 Windows 上不支持，必须走此调用。
func gracefulStop(p *os.Process, pid int) error {
	if p == nil {
		return errors.New("no process handle")
	}
	return windows.GenerateConsoleCtrlEvent(windows.CTRL_BREAK_EVENT, uint32(pid))
}

func killTreeForce(pid int) {
	_ = exec.Command("taskkill", "/PID", strconv.Itoa(pid), "/T", "/F").Run()
}

func openBrowser(url string) {
	if err := exec.Command("rundll32", "url.dll,FileProtocolHandler", url).Start(); err != nil {
		fmt.Printf("open browser: %v\n", err)
	}
}

// initConsole 把控制台代码页切到 UTF-8，中文日志行才不会在 GBK 控制台里乱码。
func initConsole() {
	_ = windows.SetConsoleOutputCP(65001)
	_ = windows.SetConsoleCP(65001)
}

func openExplorer(path string) {
	_ = exec.Command("explorer.exe", path).Start()
}
