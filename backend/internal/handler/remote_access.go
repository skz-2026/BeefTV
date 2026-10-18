package handler

import (
	"github.com/gin-gonic/gin"

	"infinite-canvas/backend/internal/remoteaccess"
)

// RegisterRemoteAccessRoutes exposes the address a phone can open. It reports
// local Tailscale state only; the actual traffic never passes through here.
func RegisterRemoteAccessRoutes(r *gin.RouterGroup) {
	r.GET("/remote/access", func(c *gin.Context) {
		ok(c, remoteaccess.Look(c.Request.Context()))
	})
}
