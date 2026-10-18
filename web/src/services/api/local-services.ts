import { http } from "./request";

/**
 * 本地视频服务（ComfyUI 8188 + ComfyUI 视频网关 8765）不在后端进程里，
 * 默认由开发栈脚本拉起。它们没起来时生成任务会在建连阶段直接失败，
 * 所以页面在生成前先问一次状态，必要时让后端帮忙拉起来。
 */
export type LocalServiceStep = {
    name: string;
    running: boolean;
    started?: boolean;
    port: number;
    message?: string;
};

export type LocalServiceState = {
    name: string;
    running: boolean;
    port?: number;
    steps?: LocalServiceStep[];
    message?: string;
};

export type LocalServiceName = "comfy-gateway" | "comfyui" | "video-stack";

export function getLocalService(name: LocalServiceName) {
    return http.get<LocalServiceState>(`/local-services/${name}`);
}

export function startLocalService(name: LocalServiceName) {
    return http.post<LocalServiceState>(`/local-services/${name}/start`, {});
}
