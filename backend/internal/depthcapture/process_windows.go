package depthcapture

import (
	"context"
	"infinite-canvas/backend/internal/sysproc"
	"os"
	"os/exec"
	"strconv"
	"time"
)

func configureDepthCommand(command *exec.Cmd) {
	command.WaitDelay = 5 * time.Second
	command.Cancel = func() error {
		if command.Process == nil {
			return os.ErrProcessDone
		}
		killCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		kill := exec.CommandContext(killCtx, "taskkill", "/T", "/F", "/PID", strconv.Itoa(command.Process.Pid))
		sysproc.HideConsole(kill)
		_ = kill.Run()
		return command.Process.Kill()
	}
}
