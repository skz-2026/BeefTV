package promptlibrary

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	// 显式注册 sqlite3 驱动：主应用里经 gorm 传递注册，本包独立（测试/工具）运行时也必须可用。
	_ "github.com/mattn/go-sqlite3"
)

// EnvDBPath 允许用外部检出/自管理的数据集覆盖默认落盘位置；被外部指定时
// 内置安装器不再下载数据库（图片包仍可安装到同目录）。
const EnvDBPath = "CANVAS_PROMPT_LIBRARY_DB"

const (
	remoteSuccessTTL = 15 * time.Minute
	remoteFailureTTL = 30 * time.Second
)

// Options 是组合根传入的构造参数。
type Options struct {
	// DataDir 是后端主数据目录（CANVAS_BACKEND_DATA_DIR）；数据集落在
	// <DataDir>/prompt-library/ 下，符合“用户数据不进安装包”的约定。
	DataDir string
	// DBPath 显式指定数据库文件（测试/外部部署用）；设置后等同外部管理，
	// 内置安装器不再下载数据库，图片包仍安装到同级 prompt-library 目录。
	DBPath string
}

// Service 是提示词参考库的只读检索 + 数据集安装服务。
type Service struct {
	dataRoot string
	dbPath   string
	external bool

	mu   sync.RWMutex
	db   *sql.DB
	meta installMeta
	// openErr 记录启动期数据库打开失败的原因（成功重开后清零），
	// 让 Status 能解释“文件存在但不可用”。
	openErr error
	// taxonomyVersion 是 activeTaxonomyVersion 的连接级缓存，换库后清零。
	taxonomyVersion string

	installer installer

	remoteMu       sync.Mutex
	remoteDB       RemoteAsset
	remotePacks    []RemoteAsset
	remoteErrs     []error
	remoteOKAt     time.Time
	remoteFailedAt time.Time
}

// Open 构造服务。数据库未安装不算错误：返回可用服务，检索接口返回
// ErrNotInstalled，由页面引导安装。
func Open(opts Options) (*Service, error) {
	root := filepath.Join(opts.DataDir, "prompt-library")
	dbPath := filepath.Join(root, "prompts.db")
	external := false
	if env := strings.TrimSpace(os.Getenv(EnvDBPath)); env != "" {
		dbPath = env
		root = filepath.Dir(dbPath)
		external = true
	} else if opts.DBPath != "" {
		dbPath = opts.DBPath
		root = filepath.Dir(dbPath)
		external = true
	}
	if err := os.MkdirAll(root, 0o755); err != nil {
		return nil, err
	}
	service := &Service{dataRoot: root, dbPath: dbPath, external: external}
	service.meta = loadMeta(service.metaPath())
	if fileExists(dbPath) {
		if _, err := service.reload(); err != nil {
			// 损坏/锁定等打开失败不阻断启动：保留服务实例，状态里报告不可用。
			service.openErr = err
		}
	}
	return service, nil
}

// reload 打开（或替换）只读数据库连接，返回新连接。
func (s *Service) reload() (*sql.DB, error) {
	dsn := "file:" + filepath.ToSlash(s.dbPath) + "?mode=ro&_busy_timeout=5000"
	db, err := sql.Open("sqlite3", dsn)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(4)
	db.SetMaxIdleConns(2)
	if err := db.Ping(); err != nil {
		_ = db.Close()
		return nil, err
	}
	s.mu.Lock()
	previous := s.db
	s.db = db
	s.taxonomyVersion = ""
	if s.openErr != nil {
		s.openErr = nil
	}
	s.mu.Unlock()
	if previous != nil {
		_ = previous.Close()
	}
	return db, nil
}

// Close 取消进行中的安装任务并关闭数据库连接。
func (s *Service) Close() error {
	s.installer.cancelRunning()
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.db != nil {
		err := s.db.Close()
		s.db = nil
		return err
	}
	return nil
}

// DataRoot 暴露数据集根目录（测试与诊断用）。
func (s *Service) DataRoot() string { return s.dataRoot }

// External 表示数据库路径来自环境变量指定。
func (s *Service) External() bool { return s.external }

func (s *Service) metaPath() string { return filepath.Join(s.dataRoot, "meta.json") }

func (s *Service) installedMeta() installMeta {
	s.mu.RLock()
	defer s.mu.RUnlock()
	meta := installMeta{DB: s.meta.DB, SavedAt: s.meta.SavedAt}
	if s.meta.Packs != nil {
		meta.Packs = make(map[string]InstalledDB, len(s.meta.Packs))
		for name, value := range s.meta.Packs {
			meta.Packs[name] = value
		}
	}
	return meta
}

func (s *Service) saveMeta(meta installMeta) error {
	meta.SavedAt = time.Now()
	data, err := json.MarshalIndent(meta, "", "  ")
	if err != nil {
		return err
	}
	tmp := s.metaPath() + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	if err := os.Rename(tmp, s.metaPath()); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	s.mu.Lock()
	s.meta = meta
	s.mu.Unlock()
	return nil
}

func loadMeta(path string) installMeta {
	meta := installMeta{}
	data, err := os.ReadFile(path)
	if err != nil {
		return meta
	}
	// 账本损坏时按未安装处理，让安装器重建。
	_ = json.Unmarshal(data, &meta)
	return meta
}

// Status 聚合本地安装状态、库内计数与远端资产清单。远端不可达只降级为
// RemoteError 提示，不影响本地部分。
func (s *Service) Status(ctx context.Context) StatusInfo {
	s.mu.RLock()
	dbOpen := s.db != nil
	openErrValue := s.openErr
	s.mu.RUnlock()
	info := StatusInfo{
		Available: dbOpen,
		External:  s.external,
		DBPath:    s.dbPath,
		Progress:  s.installer.snapshot(),
	}
	meta := s.installedMeta()
	if meta.DB != nil {
		info.DBInstalled = meta.DB
		info.DatasetTag = meta.DB.Tag
	}
	if dbOpen {
		// 本地读取不受请求取消影响：状态接口要在客户端断开时也能给出完整本地事实。
		localCtx := context.WithoutCancel(ctx)
		if counts, err := s.counts(localCtx); err == nil {
			info.PromptCount, info.ImageCount, info.TranslationCount = counts.prompts, counts.images, counts.translations
		}
		if version, err := s.activeTaxonomyVersion(localCtx); err == nil {
			info.TaxonomyVersion = version
		}
	} else if openErrValue != nil {
		info.RemoteError = openErrValue.Error()
	}
	remoteCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	db, packs, err := s.listRemoteAssetsCached(remoteCtx)
	if err != nil {
		if info.RemoteError == "" {
			info.RemoteError = err.Error()
		}
	} else {
		if db.Name != "" {
			info.DB = &db
			info.DBUpdate = !s.external && (meta.DB == nil || meta.DB.SHA256 != db.SHA256)
		}
		for _, pack := range packs {
			state := PackState{Name: pack.Name, Size: pack.Size, SHA256: pack.SHA256, Tag: pack.Tag}
			if installed, ok := meta.Packs[pack.Name]; ok {
				state.Installed = installed.SHA256 == pack.SHA256
				state.InstalledAt = installed.InstalledAt
				state.Outdated = installed.SHA256 != pack.SHA256
			}
			info.Packs = append(info.Packs, state)
		}
	}
	info.CheckedAt = time.Now().Format(time.RFC3339)
	return info
}

// listRemoteAssetsCached 只读缓存；force 变体用于安装前强制刷新。
func (s *Service) listRemoteAssetsCached(ctx context.Context) (RemoteAsset, []RemoteAsset, error) {
	s.remoteMu.Lock()
	if !s.remoteOKAt.IsZero() && time.Since(s.remoteOKAt) < remoteSuccessTTL {
		db, packs := s.remoteDB, s.remotePacks
		s.remoteMu.Unlock()
		return db, packs, nil
	}
	if !s.remoteFailedAt.IsZero() && time.Since(s.remoteFailedAt) < remoteFailureTTL && len(s.remoteErrs) > 0 {
		errs := s.remoteErrs
		s.remoteMu.Unlock()
		return RemoteAsset{}, nil, errors.Join(errs...)
	}
	s.remoteMu.Unlock()
	return s.fetchAndCacheRemote(ctx)
}

func (s *Service) fetchAndCacheRemote(ctx context.Context) (RemoteAsset, []RemoteAsset, error) {
	s.remoteMu.Lock()
	defer s.remoteMu.Unlock()
	releases, err := fetchReleases(ctx)
	if err != nil {
		s.remoteErrs = []error{err}
		s.remoteFailedAt = time.Now()
		return RemoteAsset{}, nil, err
	}
	db, packs := parseReleases(releases)
	s.remoteDB, s.remotePacks, s.remoteErrs = db, packs, nil
	s.remoteOKAt, s.remoteFailedAt = time.Now(), time.Time{}
	return db, packs, nil
}

func parseReleases(releases []ghRelease) (RemoteAsset, []RemoteAsset) {
	db := RemoteAsset{}
	var packs []RemoteAsset
	packSeen := map[string]bool{}
	for _, release := range releases {
		if release.Draft {
			continue
		}
		for _, asset := range release.Assets {
			parsed, ok := remoteAsset(release, asset)
			if !ok {
				continue
			}
			switch {
			case asset.Name == dbAssetName && db.Name == "":
				db = parsed
			case strings.HasPrefix(asset.Name, packNamePrefix) && strings.HasSuffix(asset.Name, ".tar.gz") && !packSeen[asset.Name]:
				packs = append(packs, parsed)
				packSeen[asset.Name] = true
			}
		}
	}
	return db, packs
}
