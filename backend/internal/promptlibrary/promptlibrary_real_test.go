package promptlibrary

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// TestRealDataset 由 CANVAS_PROMPT_LIBRARY_REAL_DB 指向真实数据集的 prompts.db
// 时启用（CI 不跑）：验证官方数据集 schema 变化没有破坏检索层，以及不含
// sqlite_fts5 构建标签的驱动可以正常读取带 FTS5 虚表的库。
func TestRealDataset(t *testing.T) {
	realDB := strings.TrimSpace(os.Getenv("CANVAS_PROMPT_LIBRARY_REAL_DB"))
	if realDB == "" {
		t.Skip("CANVAS_PROMPT_LIBRARY_REAL_DB 未设置，跳过真实数据集验证")
	}
	if _, err := os.Stat(realDB); err != nil {
		t.Fatalf("真实数据集不存在: %v", err)
	}
	dataDir := t.TempDir()
	root := filepath.Join(dataDir, "prompt-library")
	if err := os.MkdirAll(root, 0o755); err != nil {
		t.Fatal(err)
	}
	service, err := Open(Options{DataDir: dataDir, DBPath: realDB})
	if err != nil {
		t.Fatal(err)
	}
	defer service.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()

	page, err := service.Search(ctx, SearchParams{Query: "cyberpunk", PageSize: 10})
	if err != nil {
		t.Fatalf("英文检索失败: %v", err)
	}
	if len(page.Items) == 0 {
		t.Fatal("英文检索应命中真实数据")
	}
	t.Logf("cyberpunk 命中 %d 条，示例 author=%s tool=%s images=%d", page.Total, page.Items[0].Author, page.Items[0].Tool, page.Items[0].ImageCount)

	chinese, err := service.Search(ctx, SearchParams{Query: "赛博朋克", PageSize: 10})
	if err != nil {
		t.Fatalf("中文检索失败: %v", err)
	}
	if len(chinese.Items) == 0 {
		t.Fatal("中文（zh-Hans 翻译）检索应命中真实数据")
	}

	labels, err := service.Labels(ctx)
	if err != nil {
		t.Fatalf("标签清单失败: %v", err)
	}
	if len(labels) != 185 {
		t.Fatalf("oip-visual-v2 应有 185 个标签，实际 %d", len(labels))
	}
	if len(page.Items[0].Tags) == 0 && page.Items[0].ImageCount == 0 {
		t.Fatal("结果应带标签或图片")
	}
	detail, err := service.Detail(ctx, page.Items[0].TweetID)
	if err != nil {
		t.Fatalf("详情失败: %v", err)
	}
	t.Logf("详情 %s: 图片 %d, 标签 %d, 翻译长度 %d", detail.TweetID, detail.ImageCount, len(detail.Tags), len(detail.TranslationZh))
	// 图片包未下载时应报 ErrPackMissing 而不是崩溃。
	if detail.ImageCount > 0 {
		if _, err := service.ImageFile(ctx, detail.TweetID, 1); err != ErrPackMissing {
			t.Logf("图片文件状态: %v（未下载包时预期 ErrPackMissing）", err)
		}
	}
}

// TestRealInstall 由 CANVAS_PROMPT_LIBRARY_REAL_ARCHIVE 指向一份完整的
// prompts.db.gz 时启用：把归档种子成 .part，走完整安装链路（校验→解压→
// 换库→重开→状态就绪），验证安装器除 HTTP 字节流以外的全部环节。
func TestRealInstall(t *testing.T) {
	archive := strings.TrimSpace(os.Getenv("CANVAS_PROMPT_LIBRARY_REAL_ARCHIVE"))
	if archive == "" {
		t.Skip("CANVAS_PROMPT_LIBRARY_REAL_ARCHIVE 未设置，跳过真实安装链路验证")
	}
	dataDir := t.TempDir()
	root := filepath.Join(dataDir, "prompt-library")
	downloads := filepath.Join(root, "downloads")
	if err := os.MkdirAll(downloads, 0o755); err != nil {
		t.Fatal(err)
	}
	// 用本地已下载的归档充当 .part：downloadAsset 检测到分片完整后跳过网络。
	seed, err := os.ReadFile(archive)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(downloads, dbAssetName+".part"), seed, 0o644); err != nil {
		t.Fatal(err)
	}
	service, err := Open(Options{DataDir: dataDir})
	if err != nil {
		t.Fatal(err)
	}
	defer service.Close()
	if err := service.Install("db"); err != nil {
		t.Fatalf("启动安装失败: %v", err)
	}
	// 数据集每天多次发版且本机网络可能很慢（停滞看门狗会断点续传重试）：
	// 预留 30 分钟，并用 `go test -timeout 35m` 运行。
	deadline := time.Now().Add(30 * time.Minute)
	for {
		info := service.Status(context.Background())
		if !info.Progress.Running {
			if info.Progress.Message != "" {
				t.Fatalf("安装失败: %s", info.Progress.Message)
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("安装超时")
		}
		time.Sleep(500 * time.Millisecond)
	}
	info := service.Status(context.Background())
	if !info.Available || info.PromptCount < 20000 {
		t.Fatalf("安装后状态异常: available=%v prompts=%d", info.Available, info.PromptCount)
	}
	if info.DBInstalled == nil || info.DBInstalled.Tag == "" {
		t.Fatalf("安装账本缺失: %+v", info.DBInstalled)
	}
	if _, err := service.Search(context.Background(), SearchParams{Query: "watercolor", PageSize: 5}); err != nil {
		t.Fatalf("安装后检索失败: %v", err)
	}
}
