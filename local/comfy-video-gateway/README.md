# ComfyUI 视频网关（BeefTV 本地视频/生图接入）

把 BeefTV 的视频与生图请求接到**本机 ComfyUI**（MiniMax-H3 视频、Qwen-Image-2.1 生图等任意本地工作流），不修改 BeefTV 的任何官方代码。

```text
BeefTV 画布（浏览器）
   │  视频渠道：OpenAI Videos 协议 / 生图渠道：OpenAI Images 协议
   ▼
BeefTV 本地后端  /api/ai/custom 中转 + 任务 Worker
   │  CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS=127.0.0.1 放行本机上游
   ▼
本网关（gateway.ts，零依赖）
   │  翻译成 ComfyUI API：/upload/image → /prompt → /history → /view
   ▼
ComfyUI + 本地模型权重（GPU）
```

## 支持的协议端点

| 端点 | 说明 |
| --- | --- |
| `POST /v1/videos`（multipart） | 视频生成。无参考图 → T2VA 模板；带参考图 → **Ref2VA 角色参考模板**（人物一致性）；`modelWorkflows` 可按模型名覆盖 |
| `GET /v1/videos/{id}` · `/content` | 视频任务轮询与成片下载 |
| `POST /v1/images/generations`（JSON） | **同步**生图（Qwen-Image-2.1 INT8 + viggle 4 步加速），返回 `data[].b64_json`；模板 `workflows/qwen-t2i.template.json` |
| `GET /v1/models` | 模型列表 = `defaultModel` + `modelWorkflows` 键 + `modelTextEncoders` 键 + `imageModels` |

### 已实测权重组合（RTX 5060 Ti 16GB）

- **视频（MiniMax-H3）**：T2VA 用全量 INT8 底模 + turbo EMA LoRA；**Ref2VA（角色一致性）用 `minimax_h3_ref2va_pruned_int8_convrot` + 官方 `ref2v_turbo_4step` LoRA**（均来自 `Comfy-Org/MiniMax-H3`）。提示词需含 `<Picture 1>` 引用。
- **视频（FastH3 V2，`fasth3-v2` / `fasth3-v2-uncensored`）**：FastVideo 官方 DMD2 蒸馏完整学生模型 `fastvideo_fasth3_8step_v2_pruned_int8_convrot`（22GB，来自 `FastVideo/FastVideo-FastH3-Comfy` revision `0de92ab`），8 步 + learned VSA 稀疏注意力（keep20%），复用现有 Qwen 编码器与双 VAE，**不要叠加 turbo/EMA LoRA**。官方只蒸馏了 T2VA——FL2VA/Ref2VA 未蒸馏，参考图任务仍走 `h3-multiref`。2026-10-07 实测（5060 Ti，832×480）：5s 比 turbo-4 慢约 11%（81s vs 91s），12s 快约 23%（283s vs 219s），时长/分辨率越高优势越大；跨帧人物一致性更好，原生音频响度健康（-14~-25 LUFS，turbo 常 -39~-41 近静音）。
- **生图（Qwen-Image-2.1）**：`qwen_image_2.1_int8_convrot`（6.9G）+ `qwen3vl_8b_int8_convrot`（8.9G，CLIPLoader type=qwen_image）+ `qwen_image_2.1_vae_bf16` + `qwen_image_2.1_viggle_turbo_r64` 4 步 LoRA（来源 `Comfy-Org/Qwen-Image-2.1`、`t8star/Qwen-Image-2.1-viggle-turbo-4step-r64-comfy`）。
- 视频与生图**不要在 ComfyUI 里手工并发**；网关侧已内置 **GPU 按需调度**：所有生成请求串行执行，连续同类任务复用已加载模型，任务类型切换（T2V ↔ Ref2V ↔ 生图）时先调 ComfyUI `/free` 完全卸载旧模型再加载新模型，16GB 显存不会被两套权重挤爆。代价是切换后首个任务多付一次模型加载时间（H3 约 1-2 分钟，Qwen 约 5 秒）。

本目录全部是**新增文件**，与官方仓库零耦合：`git pull` 官方更新不会产生任何冲突，也不会影响官方代码路径。

## 目录结构

| 文件 | 作用 |
| --- | --- |
| `gateway.ts` | 网关本体，零第三方依赖，`node gateway.ts` 或 `bun gateway.ts` 运行 |
| `config.example.json` | 配置样例；复制为 `config.json` 使用（`config.json` 与 `jobs/` 已 git-ignore） |
| `workflows/*.template.json` | 工作流模板占位文件，用你从 ComfyUI 导出的工作流替换 |
| `jobs/` | 运行时任务产物（自动清理，默认保留 24 小时） |

## 工作原理

网关实现 BeefTV 已内置的 **OpenAI Videos 协议**（Sora 风格），BeefTV 侧只需把一个视频渠道指向它：

| BeefTV 请求 | 网关行为 |
| --- | --- |
| `POST /v1/videos`（multipart：`model`、`prompt`、`seconds`、`size`、`input_reference[]` 图片文件） | 选模板 → 参考图上传到 ComfyUI `input` 目录 → 占位符替换 → `POST /prompt` 提交工作流 |
| `GET /v1/videos/{id}` | 轮询 ComfyUI `/history/{prompt_id}`，映射为 `queued / in_progress / completed / failed` |
| `GET /v1/videos/{id}/content` | 从 ComfyUI `/view` 拉取成片并回传 mp4 |

带参考图走 `workflows.image` 模板（图生视频），不带则走 `workflows.text` 模板（文生视频）。

## 接入步骤

### 1. 跑通 ComfyUI 本地工作流

先在 ComfyUI 里手动跑通目标模型（例如 MiniMax-H3：安装模型发布方提供的 ComfyUI 节点包与量化权重）。注意 ComfyUI 官方模板里带 `api_` 前缀的 MiniMax 工作流调用的是**海螺云端 API**，不是本地权重，不要混淆。

### 2. 导出工作流并替换模板

1. ComfyUI 菜单「工作流 → 导出（API）」得到 API 格式 JSON（顶层是节点 ID 到 `{class_type, inputs}` 的映射）；
2. 用导出内容**整体替换** `workflows/text-to-video.template.json`（文生视频）或 `workflows/image-to-video.template.json`（图生视频）；
3. 把需要动态注入的字段值改成占位符（保持 JSON 类型位置不变，网关会把数字占位符替换为数字）：

| 占位符 | 注入内容 |
| --- | --- |
| `{{PROMPT}}` | 画布上填写的正向提示词 |
| `{{NEGATIVE_PROMPT}}` | 反向提示词（未配置时取 `config.defaultNegativePrompt`） |
| `{{SECONDS}}` | 视频时长（数字） |
| `{{WIDTH}}` / `{{HEIGHT}}` / `{{SIZE}}` | 分辨率，来自渠道的 size 设置（如 `1280x720`） |
| `{{SEED}}` | 每次请求随机种子（数字）；请求表单可选传 `seed` 固定种子，用于 A/B 对比复现 |
| `{{IMAGE}}` / `{{IMAGE_2}}`… | 参考图文件名（上传到 ComfyUI input 后的引用名），填在 LoadImage 类节点的 `image` 字段 |
| `{{TEXT_ENCODER}}` | 文本编码器权重文件名，按请求的模型名从 `modelTextEncoders` / `defaultTextEncoder` 解析，填在 CLIPLoader 的 `clip_name` 字段 |

替换后如仍有 `{{...}}` 残留，网关会在创建任务时明确报错指出是哪个占位符。

### 3. 配置并启动网关

```bash
cd local/comfy-video-gateway
cp config.example.json config.json   # Windows: copy config.example.json config.json
node gateway.ts                      # 或 bun gateway.ts
```

改完 `gateway.ts` / `config.json` / 模板后重启网关：`bash restart-gateway.sh`（杀旧拉新，日志写 `logs/`）。

关键配置项：

| 字段 | 说明 |
| --- | --- |
| `port` / `host` | 默认 `8765`，仅监听 `127.0.0.1`；后端不在本机时才改 `host`，此时必须设置 `apiKey` |
| `apiKey` | 非空时校验 `Authorization: Bearer`；与 BeefTV 渠道里填的 API Key 保持一致 |
| `executor` | `mock`（默认，不依赖 GPU，用于打通链路）/ `comfyui`（真实生成） |
| `comfyuiUrl` | ComfyUI 地址，默认 `http://127.0.0.1:8188` |
| `workflows` / `modelWorkflows` | 文生/图生模板路径；`modelWorkflows` 可按模型名覆盖（多个本地模型共用一个网关） |
| `defaultTextEncoder` / `modelTextEncoders` | H3 视频模板的编码器权重：模板里写 `{{TEXT_ENCODER}}` 占位符，默认取 `defaultTextEncoder`，命中 `modelTextEncoders` 的模型名换成对应文件（官方/无审查双编码器共存，见下文） |
| `timeoutMinutes` | 等待 ComfyUI 生成的超时时间 |

### 4. 放行本机上游（关键）

BeefTV 后端默认拒绝本机/私网模型上游（SSRF 防护），需以精确白名单方式放行后重启后端：

```bash
CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS=127.0.0.1
```

注意：自定义渠道中转只认这个主机白名单，`CANVAS_ALLOW_PRIVATE_UPSTREAMS` 总开关对它不生效；按安全纪律也只应精确放行 `127.0.0.1`，不要放开整个私网。

### 5. 在 BeefTV 里配置渠道

模型配置 → 新建渠道：

- **接口协议**：选 **OpenAI Videos（`newapi`）**。不要选 `newapi-channel-2`——那是 JSON 版 `/video/generations` 协议，参考图要求公网 URL，不适合本地素材；
- **Base URL**：`http://127.0.0.1:8765/v1`；
- **API Key**：与网关 `config.apiKey` 一致（网关未设 Key 时随便填一个非空值，BeefTV 侧要求 Key 非空）；
- **模型**：添加模型名（如 `minimax-h3`）并启用视频能力，也可直接点「拉取模型」从网关 `/v1/models` 获取。多个本地模型时，把模型名登记到网关 `config.modelWorkflows`（换工作流）或 `config.modelTextEncoders`（换编码器）即可路由。

之后在画布上像使用云渠道一样发起视频生成：不带图走文生视频模板，接参考图节点走图生视频模板。

### 6. 验证顺序

1. **mock 联调**（不需要 GPU）：`executor: "mock"` 启动网关 → BeefTV 发起生成 → 数秒后画布出现视频节点（mock 未配 `mockVideoPath` 时是不可播放的占位字节，只证明链路通）；
2. **真实生成**：`executor: "comfyui"` 重启网关 → 先文生视频、再图生视频；
3. 遇到失败时先看网关控制台日志：模板未替换、占位符残留、ComfyUI 节点报错都会在此明确输出。

## MiniMax-H3 实测配置（RTX 5060 Ti 16GB）

已在 5060 Ti 16GB + ComfyUI 0.38 + T8 节点包（minimax-h3-audio-T8）实测通过，模板即由此而来：

| 权重 | 目录 | 大小 |
| --- | --- | --- |
| `minimax_h3_fl2va_int8_convrot.safetensors` | `models/diffusion_models/` | 32.5 GB |
| `qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors` | `models/text_encoders/` | 15 GB |
| `minimax_h3_video_vae_fp16.safetensors` | `models/vae/` | 5 GB |
| `minimax_h3_audio_vae_fp32.safetensors` | `models/vae/` | 0.6 GB |
| `minimax_h3_turbo_4步加速ema_comfyui.safetensors` | `models/loras/` | 0.7 GB |

权重来自 [`t8star/Vdn-Minimax-H3-Comfy`](https://huggingface.co/t8star/Vdn-Minimax-H3-Comfy)（未门控，国内可用 `hf-mirror.com` 直链下载）与 [`t8star/minimax-h3-4step-turbo-loras-comfyui-exp`](https://huggingface.co/t8star/minimax-h3-4step-turbo-loras-comfyui-exp)。

### 官方 / 无审查双编码器（按模型切换）

除官方编码器外，另部署了社区去审查编码器（Heretic 消融版，仅替换提示词理解这一层，视频底模不变）：

| 权重 | 目录 | 大小 |
| --- | --- | --- |
| `qwen3vl_32b_heretic_minimax_h3_nvfp4.safetensors` | `models/text_encoders/` | 15.7 GB |

来源 [`Abiray/Qwen3-VL-32B-Heretic-MiniMax-H3-nvfp4-ComfyUI`](https://modelscope.cn/models/Abiray/Qwen3-VL-32B-Heretic-MiniMax-H3-nvfp4-ComfyUI)（ModelScope）。视频模板的 `clip_name` 写 `{{TEXT_ENCODER}}` 占位符，按模型名解析编码器：

- `minimax-h3` / `h3-multiref` / `h3-i2v` → 官方 `qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors`；
- `minimax-h3-uncensored` / `h3-multiref-uncensored` / `h3-i2v-uncensored` → 上述 Heretic 权重。

两套模型共用全部工作流模板（只有编码器不同），BeefTV 渠道里「拉取模型」即可看到全部模型名。去审查编码器消融有轻微能力损失（KL 0.042），对复杂结构化提示词（subject_definitions 等）的遵循度建议自行对比后选用；生成内容合法性与平台边界的责任在使用者。

- 网关会把请求的宽高**自动对齐到 32 的倍数**（H3 硬性要求，720P 的 1280x720 会被对齐为 1280x704），无需在 BeefTV 侧做特殊设置。
- 帧数按 `秒×24+4` 换算（5 秒→124 帧），时长范围 2–15 秒。
- 实测耗时：832×480 · 5 秒约 1.5 分钟；1280×704 · 6 秒约 7 分钟（含权重加载）。生成期间显存约 15.5/16 GB，请勿并发提交多个视频任务。
- BeefTV 后端首次使用 OpenAI Videos 协议需要官方 `openai-videos.beeftv-plugin` 插件包：仓库源码在 `plugin-packages/`，需先构建出 `.beeftv-plugin`（本仓库外用 `build-packages.sh`，Windows 无 zip 命令时可用任意 zipfile 工具复刻），并把 `CANVAS_OFFICIAL_PLUGIN_DIR` 指向该目录。

## 安全与边界

- 网关默认只绑定 `127.0.0.1`，不对外网暴露；跨机部署时改 `host` 并**必须**设置 `apiKey`；
- 网关会把上传的参考图写入 ComfyUI 的 input 目录（`beeftv-ref-*.png` 命名），成片缓存在 `jobs/` 下自动过期清理；
- 日志不记录模型密钥；BeefTV 侧的密钥约束（不进 URL、不进日志）由官方中转层保证，本目录不重复实现。
