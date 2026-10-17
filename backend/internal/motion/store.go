package motion

import (
	"archive/zip"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
)

const (
	manifestName = "manifest.json"

	// specSupportedPrefix 是当前放行的规范版本。.motion 规范仍在 draft，
	// 未知版本必须显式拒绝并提示，而不是带着未核实的假设继续执行。
	specSupportedPrefix = "0.1.0-draft"

	maxEntryCount  = 20000
	maxTotalBytes  = 512 << 20
	maxEntryBytes  = 256 << 20
	maxSchemaBytes = 2 << 20

	importStage = "导入动效模板"
)

var safeIDPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`)

// Store 管理某个用户数据目录下的 motion 模板版本：
// <dataDir>/motion-templates/<userID>/<templateId>/<versionId>/。
type Store struct {
	root string
}

func NewStore(dataDir string, userID string) *Store {
	return &Store{root: filepath.Join(dataDir, "motion-templates", userID)}
}

// motionSpec 只解析导入校验需要的 motion.json 字段。
type motionSpec struct {
	Format      string `json:"format"`
	SpecVersion string `json:"specVersion"`
	Template    struct {
		ID      string `json:"id"`
		Version string `json:"version"`
		Name    string `json:"name"`
	} `json:"template"`
	Runtime struct {
		Entry string `json:"entry"`
	} `json:"runtime"`
	Parameters struct {
		Schema string `json:"schema"`
	} `json:"parameters"`
	Output struct {
		Width  int `json:"width"`
		Height int `json:"height"`
		FPS    struct {
			Num int `json:"num"`
			Den int `json:"den"`
		} `json:"fps"`
	} `json:"output"`
}

// ImportArchive 导入一个 .motion 包（本质是 ZIP）。
// 同 templateId+versionId 重复导入且内容一致时幂等返回；内容不一致直接拒绝。
func (s *Store) ImportArchive(ra io.ReaderAt, size int64) (*TemplateSummary, error) {
	reader, err := zip.NewReader(ra, size)
	if err != nil {
		return nil, fmt.Errorf("%s：无法读取模板包（%w）", importStage, err)
	}
	if len(reader.File) > maxEntryCount {
		return nil, fmt.Errorf("%s：模板包条目过多", importStage)
	}
	entries, err := collectEntries(reader)
	if err != nil {
		return nil, fmt.Errorf("%s：%w", importStage, err)
	}
	specRaw, ok := entries["motion.json"]
	if !ok {
		return nil, fmt.Errorf("%s：模板包缺少 motion.json", importStage)
	}
	var spec motionSpec
	if err := json.Unmarshal(specRaw, &spec); err != nil {
		return nil, fmt.Errorf("%s：motion.json 格式无效（%w）", importStage, err)
	}
	if err := validateSpec(&spec); err != nil {
		return nil, fmt.Errorf("%s：%w", importStage, err)
	}
	schemaRaw, ok := entries[spec.Parameters.Schema]
	if !ok {
		return nil, fmt.Errorf("%s：模板包缺少参数 schema（%s）", importStage, spec.Parameters.Schema)
	}
	if len(schemaRaw) > maxSchemaBytes {
		return nil, fmt.Errorf("%s：参数 schema 超过大小上限", importStage)
	}
	var schemaCheck map[string]any
	if err := json.Unmarshal(schemaRaw, &schemaCheck); err != nil {
		return nil, fmt.Errorf("%s：参数 schema 不是有效 JSON（%w）", importStage, err)
	}

	versionDir := s.versionDir(spec.Template.ID, spec.Template.Version)
	if err := os.MkdirAll(filepath.Dir(versionDir), 0o755); err != nil {
		return nil, fmt.Errorf("%s：%w", importStage, err)
	}
	tempDir := versionDir + ".importing"
	_ = os.RemoveAll(tempDir)
	if err := extractEntries(entries, tempDir); err != nil {
		_ = os.RemoveAll(tempDir)
		return nil, fmt.Errorf("%s：%w", importStage, err)
	}
	digest, err := digestDir(tempDir)
	if err != nil {
		_ = os.RemoveAll(tempDir)
		return nil, fmt.Errorf("%s：%w", importStage, err)
	}
	if existing, err := readManifest(versionDir); err == nil && existing != nil {
		// 幂等只认"磁盘版本完整 + 新包摘要与导入时一致"；内容不一致或
		// 已安装版本被改动都拒绝，不做静默覆盖。
		reject := func(reason string) error {
			_ = os.RemoveAll(tempDir)
			return fmt.Errorf("%s：版本 %s %s", importStage, spec.Template.Version, reason)
		}
		if _, verifyErr := s.verifyDir(existing); verifyErr != nil {
			return nil, reject("的文件已被改动，拒绝覆盖")
		}
		if existing.ContentDigest != digest {
			return nil, reject("已存在且内容不一致，拒绝覆盖")
		}
		_ = os.RemoveAll(tempDir)
		return existing, nil
	}
	summary := &TemplateSummary{
		TemplateID:    spec.Template.ID,
		VersionID:     spec.Template.Version,
		Name:          spec.Template.Name,
		SpecVersion:   spec.SpecVersion,
		RuntimeEntry:  spec.Runtime.Entry,
		Width:         spec.Output.Width,
		Height:        spec.Output.Height,
		FPS:           spec.Output.FPS.Num,
		ContentDigest: digest,
		ParamsSchema:  json.RawMessage(schemaRaw),
		ImportedAt:    time.Now().UTC().Format(time.RFC3339),
		Dir:           tempDir,
	}
	if err := writeManifest(tempDir, summary); err != nil {
		_ = os.RemoveAll(tempDir)
		return nil, fmt.Errorf("%s：%w", importStage, err)
	}
	if err := os.Rename(tempDir, versionDir); err != nil {
		_ = os.RemoveAll(tempDir)
		return nil, fmt.Errorf("%s：%w", importStage, err)
	}
	summary.Dir = versionDir
	return summary, nil
}

// List 返回该用户已导入的全部模板版本。
func (s *Store) List() ([]TemplateSummary, error) {
	ids, err := os.ReadDir(s.root)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return []TemplateSummary{}, nil
		}
		return nil, err
	}
	var out []TemplateSummary
	for _, idEntry := range ids {
		if !idEntry.IsDir() {
			continue
		}
		versions, err := os.ReadDir(filepath.Join(s.root, idEntry.Name()))
		if err != nil {
			continue
		}
		for _, versionEntry := range versions {
			if !versionEntry.IsDir() {
				continue
			}
			summary, err := readManifest(filepath.Join(s.root, idEntry.Name(), versionEntry.Name()))
			if err != nil || summary == nil {
				continue
			}
			out = append(out, *summary)
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].TemplateID != out[j].TemplateID {
			return out[i].TemplateID < out[j].TemplateID
		}
		return out[i].VersionID < out[j].VersionID
	})
	return out, nil
}

// Verify 校验 pin 指向的模板版本仍然完整（manifest 与文件重算摘要一致），
// 返回带解包目录的摘要。
func (s *Store) Verify(pin Pin) (*TemplateSummary, error) {
	pin = normalizePin(pin)
	if pin.TemplateID == "" || pin.VersionID == "" || pin.ContentDigest == "" {
		return nil, errors.New("模板版本标识不完整")
	}
	summary, err := readManifest(s.versionDir(pin.TemplateID, pin.VersionID))
	if err != nil || summary == nil {
		return nil, fmt.Errorf("模板 %s@%s 未导入", pin.TemplateID, pin.VersionID)
	}
	verified, err := s.verifyDir(summary)
	if err != nil {
		return nil, err
	}
	if verified.ContentDigest != pin.ContentDigest {
		return nil, fmt.Errorf("模板 %s@%s 的内容摘要与任务引用不一致，拒绝执行", pin.TemplateID, pin.VersionID)
	}
	return verified, nil
}

func (s *Store) verifyDir(summary *TemplateSummary) (*TemplateSummary, error) {
	dir := summary.Dir
	if dir == "" {
		dir = s.versionDir(summary.TemplateID, summary.VersionID)
	}
	digest, err := digestDir(dir)
	if err != nil {
		return nil, fmt.Errorf("模板 %s@%s 文件校验失败：%w", summary.TemplateID, summary.VersionID, err)
	}
	if digest != summary.ContentDigest {
		return nil, fmt.Errorf("模板 %s@%s 的文件已被改动，与导入时不一致", summary.TemplateID, summary.VersionID)
	}
	summary.Dir = dir
	return summary, nil
}

func (s *Store) versionDir(templateID, versionID string) string {
	return filepath.Join(s.root, templateID, versionID)
}

func normalizePin(pin Pin) Pin {
	pin.TemplateID = strings.TrimSpace(pin.TemplateID)
	pin.VersionID = strings.TrimSpace(pin.VersionID)
	pin.ContentDigest = strings.TrimSpace(pin.ContentDigest)
	return pin
}

func validateSpec(spec *motionSpec) error {
	if spec.Format != "motiongit-template" {
		return fmt.Errorf("motion.json 的 format 不是 motiongit-template")
	}
	if !strings.HasPrefix(spec.SpecVersion, specSupportedPrefix) {
		return fmt.Errorf("不支持的 .motion 规范版本 %s（当前支持 %s.*）", spec.SpecVersion, specSupportedPrefix)
	}
	if !safeIDPattern.MatchString(spec.Template.ID) {
		return fmt.Errorf("模板 ID %q 不合法", spec.Template.ID)
	}
	if !safeIDPattern.MatchString(spec.Template.Version) {
		return fmt.Errorf("模板版本 %q 不合法", spec.Template.Version)
	}
	if strings.TrimSpace(spec.Runtime.Entry) == "" {
		return errors.New("motion.json 缺少 runtime.entry")
	}
	if strings.TrimSpace(spec.Parameters.Schema) == "" {
		return errors.New("motion.json 缺少 parameters.schema")
	}
	if spec.Output.Width <= 0 || spec.Output.Height <= 0 || spec.Output.FPS.Num <= 0 {
		return errors.New("motion.json 的输出尺寸或帧率无效")
	}
	return nil
}

// collectEntries 读取全部压缩条目并统一为正斜杠相对路径。
// 兼容 GitHub 风格的"单一顶层目录"包：根下没有 motion.json 且全部条目共享
// 同一首段时剥掉该前缀。
func collectEntries(reader *zip.Reader) (map[string][]byte, error) {
	raw := make(map[string][]byte, len(reader.File))
	var total int64
	for _, file := range reader.File {
		if file.FileInfo().IsDir() {
			continue
		}
		name := path.Clean(strings.TrimPrefix(strings.ReplaceAll(file.Name, "\\", "/"), "./"))
		if !safeRelPath(name) {
			return nil, fmt.Errorf("条目路径不安全：%s", file.Name)
		}
		if file.UncompressedSize64 > maxEntryBytes {
			return nil, fmt.Errorf("条目 %s 超过大小上限", name)
		}
		total += int64(file.UncompressedSize64)
		if total > maxTotalBytes {
			return nil, errors.New("模板包总大小超过上限")
		}
		rc, err := file.Open()
		if err != nil {
			return nil, err
		}
		data, err := io.ReadAll(io.LimitReader(rc, maxEntryBytes+1))
		closeErr := rc.Close()
		if err != nil {
			return nil, err
		}
		if closeErr != nil {
			return nil, closeErr
		}
		if int64(len(data)) > maxEntryBytes {
			return nil, fmt.Errorf("条目 %s 超过大小上限", name)
		}
		raw[name] = data
	}
	if _, ok := raw["motion.json"]; ok {
		return raw, nil
	}
	prefix := commonRootPrefix(raw)
	if prefix == "" {
		return nil, errors.New("模板包缺少 motion.json")
	}
	stripped := make(map[string][]byte, len(raw))
	for name, data := range raw {
		stripped[strings.TrimPrefix(name, prefix+"/")] = data
	}
	return stripped, nil
}

func commonRootPrefix(files map[string][]byte) string {
	var first string
	for name := range files {
		first = name
		break
	}
	prefix, _, _ := strings.Cut(first, "/")
	if prefix == "" {
		return ""
	}
	for name := range files {
		segment, _, _ := strings.Cut(name, "/")
		if segment != prefix {
			return ""
		}
	}
	return prefix
}

func safeRelPath(name string) bool {
	if name == "" || name == "." || strings.HasPrefix(name, "/") || strings.Contains(name, ":") {
		return false
	}
	for _, part := range strings.Split(name, "/") {
		if part == "" || part == ".." {
			return false
		}
	}
	return true
}

func extractEntries(entries map[string][]byte, dest string) error {
	for name, data := range entries {
		target := filepath.Join(dest, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			return err
		}
		if err := os.WriteFile(target, data, 0o644); err != nil {
			return err
		}
	}
	return nil
}

// digestDir 对目录内全部文件（manifest 除外）按排序路径做内容摘要。
func digestDir(dir string) (string, error) {
	var names []string
	err := filepath.WalkDir(dir, func(current string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() || entry.Name() == manifestName {
			return nil
		}
		rel, err := filepath.Rel(dir, current)
		if err != nil {
			return err
		}
		names = append(names, filepath.ToSlash(rel))
		return nil
	})
	if err != nil {
		return "", err
	}
	if len(names) == 0 {
		return "", errors.New("模板目录为空")
	}
	sort.Strings(names)
	hash := sha256.New()
	for _, name := range names {
		data, err := os.ReadFile(filepath.Join(dir, filepath.FromSlash(name)))
		if err != nil {
			return "", err
		}
		fileHash := sha256.Sum256(data)
		hash.Write([]byte(name))
		hash.Write([]byte{0})
		hash.Write([]byte(hex.EncodeToString(fileHash[:])))
		hash.Write([]byte{0})
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}

func readManifest(dir string) (*TemplateSummary, error) {
	raw, err := os.ReadFile(filepath.Join(dir, manifestName))
	if err != nil {
		return nil, err
	}
	var summary TemplateSummary
	if err := json.Unmarshal(raw, &summary); err != nil {
		return nil, err
	}
	if summary.TemplateID == "" || summary.VersionID == "" || summary.ContentDigest == "" {
		return nil, errors.New("manifest 不完整")
	}
	return &summary, nil
}

func writeManifest(dir string, summary *TemplateSummary) error {
	raw, err := json.MarshalIndent(summary, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(dir, manifestName), append(raw, '\n'), 0o644)
}
