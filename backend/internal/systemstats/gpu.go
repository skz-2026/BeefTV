package systemstats

import (
	"context"
	"os/exec"
	"strconv"
	"strings"
	"time"
)

// gpuProbeTimeout 约束 nvidia-smi 单次调用；驱动卡顿时宁可让浮窗显示缺失，也不拖住请求。
const gpuProbeTimeout = 3 * time.Second

// probeGPU 通过 nvidia-smi 读取第一块 GPU 的占用/温度/显存；命令不可用或解析失败时返回 nil。
// 没有可长期复用的句柄，每次快照重新执行轻量查询命令。
func probeGPU(ctx context.Context) *GPUStatus {
	probeCtx, cancel := context.WithTimeout(ctx, gpuProbeTimeout)
	defer cancel()
	output, err := exec.CommandContext(probeCtx, "nvidia-smi", "--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu", "--format=csv,noheader,nounits").Output()
	if err != nil {
		return nil
	}
	for _, line := range strings.Split(string(output), "\n") {
		fields := strings.Split(strings.TrimSpace(line), ",")
		if len(fields) < 5 {
			continue
		}
		status := &GPUStatus{Name: strings.TrimSpace(fields[0])}
		if utilization, err := strconv.ParseFloat(strings.TrimSpace(fields[1]), 64); err == nil {
			status.UtilizationPercent = &utilization
		}
		if usedMiB, err := strconv.ParseFloat(strings.TrimSpace(fields[2]), 64); err == nil {
			status.VRAMUsedBytes = uint64(usedMiB * 1024 * 1024)
		}
		if totalMiB, err := strconv.ParseFloat(strings.TrimSpace(fields[3]), 64); err == nil {
			status.VRAMTotalBytes = uint64(totalMiB * 1024 * 1024)
		}
		if temperature, err := strconv.ParseFloat(strings.TrimSpace(fields[4]), 64); err == nil {
			status.TemperatureC = &temperature
		}
		return status
	}
	return nil
}
