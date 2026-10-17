package handler

import (
	"net/http"

	"github.com/gin-gonic/gin"

	"infinite-canvas/backend/internal/app"
)

// RegisterDesktopMotionTemplateRoutes 挂载本地动效模板的导入与列表端点。
func RegisterDesktopMotionTemplateRoutes(r *gin.RouterGroup, svc *app.Service) {
	r.POST("/motion-templates", func(c *gin.Context) {
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, app.MotionTemplateUploadMaxBytes)
		file, err := c.FormFile("file")
		if err != nil {
			failService(c, app.BadAuthRequest("请选择 .motion 模板包（ZIP）"))
			return
		}
		summary, err := svc.ImportMotionTemplate(user.ID, file)
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, gin.H{"template": summary})
	})
	r.GET("/motion-templates", func(c *gin.Context) {
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		templates, err := svc.ListMotionTemplates(user.ID)
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, gin.H{"templates": templates})
	})
}
