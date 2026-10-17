# Windows 视频运行包

`scripts/package-media-runtime-windows.ps1` 固定使用 Gyan FFmpeg 8.0.1 essentials 静态发行包，并校验发行 ZIP 的 SHA256。复制同一发行包中的 `ffmpeg.exe`、`ffprobe.exe`、上游 LICENSE、README 和两个工具的文件校验清单，不携带 ffplay 或开发工具。打包时实际生成短视频，再用随包 ffprobe 检查时长与尺寸。应用不修改用户 PATH，也不在用户首次导入时下载运行包。

应用和 CLI 从自身位置解析 `agent-host/media-runtime/` 中的工具，不依赖当前工作目录。此目录随已有的 `agent-host` 整组更新和回滚，兼容已经发布的 Windows 更新器。原独立 `media-runtime/` 仍可读取，新包内的工具优先。`CANVAS_FFMPEG_PATH`、`CANVAS_FFPROBE_PATH` 的显式配置优先，配置无效时不得暗中回退。Windows 子进程隐藏控制台。

音视频入库时尽力补齐缺失时长和视频尺寸；检查失败仍保留已保存的原始文件。旧资源在作为生成参考时，由资源服务验证归属、读取本地文件、检查并保存缺失字段。检查使用 12 秒上限并响应任务取消，禁止探测过程访问网络；字段仍缺失、工具不可用、坏文件或保存失败时，在提交上游前停止。已有完整字段不重复探测。macOS 随包工具与 Linux 的安装依赖见 [本地参考素材检查工具](./media-metadata-runtime.md)，不能将 Windows 随包验证当成其他平台的发布验证。

发行包采用 GPL v3，作为独立进程运行，不改变 BeefTV 源代码的 MIT 声明。分发时须保留上游许可证、构建说明及对应源码获取信息；发布负责人应核对 FFmpeg 和该构建所含外部库的对应源码提供方式。FFmpeg 核心源码提交：`894da5ca7d`，完整构建说明随包保留在 `agent-host/media-runtime/README.txt`。

验收至少覆盖：校验失败时不生成运行包、带中文和空格的搬移目录、测试进程 PATH 中无 FFmpeg/ffprobe 时 H.265 → H.264 后读取真实时长和尺寸、原文件哈希不变、原生可播放素材不请求转码、重用预览、失败重试、串行转换、按用户清理缓存、更新及回滚时整组移动运行包。`TestBundledWindowsHEVCWithoutSystemFFmpeg` 必须在实际随包目录下由原生 Windows 执行。源码合并不等于正式 Windows 包已经发布。
