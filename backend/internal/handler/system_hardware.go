package handler

import (
	"infinite-canvas/backend/internal/app"
	"infinite-canvas/backend/internal/systemstats"

	"github.com/gin-gonic/gin"
)

// RegisterSystemHardwareRoutes 暴露本机硬件遥测快照（CPU/内存/GPU/磁盘/热区），
// 供画布硬件监控浮窗低频轮询；只读采集，不落数据库。
func RegisterSystemHardwareRoutes(r *gin.RouterGroup, svc *app.Service) {
	collector := systemstats.NewCollector()
	r.GET("/system/hardware", func(c *gin.Context) {
		if _, err := currentUser(c, svc); err != nil {
			failService(c, err)
			return
		}
		ok(c, collector.Snapshot(c.Request.Context()))
	})
}
