package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestSkillLinkReceiptContainsNoLinkAndDoesNotOpenRuntime(t *testing.T) {
	app := newDesktopApp(t.TempDir())
	app.acceptSkillLink("beeftv://skills/install?id=private-skill&version=release_1")
	app.acceptSkillLink("beeftv://skills/install?id=invalid")
	receipt, err := os.ReadFile(filepath.Join(app.dataDir, "skill-links.log"))
	if err != nil || strings.Count(string(receipt), "收到技能预览请求") != 1 {
		t.Fatalf("valid link receipt was not recorded once: %v", err)
	}
	for _, secret := range []string{"beeftv:", "private-skill", "release_1"} {
		if strings.Contains(string(receipt), secret) {
			t.Fatal("link receipt exposed link details")
		}
	}
	if app.RuntimeConfig().BaseURL != "" {
		t.Fatal("receiving a preview link opened the backend")
	}
	if route := app.ConsumeSkillInstallLink(); route != "/skills?install=private-skill&version=release_1" || app.ConsumeSkillInstallLink() != "" {
		t.Fatal("preview was not consumed exactly once")
	}
}

func TestSkillInstallLinksOnlyNavigateToExactVersion(t *testing.T) {
	route, err := skillInstallRoute("beeftv://skills/install?id=test-skill&version=release_1")
	if err != nil || route != "/skills?install=test-skill&version=release_1" {
		t.Fatalf("%s %v", route, err)
	}
	for _, bad := range []string{"beeftv://skills/install?id=x&version=1&url=https://evil.invalid", "beeftv://skills/install?id=x&version=1&version=2", "beeftv://skills/install?id=../secret&version=1", "beeftv://skills/install?id=x", "https://beeftv.app/skills/install?id=x&version=1", "beeftv://user@skills/install?id=x&version=1"} {
		if _, err := skillInstallRoute(bad); err == nil {
			t.Fatal("accepted", bad)
		}
	}
	if err := validateDesktopArgs([]string{"beeftv://skills/install?id=x&version=1"}); err != nil {
		t.Fatal(err)
	}
}

func TestOfficialSkillSemanticReleaseLink(t *testing.T) {
	route, e := skillInstallRoute("beeftv://skills/install?id=official-storyboard-text&version=official-storyboard-text-1.0.0")
	if e != nil || route == "" {
		t.Fatal("official release link rejected", e)
	}
}
