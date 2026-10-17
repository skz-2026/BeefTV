package operations

import (
	"encoding/json"
	"strings"

	"infinite-canvas/backend/internal/model"
	localtask "infinite-canvas/backend/internal/task"
)

// MotionRenderAdmission must use the operation's transaction for admission.
// Template file verification happens inside the adapter before the task row
// is created, so a missing or tampered template fails the operation instead
// of producing a doomed queued task.
type MotionRenderAdmission interface {
	CreateCanvasMotionRender(userID string, req localtask.MotionRenderCreateRequest) (*model.Task, error)
}

func registerCanvasMotionOps(r *Registry) {
	r.Register(Op{ReplaySafe: true, AssistantCanvas: true, ID: "canvas.motion.render", Summary: "用已导入的动效模板本地渲染成片（免费、确定性、不调用付费生成）", Scope: ScopeCanvas,
		Params:  json.RawMessage(`{"type":"object","properties":{"canvasId":{"type":"string"},"templateId":{"type":"string"},"versionId":{"type":"string"},"contentDigest":{"type":"string"},"params":{"type":"object"}},"required":["canvasId","templateId","versionId","contentDigest","params"]}`),
		Handler: opCanvasMotionRender})
}

func opCanvasMotionRender(ctx *Context, raw json.RawMessage) (any, error) {
	var args struct {
		CanvasID      string          `json:"canvasId"`
		TemplateID    string          `json:"templateId"`
		VersionID     string          `json:"versionId"`
		ContentDigest string          `json:"contentDigest"`
		Params        json.RawMessage `json:"params"`
	}
	if err := decodeParams(raw, &args); err != nil {
		return nil, err
	}
	if strings.TrimSpace(args.CanvasID) == "" || strings.TrimSpace(args.TemplateID) == "" ||
		strings.TrimSpace(args.VersionID) == "" || strings.TrimSpace(args.ContentDigest) == "" ||
		len(args.Params) == 0 || strings.TrimSpace(ctx.OperationID) == "" {
		return nil, InvalidArg("invalid_params", "canvasId、模板版本标识、params 和稳定操作标识必填")
	}
	admission, ok := ctx.Domain.(MotionRenderAdmission)
	if !ok {
		return nil, Unsupported("motion_render_unavailable", "当前工作区无法创建动效模板渲染任务")
	}
	task, err := admission.CreateCanvasMotionRender(ctx.UserID, localtask.MotionRenderCreateRequest{
		ProjectID:         args.CanvasID,
		TemplateID:        args.TemplateID,
		VersionID:         args.VersionID,
		ContentDigest:     args.ContentDigest,
		Params:            args.Params,
		ClientOperationID: "assistant-motion-render:" + ctx.OperationID,
	})
	if err != nil {
		return nil, mapDomainError(err)
	}
	return map[string]any{
		"canvasId": args.CanvasID, "taskId": task.ID, "status": task.Status,
		"local": true, "charged": false,
		"template": map[string]any{"templateId": args.TemplateID, "versionId": args.VersionID},
	}, nil
}
