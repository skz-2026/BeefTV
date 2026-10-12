//go:build !windows

package main

import (
	"os"
	"os/exec"
	"syscall"
)

func setupJobObject() error { return nil }

func assignToJobObject(pid int) {}

// prepareChildCmd 让子进程成为独立进程组，方便整组终止。
func prepareChildCmd(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
}

func gracefulStop(p *os.Process, pid int) error {
	return syscall.Kill(-pid, syscall.SIGTERM)
}

func killTreeForce(pid int) {
	_ = syscall.Kill(-pid, syscall.SIGKILL)
}

func openBrowser(url string) {
	_ = exec.Command("open", url).Start()
}

func initConsole() {}

func openExplorer(path string) {
	_ = exec.Command("xdg-open", path).Start()
}
