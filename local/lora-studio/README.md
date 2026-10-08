# LoRA Studio · 短剧卡司 LoRA 训练台

一站式：建剧 → 传三视图（自动裁正/侧/背）→ 一键姿势扩增数据集 → 一键全卡司合训 → 自动交付 ComfyUI+网关 → A/B 验收。

**启动**：`powershell -NoProfile -ExecutionPolicy Bypass -File start-studio-detached.ps1` → http://127.0.0.1:8890

## 架构

- **本目录**（`local/lora-studio/`）：Bun 单文件服务 `server.ts`（零依赖，端口 8890）+ 单页 UI `public/index.html`（无构建步骤）。
- **复用外部环境**：
  - `C:\AI\ai-toolkit` —— 训练引擎（venv 已装好；studio 生成配置到 `config/studio/`，产物在 `output/{剧id}_cast_h3_i2v_r32/`）
  - `127.0.0.1:8765` 网关 —— 数据集姿势扩增走 `/v1/images/edits`（固定 seed 可复现）
  - `127.0.0.1:8188` ComfyUI —— 生成引擎
- **数据目录** `C:\AI\lora-studio\{剧id}\`：datasets/{触发词}/（png+同名txt caption）、contact-{触发词}.png 对照表、train.log、validation/。

## 环境守卫（16GB 显存约束）

| 操作 | 需要 | 说明 |
| --- | --- | --- |
| 建数据集 | ComfyUI 在线 | 走网关生图；训练期间自动拒绝 |
| 训练 | ComfyUI 停机 | 脚本自动停 8188（TE 上 GPU 的显存临界，769MB 残留都会 OOM），训完自动拉回 |
| 并发训练 | 拒绝 | 检测 run.py 进程，一次只允许一个训练 |

## 训练配方（已在西游五角色上验证）

全卡司合训多触发词：rank32、lr 1e-4、adamw8bit、1000 步 ≈ 8 小时（5060 Ti，~29s/步）；数据集级 `cache_text_embeddings: true`（多触发词必需——逐 caption 编码后卸载 TE，不能用全局 trigger_word 省显存模式，否则所有角色糊成一团）；每角色 15 张起步（三视图裁切 3 + 姿势 12）。

## 交付物

- LoRA：`C:\AI\ComfyUI-Portable\ComfyUI\models\loras\{剧id}_cast.safetensors`（ComfyUI 原生格式）
- 网关路由：`h3-{剧id}`（hybrid 模板 + 卡司 LoRA strength 0.8）——BeefTV 渠道「拉取模型」后按能力=视频、协议=OpenAI Videos、勾全模态参考配置
- 用法：提示词以触发词唤起角色；多角色同框写多个触发词；首帧照常连线管构图，身份不再依赖参考图

## 已知限制

- 触发词必须纯小写字母数字（进提示词）；英文锁定描述强烈建议填（caption 与生成提示词都用它）
- 三视图须是标准"正/侧/背 三视图并列"版式（裁切按左/中/右 1/3）
- 新角色加入已交付的剧：重训（数据集都在，一键再来）；或单独训小 LoRA 与卡司 LoRA 串联（ComfyUI 多 LoraLoader 支持）
