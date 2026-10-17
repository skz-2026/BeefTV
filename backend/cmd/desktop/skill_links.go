package main

import (
	"errors"
	"fmt"
	"log"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"time"

	wailsruntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

var skillLinkID = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$`)

func skillInstallRoute(raw string) (string, error) {
	u, e := url.Parse(raw)
	if e != nil || u.Scheme != "beeftv" || u.Host != "skills" || u.Path != "/install" || u.User != nil || u.Fragment != "" {
		return "", errors.New("技能安装链接无效")
	}
	q, e := url.ParseQuery(u.RawQuery)
	if e != nil || len(q) != 2 || len(q["id"]) != 1 || len(q["version"]) != 1 || !skillLinkID.MatchString(q.Get("id")) || !skillLinkID.MatchString(q.Get("version")) {
		return "", errors.New("技能安装链接缺少有效版本")
	}
	return "/skills?install=" + url.QueryEscape(q.Get("id")) + "&version=" + url.QueryEscape(q.Get("version")), nil
}
func (a *DesktopApp) acceptSkillLink(raw string) {
	route, e := skillInstallRoute(raw)
	if e != nil {
		return
	}
	a.mu.Lock()
	a.pendingSkillLink = route
	ctx := a.wailsCtx
	a.mu.Unlock()
	// A GUI launched through the OS may have no stderr. Keep a local receipt
	// without the URL, skill identity or credentials; it records preview only.
	if file, err := os.OpenFile(filepath.Join(a.dataDir, "skill-links.log"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600); err == nil {
		_, _ = fmt.Fprintln(file, time.Now().UTC().Format(time.RFC3339), "收到技能预览请求")
		_ = file.Close()
	} else {
		log.Print("无法记录技能预览请求")
	}
	if ctx != nil {
		wailsruntime.WindowUnminimise(ctx)
		wailsruntime.WindowShow(ctx)
	}
}

// ConsumeSkillInstallLink only navigates to a version preview. It never installs.
func (a *DesktopApp) ConsumeSkillInstallLink() string {
	a.mu.Lock()
	defer a.mu.Unlock()
	link := a.pendingSkillLink
	a.pendingSkillLink = ""
	return link
}
func (a *DesktopApp) OpenSkillPublishingURL(raw string) error {
	u, e := url.Parse(raw)
	if e != nil || u.User != nil || u.Fragment != "" {
		return errors.New("投稿授权链接无效")
	}
	trusted := u.Scheme == "https" && u.Host == "beeftv.app"
	if base, e := url.Parse(os.Getenv("BEEFTV_SKILLHUB_URL")); e == nil && base.Scheme == "http" && (base.Hostname() == "127.0.0.1" || base.Hostname() == "localhost") {
		trusted = trusted || (u.Scheme == "http" && (u.Hostname() == "localhost" || u.Hostname() == "127.0.0.1"))
	}
	if !trusted || u.Path != "/skills/authorize" || !skillLinkID.MatchString(u.Query().Get("user_code")) {
		return errors.New("仅支持 BeefTV 技能投稿授权页面")
	}
	ctx, e := a.dialogContext()
	if e != nil {
		return e
	}
	wailsruntime.BrowserOpenURL(ctx, u.String())
	return nil
}
