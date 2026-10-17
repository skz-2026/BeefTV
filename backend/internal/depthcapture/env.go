package depthcapture

import (
	"os"
	"path/filepath"
	"runtime"

	"infinite-canvas/backend/internal/desktopnet"
)

func WorkerEnv(toolDir string) []string {
	return WorkerEnvForPlatform(toolDir, runtime.GOOS)
}

func WorkerEnvForPlatform(toolDir, platform string) []string {
	env := workerEnv(toolDir, platform, os.Environ(), os.Getenv)
	// Published workers may repair a missing checkpoint with curl. Use the
	// same freshly resolved proxy as the signed component downloader.
	return append(env, desktopnet.HTTPSProxyEnvironment()...)
}

func workerEnv(toolDir, platform string, environ []string, getenv func(string) string) []string {
	if getenv == nil {
		getenv = os.Getenv
	}
	env := append(append([]string{}, environ...), "PYTORCH_ENABLE_MPS_FALLBACK=1", "BEEFTV_VDA_SOURCE="+filepath.Join(filepath.Dir(toolDir), "vda"))
	if platform == "windows" {
		env = append(env, "PYTHONIOENCODING=utf-8", "PATH="+filepath.Join(filepath.Dir(toolDir), "bin")+string(os.PathListSeparator)+getenv("PATH"))
	}
	return env
}
