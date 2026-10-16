package promptlibrary

import "errors"

var (
	// ErrNotInstalled 表示数据集数据库尚未安装，检索类接口应返回未就绪。
	ErrNotInstalled = errors.New("prompt library dataset is not installed")
	// ErrInstallerBusy 表示已有安装任务在运行。
	ErrInstallerBusy = errors.New("prompt library installer is busy")
	// ErrExternalDB 表示数据库路径来自 CANVAS_PROMPT_LIBRARY_DB 外部指定，内置安装器不覆盖。
	ErrExternalDB = errors.New("prompt library database is externally managed")
	// ErrAssetNotFound 表示请求的资产名在远端 release 里不存在。
	ErrAssetNotFound = errors.New("prompt library asset not found")
	// ErrNotFound 表示检索对象（tweet/图片）不存在。
	ErrNotFound = errors.New("prompt library record not found")
	// ErrPackMissing 表示对应图片包尚未下载，本地没有该文件。
	ErrPackMissing = errors.New("prompt library image pack is not installed")
	// ErrUnavailable 表示远端 GitHub Releases 暂时不可达。
	ErrUnavailable = errors.New("prompt library remote is unavailable")
)
