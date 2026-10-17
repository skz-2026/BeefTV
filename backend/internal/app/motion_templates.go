package app

import (
	"mime/multipart"

	"infinite-canvas/backend/internal/motion"
)

// MotionTemplateUploadMaxBytes 限制单次导入的 .motion 包体量（原型模板约
// 18MB，留出含品牌素材包的余量）。
const MotionTemplateUploadMaxBytes = 256 << 20

func (s *Service) ImportMotionTemplate(userID string, header *multipart.FileHeader) (*motion.TemplateSummary, error) {
	file, err := header.Open()
	if err != nil {
		return nil, BadAuthRequest("无法读取上传的模板包")
	}
	defer func() { _ = file.Close() }()
	store := motion.NewStore(s.dataDir, userID)
	return store.ImportArchive(file, header.Size)
}

func (s *Service) ListMotionTemplates(userID string) ([]motion.TemplateSummary, error) {
	store := motion.NewStore(s.dataDir, userID)
	return store.List()
}
