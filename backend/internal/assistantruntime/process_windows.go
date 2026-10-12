//go:build windows

package assistantruntime

import (
	"os/exec"

	"infinite-canvas/backend/internal/sysproc"
)

func configureHostProcess(cmd *exec.Cmd) {
	// The host remains supervised through stdin and keeps its diagnostic handles,
	// but a GUI launch must not allocate a separate Node console.
	sysproc.HideConsole(cmd)
}
