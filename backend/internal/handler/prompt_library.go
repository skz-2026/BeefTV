package handler

import (
	"errors"
	"net/http"
	"strconv"
	"strings"

	"infinite-canvas/backend/internal/app"
	"infinite-canvas/backend/internal/promptlibrary"

	"github.com/gin-gonic/gin"
)

// RegisterPromptLibraryRoutes 挂载提示词参考库（open-image-prompts 数据集）的
// 检索与安装接口。所有路由要求工作台用户；刻意不进入 businessPathAllowed，
// 外部 Agent 客户端不可见。数据未安装时 status 仍返回 200（页面渲染安装引导），
// 检索类接口返回 503 + prompt_library_unavailable。
func RegisterPromptLibraryRoutes(r *gin.RouterGroup, svc *app.Service, lib *promptlibrary.Service) {
	requireReady := func(c *gin.Context) (*promptlibrary.Service, bool) {
		if lib == nil {
			failReason(c, http.StatusServiceUnavailable, "prompt_library_unavailable", "提示词参考库不可用")
			return nil, false
		}
		return lib, true
	}

	r.GET("/prompt-library/status", func(c *gin.Context) {
		if _, err := currentUser(c, svc); err != nil {
			failService(c, err)
			return
		}
		if lib == nil {
			ok(c, promptlibrary.StatusInfo{Progress: promptlibrary.Progress{Message: "提示词参考库服务未启动"}})
			return
		}
		ok(c, lib.Status(c.Request.Context()))
	})

	r.POST("/prompt-library/install", func(c *gin.Context) {
		if _, err := currentUser(c, svc); err != nil {
			failService(c, err)
			return
		}
		lib, ready := requireReady(c)
		if !ready {
			return
		}
		var request struct {
			Target string `json:"target"`
		}
		if err := c.ShouldBindJSON(&request); err != nil {
			fail(c, http.StatusBadRequest, errors.New("请求体无效"))
			return
		}
		request.Target = strings.TrimSpace(request.Target)
		if request.Target == "" {
			fail(c, http.StatusBadRequest, errors.New("缺少安装目标"))
			return
		}
		if err := lib.Install(request.Target); err != nil {
			failPromptLibraryError(c, err)
			return
		}
		ok(c, gin.H{"started": true, "target": request.Target})
	})

	r.GET("/prompt-library/labels", func(c *gin.Context) {
		if _, err := currentUser(c, svc); err != nil {
			failService(c, err)
			return
		}
		lib, ready := requireReady(c)
		if !ready {
			return
		}
		labels, err := lib.Labels(c.Request.Context())
		if err != nil {
			failPromptLibraryError(c, err)
			return
		}
		ok(c, gin.H{"labels": labels})
	})

	r.GET("/prompt-library/prompts", func(c *gin.Context) {
		if _, err := currentUser(c, svc); err != nil {
			failService(c, err)
			return
		}
		lib, ready := requireReady(c)
		if !ready {
			return
		}
		page, _ := strconv.Atoi(c.DefaultQuery("page", "1"))
		pageSize, _ := strconv.Atoi(c.DefaultQuery("pageSize", "24"))
		if page < 1 {
			page = 1
		}
		if pageSize < 1 || pageSize > 60 {
			pageSize = 24
		}
		var tags []string
		for _, raw := range strings.Split(c.Query("tags"), ",") {
			if trimmed := strings.TrimSpace(raw); trimmed != "" {
				tags = append(tags, trimmed)
			}
		}
		result, err := lib.Search(c.Request.Context(), promptlibrary.SearchParams{
			Query:    strings.TrimSpace(c.Query("query")),
			Tags:     tags,
			Tool:     strings.TrimSpace(c.Query("tool")),
			Author:   strings.TrimSpace(c.Query("author")),
			Page:     page,
			PageSize: pageSize,
		})
		if err != nil {
			failPromptLibraryError(c, err)
			return
		}
		ok(c, result)
	})

	r.GET("/prompt-library/prompts/:tweetId", func(c *gin.Context) {
		if _, err := currentUser(c, svc); err != nil {
			failService(c, err)
			return
		}
		lib, ready := requireReady(c)
		if !ready {
			return
		}
		detail, err := lib.Detail(c.Request.Context(), strings.TrimSpace(c.Param("tweetId")))
		if err != nil {
			failPromptLibraryError(c, err)
			return
		}
		ok(c, detail)
	})

	r.GET("/prompt-library/images/:tweetId/:index/file", func(c *gin.Context) {
		if _, err := currentUser(c, svc); err != nil {
			failService(c, err)
			return
		}
		lib, ready := requireReady(c)
		if !ready {
			return
		}
		index, err := strconv.Atoi(c.Param("index"))
		if err != nil || index < 0 {
			fail(c, http.StatusBadRequest, errors.New("图片序号无效"))
			return
		}
		path, err := lib.ImageFile(c.Request.Context(), strings.TrimSpace(c.Param("tweetId")), index)
		if err != nil {
			failPromptLibraryError(c, err)
			return
		}
		c.Header("Cache-Control", "private, max-age=86400, stale-while-revalidate=604800")
		c.Header("X-Content-Type-Options", "nosniff")
		c.File(path)
	})
}

func failPromptLibraryError(c *gin.Context, err error) {
	switch {
	case errors.Is(err, promptlibrary.ErrNotInstalled):
		failReason(c, http.StatusServiceUnavailable, "prompt_library_unavailable", "提示词参考库数据未安装")
	case errors.Is(err, promptlibrary.ErrInstallerBusy):
		failReason(c, http.StatusConflict, "prompt_library_installer_busy", "已有安装任务进行中")
	case errors.Is(err, promptlibrary.ErrExternalDB):
		failReason(c, http.StatusBadRequest, "prompt_library_external_db", "数据库由 CANVAS_PROMPT_LIBRARY_DB 外部指定，内置安装器不覆盖")
	case errors.Is(err, promptlibrary.ErrAssetNotFound):
		failReason(c, http.StatusNotFound, "prompt_library_asset_not_found", "远端没有这个资产")
	case errors.Is(err, promptlibrary.ErrNotFound):
		failReason(c, http.StatusNotFound, "prompt_library_record_not_found", "记录不存在")
	case errors.Is(err, promptlibrary.ErrPackMissing):
		failReason(c, http.StatusNotFound, "prompt_library_image_pack_missing", "对应月份的图片包尚未下载")
	case errors.Is(err, promptlibrary.ErrUnavailable):
		failReason(c, http.StatusBadGateway, "prompt_library_remote_unavailable", "GitHub Releases 暂时不可达，请稍后重试")
	default:
		fail(c, http.StatusInternalServerError, err)
	}
}

func failReason(c *gin.Context, status int, reason string, message string) {
	c.JSON(status, gin.H{"code": status, "data": nil, "msg": message, "reason": reason})
}
