// Package motion 管理本地导入的 .motion 动效模板（MotionGit 0.1.0-draft 规范），
// 并驱动模板自带 adapter 完成本地确定性渲染。渲染合同是模板 runtime 的
// renderFrame(frame, inputs)，逐帧 HTML Canvas 输出，产物为 mp4。
package motion

import "encoding/json"

// Pin 标识一个不可变的已导入模板版本。contentDigest 是导入时对模板
// 全部文件的内容摘要；执行前重算比对，模板文件被改动后拒绝渲染。
type Pin struct {
	TemplateID    string `json:"templateId"`
	VersionID     string `json:"versionId"`
	ContentDigest string `json:"contentDigest"`
}

// TemplateSummary 是已导入模板版本的读取投影。Dir 是解包目录（绝对路径），
// 不进入 JSON 输出。
type TemplateSummary struct {
	TemplateID    string          `json:"templateId"`
	VersionID     string          `json:"versionId"`
	Name          string          `json:"name"`
	SpecVersion   string          `json:"specVersion"`
	RuntimeEntry  string          `json:"runtimeEntry"`
	Width         int             `json:"width"`
	Height        int             `json:"height"`
	FPS           int             `json:"fps"`
	ContentDigest string          `json:"contentDigest"`
	ParamsSchema  json.RawMessage `json:"paramsSchema"`
	ImportedAt    string          `json:"importedAt"`
	Dir           string          `json:"-"`
}
