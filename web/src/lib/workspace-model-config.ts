// 工作区模型配置（后端 local-model-config.json）与浏览器本地快照之间的迁移判定。
export function shouldMigrateLocalModelConfig({ health, localChannelCount }: { health: string; localChannelCount: number }) {
    return health === "default" && localChannelCount > 0;
}
