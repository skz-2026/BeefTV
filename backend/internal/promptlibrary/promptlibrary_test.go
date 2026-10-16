package promptlibrary

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"database/sql"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// fixture 数据集 schema 与真实数据集同构（scripts/prompt_library.py 同源）。
const fixtureSchema = `
CREATE TABLE prompts (tweet_id TEXT PRIMARY KEY, author TEXT, tool TEXT, prompt_text TEXT, created_at TEXT, tweet_url TEXT, collected_at TEXT);
CREATE TABLE images (tweet_id TEXT, image_index INTEGER, url TEXT, local_path TEXT);
CREATE TABLE prompt_translations (tweet_id TEXT, locale TEXT, translated_text TEXT, translation_version TEXT);
CREATE TABLE prompt_labels (tweet_id TEXT, label_id INTEGER, taxonomy_version TEXT, confidence REAL);
CREATE TABLE media_labels (tweet_id TEXT, label_id INTEGER, taxonomy_version TEXT, confidence REAL, media_type TEXT);
CREATE TABLE taxonomy_labels (taxonomy_version TEXT, label_id INTEGER, dimension_key TEXT, key TEXT, display_en TEXT, display_zh TEXT);
CREATE TABLE prompt_recipes (tweet_id TEXT, recipe_text_en TEXT, recipe_text_zh TEXT, status TEXT, updated_at TEXT);
`

const taxonomyVersion = "oip-visual-test"

func createFixture(t *testing.T) (*Service, string) {
	t.Helper()
	dataDir := t.TempDir()
	root := filepath.Join(dataDir, "prompt-library")
	if err := os.MkdirAll(root, 0o755); err != nil {
		t.Fatal(err)
	}
	db, err := sql.Open("sqlite3", filepath.Join(root, "prompts.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err := db.Exec(fixtureSchema); err != nil {
		t.Fatal(err)
	}
	seed := []string{
		`INSERT INTO prompts VALUES ('2105000000000000001','alice','Midjourney','cyberpunk city skyline, neon rain','2026-10-01','https://x.com/a/1','2026-10-02')`,
		`INSERT INTO prompts VALUES ('2105000000000000002','bob','Flux','a cozy watercolor cottage','2026-10-03','https://x.com/b/2','2026-10-04')`,
		`INSERT INTO prompts VALUES ('2105000000000000003','carol','Midjourney','portrait of a knight, studio light','2026-10-05','https://x.com/c/3','2026-10-06')`,
		`INSERT INTO prompt_translations VALUES ('2105000000000000001','zh-Hans','赛博朋克城市天际线，霓虹雨','v1')`,
		`INSERT INTO prompt_translations VALUES ('2105000000000000002','zh-Hans','温馨水彩小屋','v1')`,
		`INSERT INTO images VALUES ('2105000000000000001',1,'https://pbs/1.jpg','images/2105000000000000001/1.jpg')`,
		`INSERT INTO images VALUES ('2105000000000000001',2,'https://pbs/2.jpg','images/2105000000000000001/2.jpg')`,
		`INSERT INTO images VALUES ('2105000000000000002',1,'https://pbs/3.jpg','images/2105000000000000002/1.jpg')`,
		`INSERT INTO taxonomy_labels VALUES ('` + taxonomyVersion + `',101,'subject','cat','Cat','猫')`,
		`INSERT INTO taxonomy_labels VALUES ('` + taxonomyVersion + `',102,'style','watercolor','Watercolor','水彩')`,
		`INSERT INTO prompt_labels VALUES ('2105000000000000002',102,'` + taxonomyVersion + `',0.9)`,
		`INSERT INTO media_labels VALUES ('2105000000000000001',101,'` + taxonomyVersion + `',0.8,'image')`,
		`INSERT INTO prompt_recipes VALUES ('2105000000000000001','recipe en','配方中文','ready','2026-10-02')`,
	}
	for _, statement := range seed {
		if _, err := db.Exec(statement); err != nil {
			t.Fatalf("seed failed: %v: %v", statement, err)
		}
	}
	service, err := Open(Options{DataDir: dataDir})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = service.Close() })
	return service, root
}

func TestSearchByTextEnglishAndChinese(t *testing.T) {
	service, _ := createFixture(t)
	ctx := context.Background()
	english, err := service.Search(ctx, SearchParams{Query: "cyberpunk"})
	if err != nil {
		t.Fatal(err)
	}
	if len(english.Items) != 1 || english.Items[0].TweetID != "2105000000000000001" {
		t.Fatalf("english search mismatch: %+v", english.Items)
	}
	chinese, err := service.Search(ctx, SearchParams{Query: "赛博朋克"})
	if err != nil {
		t.Fatal(err)
	}
	if len(chinese.Items) != 1 || chinese.Items[0].TweetID != "2105000000000000001" {
		t.Fatalf("chinese translation search mismatch: %+v", chinese.Items)
	}
	multi, err := service.Search(ctx, SearchParams{Query: "cyberpunk neon"})
	if err != nil {
		t.Fatal(err)
	}
	if len(multi.Items) != 1 {
		t.Fatalf("multi-term AND search mismatch: %+v", multi.Items)
	}
	none, err := service.Search(ctx, SearchParams{Query: "cyberpunk watercolor"})
	if err != nil {
		t.Fatal(err)
	}
	if len(none.Items) != 0 {
		t.Fatalf("contradictory terms should match nothing: %+v", none.Items)
	}
}

func TestSearchAuthorAndToolFilter(t *testing.T) {
	service, _ := createFixture(t)
	ctx := context.Background()
	byTool, err := service.Search(ctx, SearchParams{Tool: "Flux"})
	if err != nil {
		t.Fatal(err)
	}
	if len(byTool.Items) != 1 || byTool.Items[0].Author != "bob" {
		t.Fatalf("tool filter mismatch: %+v", byTool.Items)
	}
	byAuthor, err := service.Search(ctx, SearchParams{Author: "carol"})
	if err != nil {
		t.Fatal(err)
	}
	if len(byAuthor.Items) != 1 || byAuthor.Items[0].Tool != "Midjourney" {
		t.Fatalf("author filter mismatch: %+v", byAuthor.Items)
	}
}

func TestSearchTagFilter(t *testing.T) {
	service, _ := createFixture(t)
	ctx := context.Background()
	// subject:cat 只出现在 media_labels；style:watercolor 只出现在 prompt_labels。
	mediaTag, err := service.Search(ctx, SearchParams{Tags: []string{"subject:cat"}})
	if err != nil {
		t.Fatal(err)
	}
	if len(mediaTag.Items) != 1 || mediaTag.Items[0].TweetID != "2105000000000000001" {
		t.Fatalf("media label filter mismatch: %+v", mediaTag.Items)
	}
	promptTag, err := service.Search(ctx, SearchParams{Tags: []string{"style:watercolor"}})
	if err != nil {
		t.Fatal(err)
	}
	if len(promptTag.Items) != 1 || promptTag.Items[0].TweetID != "2105000000000000002" {
		t.Fatalf("prompt label filter mismatch: %+v", promptTag.Items)
	}
	intersection, err := service.Search(ctx, SearchParams{Tags: []string{"subject:cat", "style:watercolor"}})
	if err != nil {
		t.Fatal(err)
	}
	if len(intersection.Items) != 0 {
		t.Fatalf("tag intersection should be empty: %+v", intersection.Items)
	}
	unknown, err := service.Search(ctx, SearchParams{Tags: []string{"subject:nope"}})
	if err != nil {
		t.Fatal(err)
	}
	if len(unknown.Items) != 0 || unknown.Total != 0 {
		t.Fatalf("unknown tag should return empty page: %+v", unknown)
	}
}

func TestSearchPagination(t *testing.T) {
	service, _ := createFixture(t)
	ctx := context.Background()
	first, err := service.Search(ctx, SearchParams{Page: 1, PageSize: 2})
	if err != nil {
		t.Fatal(err)
	}
	if len(first.Items) != 2 || !first.HasMore || first.Total != 3 {
		t.Fatalf("page one mismatch: items=%d hasMore=%v total=%d", len(first.Items), first.HasMore, first.Total)
	}
	second, err := service.Search(ctx, SearchParams{Page: 2, PageSize: 2})
	if err != nil {
		t.Fatal(err)
	}
	if len(second.Items) != 1 || second.HasMore {
		t.Fatalf("page two mismatch: items=%d hasMore=%v", len(second.Items), second.HasMore)
	}
	// 无词浏览按 tweet_id 倒序：第一条应是最新。
	if first.Items[0].TweetID != "2105000000000000003" {
		t.Fatalf("browse order should be newest first, got %s", first.Items[0].TweetID)
	}
}

func TestDetailHydratesImagesTagsRecipe(t *testing.T) {
	service, _ := createFixture(t)
	ctx := context.Background()
	detail, err := service.Detail(ctx, "2105000000000000001")
	if err != nil {
		t.Fatal(err)
	}
	if detail.ImageCount != 2 || len(detail.Images) != 2 {
		t.Fatalf("images not hydrated: %+v", detail.Images)
	}
	if len(detail.Tags) != 1 || detail.Tags[0].DisplayZh != "猫" {
		t.Fatalf("tags not hydrated: %+v", detail.Tags)
	}
	if detail.RecipeZh != "配方中文" || detail.RecipeEn != "recipe en" {
		t.Fatalf("recipe not hydrated: %+v", detail)
	}
	if _, err := service.Detail(ctx, "999"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("missing detail should be ErrNotFound, got %v", err)
	}
}

func TestImageFileRespectsLocalPack(t *testing.T) {
	service, root := createFixture(t)
	ctx := context.Background()
	// 图片包未下载：路径已知但文件不存在。
	if _, err := service.ImageFile(ctx, "2105000000000000001", 1); !errors.Is(err, ErrPackMissing) {
		t.Fatalf("missing pack should be ErrPackMissing, got %v", err)
	}
	relative := filepath.Join(root, "images", "2105000000000000001", "1.jpg")
	if err := os.MkdirAll(filepath.Dir(relative), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(relative, []byte("jpg"), 0o644); err != nil {
		t.Fatal(err)
	}
	path, err := service.ImageFile(ctx, "2105000000000000001", 1)
	if err != nil {
		t.Fatal(err)
	}
	if path != relative {
		t.Fatalf("resolved path mismatch: %s", path)
	}
	if _, err := service.ImageFile(ctx, "2105000000000000001", 9); !errors.Is(err, ErrNotFound) {
		t.Fatalf("missing image should be ErrNotFound, got %v", err)
	}
}

func TestLabels(t *testing.T) {
	service, _ := createFixture(t)
	labels, err := service.Labels(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	byKey := map[string]LabelInfo{}
	for _, label := range labels {
		byKey[label.Dimension+":"+label.Key] = label
	}
	if len(labels) != 2 {
		t.Fatalf("labels mismatch: %+v", labels)
	}
	if cat, ok := byKey["subject:cat"]; !ok || cat.DisplayZh != "猫" || cat.DisplayEn != "Cat" {
		t.Fatalf("subject:cat label mismatch: %+v", cat)
	}
	if watercolor, ok := byKey["style:watercolor"]; !ok || watercolor.DisplayZh != "水彩" {
		t.Fatalf("style:watercolor label mismatch: %+v", watercolor)
	}
}

func TestSearchNotInstalled(t *testing.T) {
	service, err := Open(Options{DataDir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	defer service.Close()
	if _, err := service.Search(context.Background(), SearchParams{}); !errors.Is(err, ErrNotInstalled) {
		t.Fatalf("expected ErrNotInstalled, got %v", err)
	}
}

func TestStatusWithoutNetwork(t *testing.T) {
	service, _ := createFixture(t)
	// 已取消的 context 让远端清单查询立即失败：Status 仍应返回本地可用状态。
	canceled, cancel := context.WithCancel(context.Background())
	cancel()
	info := service.Status(canceled)
	if !info.Available || info.PromptCount != 3 || info.ImageCount != 3 || info.TranslationCount != 2 {
		t.Fatalf("local status mismatch: %+v", info)
	}
	if info.RemoteError == "" {
		t.Fatal("canceled remote fetch should surface a remote error")
	}
}

func TestStatusNotInstalledExternalDB(t *testing.T) {
	t.Setenv(EnvDBPath, filepath.Join(t.TempDir(), "missing.db"))
	service, err := Open(Options{DataDir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	defer service.Close()
	if !service.External() {
		t.Fatal("env override should mark service external")
	}
	if err := service.Install("db"); !errors.Is(err, ErrExternalDB) {
		t.Fatalf("external db install should fail, got %v", err)
	}
}

func TestMetaRoundTrip(t *testing.T) {
	service, _ := createFixture(t)
	meta := installMeta{
		DB:    &InstalledDB{Tag: "dataset-x", SHA256: strings.Repeat("a", 64), Size: 10, InstalledAt: "now"},
		Packs: map[string]InstalledDB{"images-2026-10.tar.gz": {SHA256: strings.Repeat("b", 64)}},
	}
	if err := service.saveMeta(meta); err != nil {
		t.Fatal(err)
	}
	loaded := service.installedMeta()
	if loaded.DB == nil || loaded.DB.Tag != "dataset-x" || loaded.Packs["images-2026-10.tar.gz"].SHA256 != strings.Repeat("b", 64) {
		t.Fatalf("meta round trip mismatch: %+v", loaded)
	}
	if !fileExists(service.metaPath()) {
		t.Fatal("meta.json should exist")
	}
}

func TestRemoteAssetDigestParsing(t *testing.T) {
	asset, ok := remoteAsset(ghRelease{TagName: "t"}, ghAsset{ID: 1, Name: dbAssetName, Size: 5, Digest: "sha256:" + strings.Repeat("ab", 32)})
	if !ok || !asset.Valid() {
		t.Fatalf("valid asset rejected: %+v", asset)
	}
	if _, ok := remoteAsset(ghRelease{}, ghAsset{ID: 1, Size: 5, Digest: "sha256:zz"}); ok {
		t.Fatal("short digest should be rejected")
	}
	if _, ok := remoteAsset(ghRelease{}, ghAsset{ID: 1, Size: 5}); ok {
		t.Fatal("missing digest should be rejected")
	}
}

func TestExtractPackRejectsUnsafeEntries(t *testing.T) {
	root := t.TempDir()
	archive := filepath.Join(root, "pack.tar.gz")
	buildPackFixture(t, archive, map[string]string{
		"images/2105/1.jpg":      "good",
		"images/2105/1.webp":     "good2",
		"../evil.txt":            "bad",
		"/abs/path.txt":          "bad",
		"c:/windows/evil.txt":    "bad",
		"images/../../escape.js": "bad",
		"meta.json":              "skipped",
	})
	extracted, err := extractPack(archive, filepath.Join(root, "out"))
	if err != nil {
		t.Fatal(err)
	}
	if extracted != 2 {
		t.Fatalf("expected only 2 safe entries extracted, got %d", extracted)
	}
	for _, victim := range []string{filepath.Join(root, "out", "evil.txt"), filepath.Join(root, "out", "meta.json"), filepath.Join(root, "escape.js")} {
		if fileExists(victim) {
			t.Fatalf("unsafe entry extracted: %s", victim)
		}
	}
	if !fileExists(filepath.Join(root, "out", "images", "2105", "1.jpg")) {
		t.Fatal("safe entry missing")
	}
}

func buildPackFixture(t *testing.T, path string, entries map[string]string) {
	t.Helper()
	var buffer bytes.Buffer
	gzipWriter := gzip.NewWriter(&buffer)
	tarWriter := tar.NewWriter(gzipWriter)
	for name, content := range entries {
		if err := tarWriter.WriteHeader(&tar.Header{Name: name, Mode: 0o644, Size: int64(len(content)), Typeflag: tar.TypeReg}); err != nil {
			t.Fatal(err)
		}
		if _, err := tarWriter.Write([]byte(content)); err != nil {
			t.Fatal(err)
		}
	}
	if err := tarWriter.Close(); err != nil {
		t.Fatal(err)
	}
	if err := gzipWriter.Close(); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, buffer.Bytes(), 0o644); err != nil {
		t.Fatal(err)
	}
}
