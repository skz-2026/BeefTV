package app

import (
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/motion"
	"infinite-canvas/backend/internal/operations"
	localtask "infinite-canvas/backend/internal/task"
)

// CreateCanvasMotionRender verifies the pinned template version on this
// machine before admitting the task, then uses the operation transaction for
// admission. The worker re-verifies file integrity right before rendering.
func (s *operationSession) CreateCanvasMotionRender(userID string, req localtask.MotionRenderCreateRequest) (*model.Task, error) {
	store := motion.NewStore(s.service.dataDir, userID)
	if _, err := store.Verify(motion.Pin{
		TemplateID:    req.TemplateID,
		VersionID:     req.VersionID,
		ContentDigest: req.ContentDigest,
	}); err != nil {
		return nil, operations.PreconditionFailed("motion_template_unavailable", err.Error(), nil)
	}
	policy, err := s.service.runtimePolicyWithRepo(s.repo)
	if err != nil {
		return nil, err
	}
	adapter := operationRenderDependencies{s: s, policy: policy}
	domain := localtask.NewService(localtask.NewStore(s.repo), localtask.Dependencies{
		Projects: adapter, Policy: adapter, Persist: adapter, Runtime: taskRuntimeAdapter{s.service}, Present: operationRenderPresenter{}, NewID: newID,
	})
	return domain.CreateMotionRenderTask(userID, req)
}

var _ operations.MotionRenderAdmission = (*operationSession)(nil)
