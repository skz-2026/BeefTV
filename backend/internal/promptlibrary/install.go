package promptlibrary

import (
	"archive/tar"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"infinite-canvas/backend/internal/desktopnet"
)

// 数据集上游：open-image-prompts 的 GitHub Releases。下载走 releases/assets API
// 端点（Accept: octet-stream，302 到 release-assets 域），不依赖 github.com 直链，
// 资产对象自带 sha256 digest，无需额外的校验清单。
const (
	githubAPIBase  = "https://api.github.com"
	sourceRepoPath = "repos/NanmiCoder/open-image-prompts"
	sourceRepoURL  = "https://github.com/NanmiCoder/open-image-prompts"
	dbAssetName    = "prompts.db.gz"
	packNamePrefix = "images-"
	listCacheTTL   = 15 * time.Minute
)

type ghAsset struct {
	ID   int64  `json:"id"`
	Name string `json:"name"`
	Size int64  `json:"size"`
	// digest 形如 "sha256:<hex>"；缺失时拒绝安装而不是跳过校验。
	Digest string `json:"digest"`
}

type ghRelease struct {
	TagName string    `json:"tag_name"`
	Draft   bool      `json:"draft"`
	Created time.Time `json:"created_at"`
	Assets  []ghAsset `json:"assets"`
}

// installer 持有安装进度与互斥；同一时刻只允许一个安装任务。
type installer struct {
	mu        sync.Mutex
	running   bool
	phase     string
	target    string
	bytes     int64
	total     int64
	message   string
	updatedAt time.Time
	cancel    context.CancelFunc
}

func (i *installer) begin(target string) bool {
	i.mu.Lock()
	defer i.mu.Unlock()
	if i.running {
		return false
	}
	i.running = true
	i.phase = "checking"
	i.target = target
	i.bytes, i.total, i.message = 0, 0, ""
	i.updatedAt = time.Now()
	return true
}

func (i *installer) finish(err error) {
	i.mu.Lock()
	defer i.mu.Unlock()
	i.running = false
	i.phase = ""
	i.cancel = nil
	if err != nil {
		i.message = err.Error()
	} else {
		i.message = ""
	}
	i.updatedAt = time.Now()
}

func (i *installer) setPhase(phase string) {
	i.mu.Lock()
	defer i.mu.Unlock()
	i.phase = phase
	i.updatedAt = time.Now()
}

// setProgress 更新下载进度；total < 0 表示保持已知的总大小不变。
func (i *installer) setProgress(target string, bytes, total int64) {
	i.mu.Lock()
	defer i.mu.Unlock()
	if target != "" {
		i.target = target
	}
	i.bytes = bytes
	if total >= 0 {
		i.total = total
	}
	i.updatedAt = time.Now()
}

func (i *installer) snapshot() Progress {
	i.mu.Lock()
	defer i.mu.Unlock()
	return Progress{
		Running: i.running, Phase: i.phase, Target: i.target,
		Bytes: i.bytes, TotalBytes: i.total, Message: i.message,
		UpdatedAt: i.updatedAt.Format(time.RFC3339),
	}
}

func (i *installer) cancelRunning() {
	i.mu.Lock()
	defer i.mu.Unlock()
	if i.cancel != nil {
		i.cancel()
	}
}

// listRemoteAssetsForce 安装前强制刷新远端清单（绕过缓存），确保拿到最新 digest。
func (s *Service) listRemoteAssetsForce(ctx context.Context) (RemoteAsset, []RemoteAsset, error) {
	return s.fetchAndCacheRemote(ctx)
}

func remoteAsset(release ghRelease, asset ghAsset) (RemoteAsset, bool) {
	digest := strings.TrimPrefix(asset.Digest, "sha256:")
	if asset.ID == 0 || asset.Size <= 0 || !isHex64(digest) {
		return RemoteAsset{}, false
	}
	return RemoteAsset{
		Name: asset.Name, Tag: release.TagName, AssetID: asset.ID,
		Size: asset.Size, SHA256: digest, HTMLURL: sourceRepoURL + "/releases/tag/" + release.TagName,
		Uploaded: release.Created.Format(time.RFC3339),
	}, true
}

func isHex64(value string) bool {
	if len(value) != 64 {
		return false
	}
	_, err := hex.DecodeString(value)
	return err == nil
}

func fetchReleases(ctx context.Context) ([]ghRelease, error) {
	listCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(listCtx, http.MethodGet, githubAPIBase+"/"+sourceRepoPath+"/releases?per_page=100", nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("User-Agent", "BeefTV-PromptLibrary")
	resp, err := installHTTPClient().Do(req)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrUnavailable, err)
	}
	defer resp.Body.Close()
	if resp.TLS == nil {
		return nil, fmt.Errorf("%w: 非加密上游", ErrUnavailable)
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("%w: GitHub API 状态 %d", ErrUnavailable, resp.StatusCode)
	}
	var releases []ghRelease
	if err := json.NewDecoder(io.LimitReader(resp.Body, 8<<20)).Decode(&releases); err != nil {
		return nil, fmt.Errorf("%w: %v", ErrUnavailable, err)
	}
	return releases, nil
}

var installClientOnce sync.Once
var installClientValue *http.Client

func installHTTPClient() *http.Client {
	installClientOnce.Do(func() {
		transport := http.DefaultTransport.(*http.Transport).Clone()
		transport.Proxy = desktopnet.Proxy
		transport.TLSHandshakeTimeout = 15 * time.Second
		transport.ResponseHeaderTimeout = 30 * time.Second
		installClientValue = &http.Client{
			Transport: transport,
			CheckRedirect: func(req *http.Request, via []*http.Request) error {
				if len(via) >= 5 {
					return errors.New("重定向次数过多")
				}
				if req.URL == nil || req.URL.Scheme != "https" || req.URL.Host == "" {
					return fmt.Errorf("%w: 非加密下载地址", ErrUnavailable)
				}
				return nil
			},
		}
	})
	return installClientValue
}

// Install 启动一次安装/更新任务（异步执行，进度经 Status 轮询）。
// target 为 "db"、具体图片包名（images-YYYY-MM.tar.gz）或 "packs"（全部图片包）。
func (s *Service) Install(target string) error {
	if target == "db" && s.external {
		return ErrExternalDB
	}
	if !s.installer.begin(target) {
		return ErrInstallerBusy
	}
	ctx, cancel := context.WithCancel(context.Background())
	s.installer.mu.Lock()
	s.installer.cancel = cancel
	s.installer.mu.Unlock()
	go func() {
		defer cancel()
		s.installer.finish(s.runInstall(ctx, target))
	}()
	return nil
}

func (s *Service) runInstall(ctx context.Context, target string) error {
	db, packs, err := s.listRemoteAssetsForce(ctx)
	if err != nil {
		return err
	}
	switch target {
	case "db":
		if db.Name == "" {
			return fmt.Errorf("%w: 远端没有数据库资产", ErrAssetNotFound)
		}
		return s.installDB(ctx, db)
	case "packs":
		for _, pack := range packs {
			if err := s.installPack(ctx, pack); err != nil {
				return err
			}
		}
		return nil
	default:
		for _, pack := range packs {
			if pack.Name == target {
				return s.installPack(ctx, pack)
			}
		}
		return fmt.Errorf("%w: %s", ErrAssetNotFound, target)
	}
}

func (s *Service) installDB(ctx context.Context, asset RemoteAsset) error {
	if s.external {
		return ErrExternalDB
	}
	if meta := s.installedMeta(); meta.DB != nil && meta.DB.SHA256 == asset.SHA256 && fileExists(s.dbPath) {
		return nil // 已是同一构建
	}
	archive, err := s.downloadAsset(ctx, asset)
	if err != nil {
		return err
	}
	s.installer.setPhase("extracting")
	tmp := s.dbPath + ".tmp"
	if err := gunzipToFile(archive, tmp); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	if err := verifySQLiteFile(tmp); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	// Windows 上覆盖已打开的数据库文件会失败：先关旧连接、换文件、再重开。
	s.mu.Lock()
	if s.db != nil {
		_ = s.db.Close()
		s.db = nil
	}
	s.mu.Unlock()
	_ = os.Remove(s.dbPath)
	if err := os.Rename(tmp, s.dbPath); err != nil {
		return err
	}
	_ = os.Remove(archive)
	next := s.installedMeta()
	next.DB = &InstalledDB{Tag: asset.Tag, SHA256: asset.SHA256, Size: asset.Size, InstalledAt: time.Now().Format(time.RFC3339)}
	if err := s.saveMeta(next); err != nil {
		return err
	}
	_, err = s.reload()
	return err
}

func (s *Service) installPack(ctx context.Context, asset RemoteAsset) error {
	if meta := s.installedMeta(); meta.Packs != nil {
		if installed, ok := meta.Packs[asset.Name]; ok && installed.SHA256 == asset.SHA256 {
			return nil // 已是同一构建
		}
	}
	archive, err := s.downloadAsset(ctx, asset)
	if err != nil {
		return err
	}
	s.installer.setPhase("extracting")
	if _, err := extractPack(archive, s.dataRoot); err != nil {
		return err
	}
	_ = os.Remove(archive)
	next := s.installedMeta()
	if next.Packs == nil {
		next.Packs = map[string]InstalledDB{}
	}
	next.Packs[asset.Name] = InstalledDB{Tag: asset.Tag, SHA256: asset.SHA256, Size: asset.Size, InstalledAt: time.Now().Format(time.RFC3339)}
	return s.saveMeta(next)
}

// downloadAsset 下载到 downloads/<name>.part（支持断点续传），完成后校验 sha256
// 并把 .part 原子改名为 downloads/<name>。下载停滞或网络中断时保留 .part，
// 最多重试 downloadMaxAttempts 次，每次用 Range 从断点继续。
const downloadMaxAttempts = 8

func (s *Service) downloadAsset(ctx context.Context, asset RemoteAsset) (string, error) {
	if err := os.MkdirAll(filepath.Join(s.dataRoot, "downloads"), 0o755); err != nil {
		return "", err
	}
	part := filepath.Join(s.dataRoot, "downloads", asset.Name+".part")
	have, err := partialSize(part, asset.Size)
	if err != nil {
		return "", err
	}
	url := fmt.Sprintf("%s/%s/releases/assets/%d", githubAPIBase, sourceRepoPath, asset.AssetID)
	// freshVerifyFails 统计“全新下载仍校验失败”的次数：续传拼接失败（远端换了
	// 构建）只需清空重下一次；全新下载连续两次校验不过才是真异常。
	freshVerifyFails := 0
	for attempt := 0; attempt < downloadMaxAttempts; attempt++ {
		var size int64
		if have >= asset.Size {
			// .part 已完整（上次中断在校验/解压阶段）：跳过下载直接校验。
			size = have
			s.installer.setProgress(asset.Name, have, asset.Size)
		} else {
			var restarted bool
			size, restarted, err = s.fetchAssetRange(ctx, asset, url, part, have)
			if err != nil {
				if ctx.Err() != nil {
					return "", ctx.Err()
				}
				if size <= 0 || size < have {
					return "", err
				}
				// 停滞或网络中断：保留断点，稍候重试。
				have = size
				s.installer.setProgress("", have, -1)
				select {
				case <-ctx.Done():
					return "", ctx.Err()
				case <-time.After(3 * time.Second):
				}
				continue
			}
			have = size
			_ = restarted
		}
		s.installer.setPhase("verifying")
		ok, verifyErr := verifyFileSHA256(part, asset.SHA256)
		if verifyErr == nil && ok {
			dest := filepath.Join(s.dataRoot, "downloads", asset.Name)
			_ = os.Remove(dest)
			if err := os.Rename(part, dest); err != nil {
				return "", err
			}
			return dest, nil
		}
		_ = os.Remove(part)
		if verifyErr == nil {
			verifyErr = errors.New("下载内容校验失败")
		}
		freshVerifyFails++
		if freshVerifyFails >= 2 {
			return "", verifyErr
		}
		have = 0
	}
	return "", fmt.Errorf("%w: 下载多次中断未完成", ErrUnavailable)
}

// fetchAssetRange 从 offset 续传到 .part；服务器忽略 Range 时清空重写。
// 带读停滞看门狗：CDN 连接无错误但长时间无字节时主动断开，保留 .part 供
// 下一次断点续传。返回最终文件大小与本次是否从零重启。
func (s *Service) fetchAssetRange(ctx context.Context, asset RemoteAsset, url, part string, offset int64) (int64, bool, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return 0, false, err
	}
	req.Header.Set("Accept", "application/octet-stream")
	req.Header.Set("User-Agent", "BeefTV-PromptLibrary")
	if offset > 0 {
		req.Header.Set("Range", fmt.Sprintf("bytes=%d-", offset))
	}
	resp, err := installHTTPClient().Do(req)
	if err != nil {
		return 0, false, err
	}
	defer resp.Body.Close()
	if resp.TLS == nil {
		return 0, false, fmt.Errorf("%w: 非加密下载地址", ErrUnavailable)
	}
	restarted := false
	switch {
	case resp.StatusCode == http.StatusPartialContent && offset > 0:
		// 续传命中
	case resp.StatusCode == http.StatusOK:
		offset = 0
		restarted = true
	default:
		return 0, false, fmt.Errorf("%w: 下载状态 %d", ErrUnavailable, resp.StatusCode)
	}
	flags := os.O_WRONLY | os.O_CREATE
	if restarted {
		flags |= os.O_TRUNC
	} else {
		flags |= os.O_APPEND
	}
	file, err := os.OpenFile(part, flags, 0o644)
	if err != nil {
		return 0, false, err
	}
	total := offset + resp.ContentLength
	s.installer.setPhase("downloading")
	s.installer.setProgress(asset.Name, offset, total)
	counter := &countingWriter{offset: offset, installer: &s.installer, target: asset.Name}
	watch := newStallWatchdog(counter, resp.Body, downloadStallTimeout)
	_, err = io.Copy(file, io.TeeReader(resp.Body, counter))
	watch.stop()
	closeErr := file.Close()
	if err != nil {
		// 停滞/网络中断：.part 保留已写字节，下一次调用用 Range 续传。
		return counter.offset, restarted, fmt.Errorf("下载中断（已保留 %.1f MB）: %w", float64(counter.offset)/1048576, err)
	}
	if closeErr != nil {
		return counter.offset, false, closeErr
	}
	return counter.offset, restarted, nil
}

// downloadStallTimeout 是读停滞判定：连续这么久没有收到任何字节即断开重试。
const downloadStallTimeout = 30 * time.Second

// stallWatchdog 监视计数器；超时没有新字节时关闭响应体，让阻塞中的 Read 返回错误。
type stallWatchdog struct {
	done chan struct{}
}

func newStallWatchdog(counter *countingWriter, body io.Closer, timeout time.Duration) *stallWatchdog {
	watch := &stallWatchdog{done: make(chan struct{})}
	go func() {
		ticker := time.NewTicker(5 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-watch.done:
				return
			case <-ticker.C:
				if time.Since(counter.lastReadAt()) > timeout {
					// 关闭响应体会中断传输中的 Read；.part 已写字节不受影响。
					_ = body.Close()
					return
				}
			}
		}
	}()
	return watch
}

func (w *stallWatchdog) stop() {
	select {
	case <-w.done:
	default:
		close(w.done)
	}
}

type countingWriter struct {
	offset    int64
	installer *installer
	target    string
	lastRead  atomic.Int64
}

func (w *countingWriter) Write(p []byte) (int, error) {
	w.offset += int64(len(p))
	w.lastRead.Store(time.Now().UnixNano())
	w.installer.setProgress(w.target, w.offset, -1)
	return len(p), nil
}

func (w *countingWriter) lastReadAt() time.Time {
	nanos := w.lastRead.Load()
	if nanos == 0 {
		return time.Now()
	}
	return time.Unix(0, nanos)
}

func partialSize(path string, expected int64) (int64, error) {
	info, err := os.Stat(path)
	if err != nil {
		if os.IsNotExist(err) {
			return 0, nil
		}
		return 0, err
	}
	if info.Size() > expected {
		// 旧构建的残留分片比目标还大：丢弃重下。
		if err := os.Remove(path); err != nil {
			return 0, err
		}
		return 0, nil
	}
	return info.Size(), nil
}

func verifyFileSHA256(path, expected string) (bool, error) {
	file, err := os.Open(path)
	if err != nil {
		return false, err
	}
	defer file.Close()
	hasher := sha256.New()
	if _, err := io.Copy(hasher, file); err != nil {
		return false, err
	}
	return hex.EncodeToString(hasher.Sum(nil)) == expected, nil
}

func gunzipToFile(archive, dest string) error {
	source, err := os.Open(archive)
	if err != nil {
		return err
	}
	defer source.Close()
	reader, err := gzip.NewReader(source)
	if err != nil {
		return err
	}
	defer reader.Close()
	target, err := os.OpenFile(dest, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o644)
	if err != nil {
		return err
	}
	_, err = io.Copy(target, reader)
	closeErr := target.Close()
	if err != nil {
		return err
	}
	return closeErr
}

var sqliteHeader = []byte("SQLite format 3\x00")

func verifySQLiteFile(path string) error {
	file, err := os.Open(path)
	if err != nil {
		return err
	}
	defer file.Close()
	header := make([]byte, len(sqliteHeader))
	if _, err := io.ReadFull(file, header); err != nil {
		return fmt.Errorf("数据集解压不完整: %w", err)
	}
	if string(header) != string(sqliteHeader) {
		return errors.New("数据集解压结果不是有效的 SQLite 数据库")
	}
	return nil
}

// extractPack 流式解包图片 tar.gz。条目固定为 images/<tweet_id>/<index>.jpg 形态；
// 只接受安全的相对路径，其余一律跳过，防止路径穿越。
func extractPack(archive, dataRoot string) (int, error) {
	file, err := os.Open(archive)
	if err != nil {
		return 0, err
	}
	defer file.Close()
	gzipReader, err := gzip.NewReader(file)
	if err != nil {
		return 0, err
	}
	defer gzipReader.Close()
	reader := tar.NewReader(gzipReader)
	extracted := 0
	for {
		entry, err := reader.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return extracted, fmt.Errorf("图片包解包失败: %w", err)
		}
		if entry.Typeflag != tar.TypeReg {
			continue
		}
		name := filepath.ToSlash(entry.Name)
		if strings.HasPrefix(name, "/") || strings.Contains(name, "\\") || strings.Contains(name, ":") {
			continue
		}
		// 穿越/绝对路径检测用 POSIX 清洗（保持正斜杠），实际落盘再交给 filepath.Join。
		clean := path.Clean(name)
		if clean == "." || clean == ".." || strings.HasPrefix(clean, "../") {
			continue
		}
		if !strings.HasPrefix(clean, "images/") {
			continue
		}
		dest := filepath.Join(dataRoot, filepath.FromSlash(clean))
		if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
			return extracted, err
		}
		target, err := os.OpenFile(dest, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o644)
		if err != nil {
			return extracted, err
		}
		if _, err := io.Copy(target, reader); err != nil {
			target.Close()
			return extracted, err
		}
		if err := target.Close(); err != nil {
			return extracted, err
		}
		extracted++
	}
	return extracted, nil
}

func fileExists(path string) bool {
	info, err := os.Stat(path)
	return err == nil && !info.IsDir()
}
