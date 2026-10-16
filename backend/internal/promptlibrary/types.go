// Package promptlibrary 以只读方式接入 open-image-prompts 公共数据集
// (https://github.com/NanmiCoder/open-image-prompts)：SQLite 检索 + 本地图片包，
// 数据通过 GitHub Releases 安装到数据目录，不进入主库、不参与 schema 迁移。
package promptlibrary

import "time"

// TagInfo 是一条提示词命中的受控标签（taxonomy_labels 维度下的双语显示名）。
type TagInfo struct {
	Dimension  string  `json:"dimension"`
	Key        string  `json:"key"`
	DisplayEn  string  `json:"displayEn"`
	DisplayZh  string  `json:"displayZh"`
	Confidence float64 `json:"confidence"`
}

// LabelInfo 是标签筛选面板用的一条可选标签。
type LabelInfo struct {
	Dimension string `json:"dimension"`
	Key       string `json:"key"`
	DisplayEn string `json:"displayEn"`
	DisplayZh string `json:"displayZh"`
}

// ImageInfo 是提示词对应的单张成图记录；LocalReady 表示图片包文件已就位。
type ImageInfo struct {
	TweetID    string `json:"tweetId"`
	Index      int    `json:"index"`
	URL        string `json:"url"`
	LocalPath  string `json:"localPath"`
	LocalReady bool   `json:"localReady"`
}

// PromptSummary 是检索结果条目（列表与详情共用）。
type PromptSummary struct {
	TweetID       string      `json:"tweetId"`
	Author        string      `json:"author"`
	Tool          string      `json:"tool"`
	PromptText    string      `json:"promptText"`
	TranslationZh string      `json:"translationZh"`
	TweetURL      string      `json:"tweetUrl"`
	CreatedAt     string      `json:"createdAt"`
	ImageCount    int         `json:"imageCount"`
	Images        []ImageInfo `json:"images"`
	Tags          []TagInfo   `json:"tags"`
	RecipeEn      string      `json:"recipeEn,omitempty"`
	RecipeZh      string      `json:"recipeZh,omitempty"`
}

// SearchParams 是检索入参；Tags 为 "dimension:key" 列表，多标签取交集。
type SearchParams struct {
	Query    string
	Tags     []string
	Tool     string
	Author   string
	Page     int
	PageSize int
}

// SearchPage 是分页结果。
type SearchPage struct {
	Items    []PromptSummary `json:"items"`
	Page     int             `json:"page"`
	PageSize int             `json:"pageSize"`
	Total    int             `json:"total"`
	HasMore  bool            `json:"hasMore"`
}

// Progress 是安装器的内存态进度（轮询读取，不持久化）。
type Progress struct {
	Running    bool   `json:"running"`
	Phase      string `json:"phase"` // checking | downloading | verifying | extracting
	Target     string `json:"target"`
	Bytes      int64  `json:"bytes"`
	TotalBytes int64  `json:"totalBytes"`
	Message    string `json:"message,omitempty"`
	UpdatedAt  string `json:"updatedAt,omitempty"`
}

// RemoteAsset 是 GitHub Releases 上的一个可安装资产。
type RemoteAsset struct {
	Name     string `json:"name"`
	Tag      string `json:"tag"`
	AssetID  int64  `json:"assetId"`
	Size     int64  `json:"size"`
	SHA256   string `json:"sha256"`
	HTMLURL  string `json:"htmlUrl,omitempty"`
	Uploaded string `json:"uploaded,omitempty"`
}

// Valid 表示远端资产信息完整（含可校验的 sha256）。
func (a RemoteAsset) Valid() bool {
	return a.Name != "" && a.AssetID != 0 && a.Size > 0 && isHex64(a.SHA256)
}

// PackState 是一个月度图片包的安装状态。
type PackState struct {
	Name        string `json:"name"`
	Size        int64  `json:"size"`
	SHA256      string `json:"sha256"`
	Tag         string `json:"tag"`
	Installed   bool   `json:"installed"`
	InstalledAt string `json:"installedAt,omitempty"`
	Outdated    bool   `json:"outdated"` // 远端同名包已换构建（sha 变化）
}

// InstalledDB 记录当前数据库资产来源。
type InstalledDB struct {
	Tag         string `json:"tag"`
	SHA256      string `json:"sha256"`
	Size        int64  `json:"size"`
	InstalledAt string `json:"installedAt"`
}

// StatusInfo 是 GET /api/prompt-library/status 的载荷；未安装时 Available=false
// 但仍返回远端资产清单，供页面渲染安装入口。
type StatusInfo struct {
	Available        bool         `json:"available"`
	External         bool         `json:"external"` // CANVAS_PROMPT_LIBRARY_DB 指定的外部库，禁止内置安装器覆盖
	DBPath           string       `json:"dbPath,omitempty"`
	DatasetTag       string       `json:"datasetTag,omitempty"`
	TaxonomyVersion  string       `json:"taxonomyVersion,omitempty"`
	PromptCount      int64        `json:"promptCount"`
	ImageCount       int64        `json:"imageCount"`
	TranslationCount int64        `json:"translationCount"`
	DB               *RemoteAsset `json:"db,omitempty"`
	DBInstalled      *InstalledDB `json:"dbInstalled,omitempty"`
	DBUpdate         bool         `json:"dbUpdate"`
	Packs            []PackState  `json:"packs"`
	Progress         Progress     `json:"progress"`
	RemoteError      string       `json:"remoteError,omitempty"`
	CheckedAt        string       `json:"checkedAt,omitempty"`
}

// installMeta 是落盘的安装账本（meta.json），记录资产 sha 与安装时间。
type installMeta struct {
	DB      *InstalledDB           `json:"db,omitempty"`
	Packs   map[string]InstalledDB `json:"packs,omitempty"`
	SavedAt time.Time              `json:"savedAt"`
}
