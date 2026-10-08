import { http } from "@/services/api/request";

export type SystemCpuStatus = { percent: number };

export type SystemMemoryStatus = { percent: number; usedBytes: number; totalBytes: number };

export type SystemGpuStatus = {
    name: string;
    utilizationPercent: number | null;
    temperatureC: number | null;
    vramUsedBytes: number;
    vramTotalBytes: number;
};

export type SystemDiskStatus = {
    mount: string;
    percent: number;
    usedBytes: number;
    totalBytes: number;
    temperatureC: number | null;
};

export type SystemThermalZoneStatus = { name: string; temperatureC: number };

export type SystemHardwareStats = {
    collectedAt: string;
    cpu: SystemCpuStatus;
    memory: SystemMemoryStatus;
    gpu: SystemGpuStatus | null;
    disks: SystemDiskStatus[];
    thermalZones: SystemThermalZoneStatus[];
};

// 本机硬件遥测快照：供画布硬件监控浮窗低频轮询，缺失源（无 NVIDIA 卡、无传感器权限）为 null/空数组。
export function fetchSystemHardwareStats() {
    return http.get<SystemHardwareStats>("/system/hardware");
}
