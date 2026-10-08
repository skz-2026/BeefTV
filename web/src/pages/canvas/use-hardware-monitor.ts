import { useQuery } from "@tanstack/react-query";

import { fetchSystemHardwareStats, type SystemHardwareStats } from "@/services/api/system";

// 画布硬件监控浮窗的数据源：面板可见时按 2s 轮询，后端有 900ms 采样缓存兜底多标签页场景。
export function useHardwareMonitor(enabled: boolean) {
    const query = useQuery<SystemHardwareStats>({
        queryKey: ["system-hardware"],
        queryFn: fetchSystemHardwareStats,
        enabled,
        refetchInterval: 2_000,
        refetchOnWindowFocus: false,
    });
    return { stats: query.data ?? null, loading: query.isLoading, error: query.isError };
}
