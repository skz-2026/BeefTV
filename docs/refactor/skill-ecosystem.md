# Skill 生态本地实现

本轮实现市场先行的 Skill 生态，不加载第三方代码插件。内置助手继续使用 Pi Durable 1.2.0，由 Go 决定资源可见性、活动固定版本、权限及付费操作。官网、桌面市场和外部 Agent 共用账号后端的 SkillHub 发布合同。

## 用户路径

- 官网 `/skills` 与应用“扩展”发现技能；详情固定到 releaseId，安装前确认。链接为 `beeftv://skills/install?id=<skillId>&version=<releaseId>`。唤起只打开预览，不自动安装。官网也可下载ZIP，应用可导入文件。
- 已安装技能可更新、回滚，或复制为私人草稿改写。复制保留参考文件和许可证；后续编辑不修改市场原版本。安装失败不改变旧版本，在途任务保留原pin。
- 文件投稿：官网选择Markdown或ZIP，预览文件，明确上传，再确认公开资料送审。
- 内置Agent投稿：`skill.draft`把方法整理为私人技能，`skill.publish.prepare`创建固定文件快照，`skill.publish.status`读取状态。用户在画布确认卡完成上传和送审；这两个动作没有注册为模型工具。模型看不到投稿凭据。
- 外部Agent投稿：官网“通过对话投稿”提供公开发布Skill及无依赖Node CLI。浏览器批准独立限权授权，CLI本地保存短时凭据；不依赖桌面程序，不使用模型API Key。上传绑定实际文件和元信息摘要，送审绑定服务端revision与previewDigest。
- 云端作者只能维护自己的稿件。管理员复核后发布不可变Release，可停止后续分发。作者不能自己审核发布。

## 本地边界

`internal/skillhub`负责可信市场HTTP协议和可选独立Ed25519验签；`internal/skills/market*`负责归属、固定确认快照、授权及安装；现有skills/skill_versions/skill_files/user_skill_states负责本地包和版本，不另建包数据库。

ZIP下载先校验archiveSha256，再解包校验按排序路径+NUL+内容+NUL计算的contentHash及逐文件sha256，最后提交本地版本指针。发布使用与用户确认相同的文件快照，不将画布或对话加入上传包。

活动技能状态见[技能上下文](./assistant-skill-context.md)。历史引用和活动选择分开；clear保留历史，新独立任务经官方reset隔离旧规则。模型发送前的admission检查必须成功，不能依赖会被SDK捕获的hook异常。

需要制作记录的普通画布，可在已有生成节点菜单选择“关联制作记录”，明确项目、章节、镜头和阶段。复用既有workflow、shot revision及artifact，关联原task/resource，不创建生成任务。镜头修改使章节和项目汇总流程的相关确认失效，历史产物保留。Eagle启停使用后端持久状态。

## 连接与运行

账号后端：`/api/beeftv/skillhub/v1`，精确接口见BeefAPI的`docs/beeftv-skillhub-api.md`与OpenAPI。官网页面、代理、公开Skill/CLI见网站`docs/skillhub/README.md`。

桌面默认地址为`https://beeftv.app/api/beeftv/skillhub/v1`。显式开发配置`BEEFTV_SKILLHUB_URL`允许回环HTTP；生产必须HTTPS。下载不允许跳转到任意源。签名公钥使用独立部署配置`BEEFTV_SKILLHUB_TRUSTED_KEYS`（keyId到base64 Ed25519 public key的JSON映射）；`BEEFTV_SKILLHUB_REQUIRE_SIGNATURE=true`要求签名。不能从同一次目录下载中自动信任新的公钥，也不复用桌面更新签名。

授权文件保存在工作区`skill-market/<user-hash>/authorization.json`，仅当前用户读取，0600，30分钟到期或可撤销。`plans/`存用户已准备的不可变上传快照。模型工具没有上传/送审入口，UI确认请求要求确切hash、revision及预览摘要。审核和发布的最终状态来自账号服务。

## 验证与发布

本地Go/SQLite、真实路由与网页验证不代表生产发布。所有测试使用临时账号、临时数据库和合成素材；不包含付费生成。发布前还需完成Lucas界面交叉review、目标账号后端部署、签名信任配置、国内网络下载、macOS/Windows打包唤起与升级、以及真实创作质量验收。

数据库v17新增活动技能及幂等变更表，v18为每个技能版本保存市场来源与许可信息；旧对话和产物不改写。发布回退先关闭市场写入/入口，不删除用户已装包或素材。升级后的工作区不得用旧二进制直接写入，恢复应使用升级前完整备份。
