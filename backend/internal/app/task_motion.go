package app

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"time"

	localasset "infinite-canvas/backend/internal/asset"
	"infinite-canvas/backend/internal/mediatools"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/motion"
	localtask "infinite-canvas/backend/internal/task"
)

const motionRenderFileName = "motion-render.mp4"

func motionRenderArtifactIdentity(taskID string) string {
	return taskID + ":0"
}

type motionRenderInput struct {
	ProjectID string                `json:"projectId"`
	Template  localtask.TemplatePin `json:"template"`
	Params    json.RawMessage       `json:"params"`
}

// processMotionRender 在本地渲染一个已导入的 .motion 模板版本。
// 执行前重算模板文件摘要：模板被改动过的任务直接失败，不重放到未知内容。
func (w *taskWorkerCoordinator) processMotionRender(task *model.Task, ctx context.Context) error {
	s := w.service
	var input motionRenderInput
	if err := json.Unmarshal([]byte(task.InputJSON), &input); err != nil {
		return w.failTimelineTask(task, "渲染失败", "任务缺少有效的模板渲染输入")
	}
	store := motion.NewStore(s.dataDir, task.UserID)
	summary, err := store.Verify(motion.Pin{
		TemplateID:    input.Template.TemplateID,
		VersionID:     input.Template.VersionID,
		ContentDigest: input.Template.ContentDigest,
	})
	if err != nil {
		return w.failTimelineTask(task, "渲染失败", err.Error())
	}
	ffmpegBin, err := mediatools.ResolveFFmpeg()
	if err != nil {
		return w.failTimelineTask(task, "渲染失败", err.Error())
	}
	workDir, err := os.MkdirTemp("", "beeftv-motion-*")
	if err != nil {
		return w.failTimelineTask(task, "渲染失败", "无法创建渲染工作目录")
	}
	defer func() { _ = os.RemoveAll(workDir) }()

	runtimeDir := filepath.Join(s.dataDir, "motion-runtime", task.UserID, summary.TemplateID+"--"+summary.VersionID)
	runner := &motion.Runner{TemplateDir: summary.Dir, Entry: summary.RuntimeEntry, FFmpegBin: ffmpegBin, RuntimeDir: runtimeDir}
	var renderFile *os.File
	defer func() {
		if renderFile != nil {
			_ = renderFile.Close()
		}
	}()
	resource, err := s.resourceDomain().RecoverOwned(task.UserID, motionRenderArtifactIdentity(task.ID), func() (localasset.RecoveredArtifact, error) {
		rendered, renderErr := runner.Run(ctx, input.Params, workDir, func(stage string, percent int) error {
			return w.progress(task, stage, percent)
		})
		if renderErr != nil {
			return localasset.RecoveredArtifact{}, renderErr
		}
		file, openErr := os.Open(rendered.Path)
		if openErr != nil {
			return localasset.RecoveredArtifact{}, fmt.Errorf("读取模板渲染产物失败")
		}
		renderFile = file
		return localasset.RecoveredArtifact{
			Kind: "video", FileName: motionRenderFileName, MimeType: "video/mp4",
			Size: rendered.Size, Width: rendered.Width, Height: rendered.Height,
			DurationMs: rendered.DurationMs, Body: file,
		}, nil
	})
	if err != nil {
		return w.failTimelineTask(task, "渲染失败", err.Error())
	}
	if resource == nil {
		return w.failTimelineTask(task, "渲染失败", "保存模板渲染产物失败")
	}
	if err := w.progress(task, "写入资源…", 96); err != nil {
		return err
	}

	result := map[string]any{
		"video":      map[string]any{"resourceId": resource.ID, "mimeType": "video/mp4", "fileName": motionRenderFileName, "durationMs": resource.DurationMs},
		"resourceId": resource.ID,
		"fileName":   motionRenderFileName,
		"size":       resource.Size,
		"durationMs": resource.DurationMs,
		"template":   map[string]any{"templateId": summary.TemplateID, "versionId": summary.VersionID},
	}
	payload, err := json.Marshal(result)
	if err != nil {
		return w.failTimelineTask(task, "渲染失败", "渲染结果序列化失败")
	}
	task.Status = model.TaskStatusSucceeded
	task.Stage = "渲染完成"
	task.Progress = 100
	task.ResultJSON = string(payload)
	completedAt := time.Now()
	task.CompletedAt = &completedAt
	if err := s.repo.SaveTaskCompletion(task, model.TaskStatusRunning, nil); err != nil {
		return fmt.Errorf("写入模板渲染完成态失败: %w", err)
	}
	if err := s.DeliverSucceededTask(*task); err != nil {
		return fmt.Errorf("模板渲染完成后的素材交付失败：%w", err)
	}
	s.logInfo(task.UserID, task.ID, fmt.Sprintf("动效模板渲染完成：%s@%s，时长 %.1fs", summary.TemplateID, summary.VersionID, float64(resource.DurationMs)/1000), "")
	return nil
}
