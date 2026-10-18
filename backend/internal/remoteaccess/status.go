// Package remoteaccess reports how this machine can be reached on the user's
// tailnet. It only reads local Tailscale state; it does not open, close, or
// proxy any connection.
package remoteaccess

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"
)

// Status is what the remote access page needs to render a scannable URL.
type Status struct {
	Available bool   `json:"available"`
	Reason    string `json:"reason,omitempty"`
	DNSName   string `json:"dnsName,omitempty"`
	URL       string `json:"url,omitempty"`
	MagicDNS  bool   `json:"magicDns"`
	ServeOn   bool   `json:"serveOn"`
	ServePort int    `json:"servePort,omitempty"`
	LocalURL  string `json:"localUrl,omitempty"`
}

const defaultLocalURL = "http://127.0.0.1:3000/"

// Look reads the current Tailscale state. Failures are reported in Status so the
// page can explain what is missing instead of showing a broken QR code.
func Look(ctx context.Context) Status {
	status := Status{LocalURL: defaultLocalURL}
	cli, err := findCLI()
	if err != nil {
		status.Reason = "tailscale_not_found"
		return status
	}
	raw, err := run(ctx, cli, "status", "--json")
	if err != nil {
		status.Reason = "tailscale_not_running"
		return status
	}
	dnsName, magicDNS, err := parseStatus(raw)
	if err != nil {
		status.Reason = "tailscale_unreadable"
		return status
	}
	if dnsName == "" {
		status.Reason = "tailscale_not_logged_in"
		return status
	}
	status.Available = true
	status.DNSName = dnsName
	status.URL = "https://" + dnsName + "/"
	status.MagicDNS = magicDNS
	if port, ok := readServe(ctx, cli); ok {
		status.ServeOn = true
		status.ServePort = port
		// T3 Code 也占用 tailnet 的 443（/ -> 3773），BeefTV 因此发布在 8443；
		// 二维码必须带上实际端口，否则手机打开的是另一个服务。
		if port > 0 && port != 443 {
			status.URL = fmt.Sprintf("https://%s:%d/", dnsName, port)
		}
	}
	return status
}

// parseStatus reads the two fields the page needs, so the JSON shape stays in
// one place and can be tested without a running tailscaled.
func parseStatus(raw []byte) (string, bool, error) {
	var parsed struct {
		Self struct {
			DNSName string `json:"DNSName"`
		} `json:"Self"`
		CurrentTailnet struct {
			MagicDNSEnabled bool `json:"MagicDNSEnabled"`
		} `json:"CurrentTailnet"`
	}
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return "", false, err
	}
	return strings.TrimSuffix(strings.TrimSpace(parsed.Self.DNSName), "."), parsed.CurrentTailnet.MagicDNSEnabled, nil
}

// readServe returns the HTTPS port this machine publishes port 3000 on, if any.
// Tailscale Serve holds one handler table per port, so the port is part of the
// public URL and must come from the status rather than a fixed 443.
func readServe(ctx context.Context, cli string) (int, bool) {
	raw, err := run(ctx, cli, "serve", "status", "--json")
	if err != nil {
		return 0, false
	}
	return parseServePort(raw)
}

func parseServePort(raw []byte) (int, bool) {
	var payload struct {
		Web map[string]struct {
			Handlers map[string]struct {
				Proxy string `json:"Proxy"`
			} `json:"Handlers"`
		} `json:"Web"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil {
		return 0, false
	}
	for address, web := range payload.Web {
		for _, handler := range web.Handlers {
			proxy := strings.TrimSuffix(strings.TrimSpace(handler.Proxy), "/")
			if proxy != "http://127.0.0.1:3000" && proxy != "http://localhost:3000" {
				continue
			}
			if index := strings.LastIndex(address, ":"); index >= 0 {
				if port, err := strconv.Atoi(address[index+1:]); err == nil {
					return port, true
				}
			}
		}
	}
	return 0, false
}

func run(parent context.Context, cli string, args ...string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(parent, 4*time.Second)
	defer cancel()
	return exec.CommandContext(ctx, cli, args...).Output()
}

func findCLI() (string, error) {
	if configured := strings.TrimSpace(os.Getenv("BEEFTV_TAILSCALE_PATH")); configured != "" {
		if _, err := os.Stat(configured); err == nil {
			return configured, nil
		}
	}
	if found, err := exec.LookPath("tailscale"); err == nil {
		return found, nil
	}
	for _, candidate := range cliCandidates() {
		if _, err := os.Stat(candidate); err == nil {
			return candidate, nil
		}
	}
	return "", errors.New("tailscale CLI not found")
}

func cliCandidates() []string {
	switch runtime.GOOS {
	case "windows":
		var candidates []string
		for _, base := range []string{os.Getenv("ProgramFiles"), os.Getenv("ProgramFiles(x86)"), os.Getenv("LOCALAPPDATA")} {
			if base != "" {
				candidates = append(candidates, filepath.Join(base, "Tailscale", "tailscale.exe"))
			}
		}
		return candidates
	case "darwin":
		return []string{
			"/Applications/Tailscale.app/Contents/MacOS/Tailscale",
			"/opt/homebrew/bin/tailscale",
			"/usr/local/bin/tailscale",
		}
	default:
		return []string{"/usr/bin/tailscale", "/usr/local/bin/tailscale", "/snap/bin/tailscale"}
	}
}
