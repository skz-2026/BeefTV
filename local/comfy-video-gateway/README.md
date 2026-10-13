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
| `POST /v1/videos`（multipart） | 视频生成。无参考图 → T2VA 模板；带参考图 → **Ref2VA 角色参考模板**（人物一致性）；`modelWorkflows` 可按模型名覆盖。可选 `seed` 表单参数（0–2147483647，缺省随机） |
| `GET /v1/videos/{id}` · `/content` | 视频任务轮询与成片下载 |
| `POST /v1/images/generations`（JSON） | **同步**生图（Qwen-Image-2.1 INT8 + viggle 4 步加速），返回 `data[].b64_json`；模板 `workflows/qwen-t2i.template.json`，`modelImageWorkflows` 可按模型名覆盖（如 UC 去审查 GGUF）。可选 `seed` 字段（同 seed 逐字节可复现，2026-10-08 实测验证） |
| `POST /v1/images/edits`（multipart） | 图片编辑（多参考身份保真），可选 `seed` 表单参数（首帧编辑复现/对照实验） |
| `GET /v1/models` | 模型列表 = `defaultModel` + `modelWorkflows` 键 + `modelTextEncoders` 键 + `imageModels` |

#### `h3-hybrid-flf`：首尾帧咬合（镜头间接续）

模板 `workflows/hybrid-first-last.template.json`，在 hybrid（首帧+参考）基础上把 T8 条件节点的 `last_frame` 槽接上第二张图。**输入约定（连线顺序即槽位）**：images[0]=首帧、images[1]=尾帧、images[2..]=身份参考（正面图/三视图）。适用场景：同场景连续镜头（上一镜尾帧=本镜首帧的 frame chaining，或手绘/编辑出首尾两张定稿帧让模型补中间动作）。BeefTV 侧用法：视频节点连 [首帧节点, 尾帧节点, 参考图...]，模型选 `h3-hybrid-flf`（渠道里需配：能力=视频、协议=OpenAI Videos、勾全模态参考）。

#### `h3-hybrid-{角色}`：西游角色身份 LoRA（2026-10-08 上线）

五角色身份 LoRA（`models/loras/{wukong,tangseng,bajie,shaseng,bailongma}_h3.safetensors`，AI Toolkit 训练 fl2va 底模，数据集=三视图裁切+正面图姿势扩增各 15 张，触发词=角色拼音）。模板 `workflows/hybrid-{char}.template.json` = hybrid + 角色 LoRA（strength 0.8）串在 turbo LoRA 之后。**用法**：模型选 `h3-hybrid-wukong` 等，提示词以触发词开头（如 "wukong, the monkey boy..."）；首帧仍连（管构图），身份锚定由 LoRA 承担——多人镜可不再连三视图/正面参考。训练队列日志在 `C:\AI\ai-toolkit\output\train-*.log`，验收脚本 `C:\work\BeefTV\.local\validate-loras.js`（lora vs 基线同 seed 对照）。

### 已实测权重组合（RTX 5060 Ti 16GB）

- **视频（MiniMax-H3）**：T2VA 用全量 INT8 底模 + turbo EMA LoRA；**Ref2VA（角色一致性）用 `minimax_h3_ref2va_pruned_int8_convrot` + 官方 `ref2v_turbo_4step` LoRA**（均来自 `Comfy-Org/MiniMax-H3`）。提示词需含 `<Picture 1>` 引用。
- **视频（FastH3 V2，`fasth3-v2` / `fasth3-v2-uncensored`）**：FastVideo 官方 DMD2 蒸馏完整学生模型 `fastvideo_fasth3_8step_v2_pruned_int8_convrot`（22GB，来自 `FastVideo/FastVideo-FastH3-Comfy` revision `0de92ab`），8 步 + learned VSA 稀疏注意力（keep20%），复用现有 Qwen 编码器与双 VAE，**不要叠加 turbo/EMA LoRA**。官方只蒸馏了 T2VA——FL2VA/Ref2VA 未蒸馏，参考图任务仍走 `h3-multiref`。2026-10-07 实测（5060 Ti，832×480）：5s 比 turbo-4 慢约 11%（81s vs 91s），12s 快约 23%（283s vs 219s），时长/分辨率越高优势越大；跨帧人物一致性更好，原生音频响度健康（-14~-25 LUFS，turbo 常 -39~-41 近静音）。
- **生图（Qwen-Image-2.1）**：`qwen_image_2.1_int8_convrot`（6.9G）+ `qwen3vl_8b_int8_convrot`（8.9G，CLIPLoader type=qwen_image）+ `qwen_image_2.1_vae_bf16` + `qwen_image_2.1_viggle_turbo_r64` 4 步 LoRA（来源 `Comfy-Org/Qwen-Image-2.1`、`t8star/Qwen-Image-2.1-viggle-turbo-4step-r64-comfy`）。
- **生图（Qwen-Image-2.1 Turbo，`qwen-image-2.1-turbo`，2026-10-11 上线）**：官方蒸馏 8 步 checkpoint（来源 `Comfy-Org/Qwen-Image-2.1` 的 `qwen_image_2.1_turbo_int8_convrot`，7.3G），编码器与 VAE 复用 Base 套装，模板 `workflows/qwen-t2i-turbo.template.json`，`modelImageWorkflows` 按模型名路由。steps=8、cfg=1.0、ModelSamplingAuraFlow shift=3.0、euler/simple（官方蒸馏日程内嵌在 checkpoint 里，ComfyUI 端用该参数近似；diffusers 端才读内嵌 sigmas + prefix KV cache）。**不要叠加 viggle/任何加速 LoRA**。1024×1024 实测约 15-20 秒/张（8 步，比 Base+viggle 4 步约慢一倍），提示词跟随与中文文字渲染明显更稳（「毛孩子」手写体直接出对）。同 seed 与 4 步 viggle 的对照实验可在画布侧选 `qwen-image-2.1` / `qwen-image-2.1-turbo` 各跑一次。许可仍是 Qwen Research（非商用），与 Base 相同。
- **生图（Qwen-Image-2.1 Base 满血，`qwen-image-2.1-full`，2026-10-11 上线）**：同底模 `qwen_image_2.1_int8_convrot`，**不加任何 LoRA**，steps=40（官方模型卡默认）+ cfg=2.5（沿用本机 UC GGUF 非蒸馏线实测值）+ shift=3.0、euler/simple，模板 `workflows/qwen-t2i-full.template.json`。用途是定稿级精修。1024×1024 实测**约 56 秒/张**（80 次前向，INT8 convrot 直算远快于 GGUF 路线；此前"3 分钟"的估计按 GGUF 速度推算，作废）。注意：**重启网关会清空其任务注册表，ComfyUI 队列里未跑完的旧任务不受影响但仍占位**——批量产视频时段重启网关会让新任务排到旧视频后面。
- **生图（Qwen-Image-2.1 Uncensored，`qwen-image-2.1-uc-gguf`，2026-10-11 上线）**：社区去审查 GGUF 量化（来源 `abenzerps/Qwen-Image-2.1-Uncensored-GGUF`，UC = 原版权重 + 去审查 LoRA 合并），模板 `workflows/qwen-t2i-uc-gguf.template.json`，`modelImageWorkflows` 按模型名路由。Q4_K_M（4.6G）+ 官方同款编码器/VAE。**不能叠加 viggle turbo LoRA**（权重不兼容，出图不跟提示词），20 步 cfg 2.5 约 78 秒/张（1024×1024 实测）。依赖 ComfyUI-GGUF 插件识别 `qwen_image21` 架构——上游 city96/ComfyUI-GGUF 尚未合并，本机在 `custom_nodes/ComfyUI-GGUF/loader.py` 的 `IMG_ARCH_LIST` 本地加了 `"qwen_image21"`，**更新该插件后需重打此补丁**。
- 视频与生图**不要在 ComfyUI 里手工并发**；网关侧已内置 **GPU 按需调度**：所有生成请求串行执行，连续同类任务复用已加载模型，任务类型切换（T2V ↔ Ref2V ↔ 生图）时先调 ComfyUI `/free` 完全卸载旧模型再加载新模型，16GB 显存不会被两套权重挤爆。代价是切换后首个任务多付一次模型加载时间（H3 约 1-2 分钟，Qwen 约 5 秒）。
- **生图优先车道（2026-10-11）**：排队任务分视频/生图两条车道，生图总是插到**排队中**的视频前面（正在执行的任务无法抢占，最多等当前一条跑完）。视频连发时画布生图不再被堵到 BeefTV 后端超时之外；后端侧配套 `CANVAS_IMAGE_TIMEOUT_MINUTES` 环境变量可放宽生图等待（`start-backend-detached.cmd` 已设 30 分钟），且本地免费渠道的生图超时失败不再锁定重试（可直接在任务上重试）。

本目录全部是**新增文件**，与官方仓库零耦合：`git pull` 官方更新不会产生任何冲突，也不会影响官方代码路径。

## 目录结构

| 文件 | 作用 |
| --- | --- |
| `gateway.ts` | 网关本体，零第三方依赖，`node gateway.ts` 或 `bun gateway.ts` 运行 |
| `config.example.json` | 配置样例；复制为 `config.json` 使用（`config.json` 与 `jobs/` 已 git-ignore） |
| `workflows/*.template.json` | 工作流模板占位文件，用你从 ComfyUI 导出的工作流替换 |
| `verify-templates.js` | 集成全量校验器（见下节），`node verify-templates.js [--live]` |
| `jobs/` | 运行时任务产物（自动清理，默认保留 24 小时） |

## 全量校验器：证明"每个注册模板在任何请求形态下都能提交成功"

```bash
node verify-templates.js --live     # ComfyUI 需在运行；不加 --live 只跑静态+object_info 层
```

三层校验，退出码 0=全绿（当前基线：60 通过 / 0 失败）：

1. **静态层**：config 注册的全部模板（`workflows` + `modelWorkflows` + `modelImageWorkflows`）存在、可解析、占位符合法；对每个模板枚举图片 0–7 张 × 音频 0–1 段的全部请求形态，模拟网关替换+剪槽后检查图完整性（无残留占位符、无悬空链接、无空文件名加载器、有输出节点）；并检查 T8 槽位不变量（接 `last_frame` 的模板参考槽必须从 `{{IMAGE_3}}` 起，否则 `<Picture N>` 文字绑定整体错位）。
2. **活体层**：ComfyUI `/object_info` 核对每个 `class_type` 存在、每个加载器（UNET/LoRA/CLIP/VAE/GGUF）引用的权重文件在可见列表（静态输入表差异只降级为警告——UI-only 键如 `upload`/`control` 和 VHS 动态 widget 本就不在静态表，ComfyUI 提交时忽略）。
3. **实弹层（`--live`）**：每个模板取代表形态真实 `POST /prompt` 过 ComfyUI 自身校验（节点存在性、输入名/类型、组合值、链接类型全查），拿到 prompt_id 即 PASS，随即从队列删除——不占 GPU。音频引用用自动上传的 `verify-probe.wav` 静音探针。

校验器**独立重实现**了网关的替换/剪槽逻辑（刻意不 import gateway.ts），两份实现互相交叉验证。改模板、改 `config.json`、升级 ComfyUI、增删权重或自定义节点包后必跑；CI 可直接用退出码。

### 2026-10-12 加固记录（当日集成审计产出）

- 修复 `hybrid-dub-flf` / `-steady` 参考槽错位（详见 `.local/bazong-pipeline.md`）：参考槽 `IMAGE_2..6` → `IMAGE_3..7`，尾帧不再重复占 `ref_image_0`，`<Picture 3/4>` 角色稿文字绑定复位。
- 修复 `larry-i2v` 模板：`first_frame` 原误接 `MiniMaxH3TurboSampler`（SAMPLER 类型）且缺失 LoadImage 节点，ComfyUI 校验必拒——该模型注册后从未可用，实弹层抓出后已修。
- 网关新增两道结构防线：`pruneEmptyMediaNodes`（任何请求形态都不把带空文件名的加载器提交给 ComfyUI，如只连 1 张图时 `last_frame` 落空则剪掉该 keyframe 槽）与 `assertNoDanglingLinks`（剪槽后仍有悬空链接直接 400 报错，绝不提交坏图）。
- 修复缺省种子 bug：`Number("")===0` 导致不发 seed 字段的请求（BeefTV 后端表单从不发）全部共用 seed=0，重摇不换片；现缺省真随机，显式 seed 复现语义保留。
- `h3-hybrid-dub-flf-s8` 重新注册为 8 步主模板别名（此前未注册会静默回退 ref-to-video）；任务日志打印实际模板文件名，未注册模型名的回退明确标注。
- 口型绑定兜底 `ensureAudioPerformanceBinding`：T8 的 `prepare_prompt` 只校验已有媒体标签、从不自动注入——提示词不写 `<Audio N>` 时 drive_audio 只是弱参考，模型不做说话表演（E01 全部镜头因此无口型）。现 dub 系模板（含 drive_audio 槽）+ 请求带音频 + 提示词无任何音频标签时自动追加官方口型句（"visibly performs ... in precise synchronization with <Audio 1>"）；调用方已写标签不重复追加，非台词模板（hybrid-cast 声线锚）不动。拦截实测三项全过（`.local/bind-check.js`）。

### 2026-10-13 H3 参数链路审计产出

全链路字段核对通过（插件表单字段 ↔ 网关读取键、size 32 对齐、秒×24+4 帧、参考槽顺序、采样覆盖范围），三处边缘加固：

- 纯音频请求显式拒绝：`mode=text` 且带音频参考时直接 400（文生视频模板没有音频槽位，此前音频被静默剪掉、出片成功但口型/台词全无）。要么为首帧连图，要么改用 dub 系模型名。
- hybrid 家族 8 个模板的 CLIPLoader 由硬编码官方编码器改为 `{{TEXT_ENCODER}}` 占位符：当前所有 hybrid 模型名仍解析到官方权重（行为不变），但 `modelTextEncoders` 的按模型名切换从此对 hybrid 家族同样生效，杜绝将来注册 `-uncensored` 变体时"名字切了、编码器没切"的静默失效。
- BeefTV 设置页 steps 提示文案对齐模板现状（hybrid 6 / dub-flf 8 / steady 20，见 `web/src/pages/settings/channel-model-settings.tsx`）。

### 2026-10-12 画布链路打通（BeefTV 任务体系 → 插件 → 网关，端到端实测）

此前霸总管线全部经 `.local` 脚本直连网关，**画布正规链路（后端任务 → openai-videos 插件合同 → 网关）从未完整跑通**，三处断点当日修复：

1. **多参考图被插件合同裁成一张**：`openai-videos` 插件 files[0] 原为 `$first` 单图（真 Sora 只收一张参考）。已在插件包补 `input_reference_1..6` 追加槽（镜像音频槽写法），**改 `plugin-packages/openai-videos/` 源码后必须重打包**：`node embed-documentation.mjs openai-videos` + zip 打包为 `.beeftv-plugin`（后端只加载打包文件，不读源码目录）。
2. **newapi 取消不传播**：后端 `supportsProviderCancellation` 白名单缺 `newapi`，画布取消只停 worker，GPU 继续空转。已加入白名单走 `DELETE /v1/videos/{id}`（与 h3-multiref 同路），实测画布取消 → 网关 → ComfyUI interrupt 全通。
3. **网关参考收集合并**：`collectReferenceFiles` 现按"主引用（input_reference / input_reference[]）在前 + 序号追加图（input_reference_1..6）在后"合并，兼容浏览器直发、h3-multiref 纯序号、插件混合三种形态。

画布链路端到端测试工具：`node .local/canvas-test-shot.js e01 S01`——上传素材为后端资源、按画布前端真实契约创建 `canvas_video` 任务（自定义通道形态：config 带 baseUrl+apiKey）、轮询到成片。当日实测 S01：4 图 + 1 音频全部依序入槽（Picture 1-4 对位、drive_audio 就位）、种子真随机、渲染约 20 分钟出片。

## 工作原理

网关实现 BeefTV 已内置的 **OpenAI Videos 协议**（Sora 风格），BeefTV 侧只需把一个视频渠道指向它：

| BeefTV 请求 | 网关行为 |
| --- | --- |
| `POST /v1/videos`（multipart：`model`、`prompt`、`seconds`、`size`、`input_reference[]` 图片文件） | 选模板 → 参考图上传到 ComfyUI `input` 目录 → 占位符替换 → `POST /prompt` 提交工作流 |
| `GET /v1/videos/{id}` | 轮询 ComfyUI `/history/{prompt_id}`，映射为 `queued / in_progress / completed / failed` |
| `GET /v1/videos/{id}/content` | 从 ComfyUI `/view` 拉取成片并回传 mp4 |

带参考图走 `workflows.image` 模板（图生视频），不带则走 `workflows.text` 模板（文生视频）。

## 管理控制台（/admin）

浏览器打开 <http://127.0.0.1:8765/admin>（仅限本机访问，不走 API Key 校验）可以在线查看和修改 `workflows/*.template.json` 的参数：

- 每个参数带中文释义（采样步数、turbo LoRA 强度、音轨策略、口型三件套、CRF 等），已覆盖 T8 采样器/LoRA/音频条件/编码器/VAE/VHS 输出等常用节点；未收录的节点字段按原始字段展示；
- 模板按任务**实时读盘**，控制台保存后下一个任务即生效，无需重启网关；每次保存自动备份到 `workflows/.backups/`；
- 金色 `{{占位符}}`（`{{PROMPT}}`/`{{SEED}}`/`{{IMAGE_N}}` 等）由网关按请求注入，控制台里只读；节点间连线在「原始 JSON」里查看；
- 控制台改的是模板默认值；单次请求级覆盖用 BeefTV 模型高级设置里的 `steps`/`shift_video`/`shift_audio` 表单字段（2~12/1~25/1~10），两者互不冲突。

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
| `modelImageWorkflows` | 图片生成按模型名覆盖模板（如 `qwen-image-2.1-uc-gguf` → `workflows/qwen-t2i-uc-gguf.template.json`），未命中的模型回退 `workflows.imageGen` |
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
