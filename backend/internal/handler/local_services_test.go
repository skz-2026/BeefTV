package handler

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
)

// 本地服务接口能拉起本机进程，只允许本机同源访问；未知服务必须 404，
// 不能因为名字拼错就返回一个"看起来成功"的空结果。
func TestLocalServiceRoutesGuardAndNaming(t *testing.T) {
	gin.SetMode(gin.TestMode)
	router := gin.New()
	api := router.Group("/api")
	// 只注册网关：ComfyUI 的启动命令依赖 CANVAS_COMFYUI_DIR，未配置时不该出现在白名单里。
	RegisterLocalServiceRoutes(api, &LocalServiceLauncher{
		specs: map[string]localServiceSpec{
			localServiceGateway: {name: localServiceGateway, port: 1},
		},
	})

	do := func(method, path, remote, origin string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, "http://127.0.0.1:18080"+path, nil)
		req.Host = "127.0.0.1:18080"
		req.RemoteAddr = remote
		if origin != "" {
			req.Header.Set("Origin", origin)
		}
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		return rec
	}

	t.Run("non loopback caller is refused", func(t *testing.T) {
		rec := do(http.MethodPost, "/api/local-services/video-stack/start", "10.0.0.9:5555", "")
		if rec.Code != http.StatusForbidden {
			t.Fatalf("status=%d want 403 body=%s", rec.Code, rec.Body.String())
		}
	})

	t.Run("cross origin from another loopback port is refused", func(t *testing.T) {
		rec := do(http.MethodGet, "/api/local-services/video-stack", "127.0.0.1:5555", "http://127.0.0.1:3000")
		if rec.Code != http.StatusForbidden {
			t.Fatalf("status=%d want 403 body=%s", rec.Code, rec.Body.String())
		}
	})

	t.Run("same origin reports gateway status", func(t *testing.T) {
		rec := do(http.MethodGet, "/api/local-services/video-stack", "127.0.0.1:5555", "http://127.0.0.1:18080")
		if rec.Code != http.StatusOK {
			t.Fatalf("status=%d want 200 body=%s", rec.Code, rec.Body.String())
		}
		var payload struct {
			Data struct {
				Running bool `json:"running"`
				Steps   []struct {
					Name string `json:"name"`
				} `json:"steps"`
			} `json:"data"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
			t.Fatalf("decode: %v", err)
		}
		if payload.Data.Running || len(payload.Data.Steps) != 1 || payload.Data.Steps[0].Name != localServiceGateway {
			t.Fatalf("unexpected payload %s", rec.Body.String())
		}
	})

	t.Run("unknown service is not found", func(t *testing.T) {
		rec := do(http.MethodGet, "/api/local-services/whatever", "127.0.0.1:5555", "http://127.0.0.1:18080")
		if rec.Code != http.StatusNotFound {
			t.Fatalf("status=%d want 404 body=%s", rec.Code, rec.Body.String())
		}
	})

	t.Run("unknown service cannot be started", func(t *testing.T) {
		rec := do(http.MethodPost, "/api/local-services/whatever/start", "127.0.0.1:5555", "http://127.0.0.1:18080")
		if rec.Code != http.StatusNotFound {
			t.Fatalf("status=%d want 404 body=%s", rec.Code, rec.Body.String())
		}
	})
}
