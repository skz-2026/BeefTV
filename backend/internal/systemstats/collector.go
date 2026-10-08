// Package systemstats 采集本机硬件遥测快照（CPU、内存、GPU、磁盘、热区温度），
// 供画布硬件监控浮窗低频轮询。全部只读、不落库；单源失败按缺失处理。
package systemstats

import (
	"context"
	"sync"
	"time"

	"github.com/shirou/gopsutil/v4/cpu"
	"github.com/shirou/gopsutil/v4/mem"
)

// cacheTTL 略低于前端 2s 轮询：多标签页同时打开浮窗时合并采样，又不让单标签页读到明显过期值。
const cacheTTL = 900 * time.Millisecond

// maxDisks 限制监控面板的磁盘行数，更多磁盘对监控没有增量价值。
const maxDisks = 4

type CPUStatus struct {
	Percent float64 `json:"percent"`
}

type MemoryStatus struct {
	Percent    float64 `json:"percent"`
	UsedBytes  uint64  `json:"usedBytes"`
	TotalBytes uint64  `json:"totalBytes"`
}

type GPUStatus struct {
	Name               string   `json:"name"`
	UtilizationPercent *float64 `json:"utilizationPercent"`
	TemperatureC       *float64 `json:"temperatureC"`
	VRAMUsedBytes      uint64   `json:"vramUsedBytes"`
	VRAMTotalBytes     uint64   `json:"vramTotalBytes"`
}

type DiskStatus struct {
	Mount        string   `json:"mount"`
	Percent      float64  `json:"percent"`
	UsedBytes    uint64   `json:"usedBytes"`
	TotalBytes   uint64   `json:"totalBytes"`
	TemperatureC *float64 `json:"temperatureC"`
}

type ThermalZoneStatus struct {
	Name         string  `json:"name"`
	TemperatureC float64 `json:"temperatureC"`
}

type Snapshot struct {
	CollectedAt  time.Time           `json:"collectedAt"`
	CPU          CPUStatus           `json:"cpu"`
	Memory       MemoryStatus        `json:"memory"`
	GPU          *GPUStatus          `json:"gpu"`
	Disks        []DiskStatus        `json:"disks"`
	ThermalZones []ThermalZoneStatus `json:"thermalZones"`
}

type Collector struct {
	mu   sync.Mutex
	last Snapshot
	at   time.Time
}

func NewCollector() *Collector { return &Collector{} }

func (c *Collector) Snapshot(ctx context.Context) Snapshot {
	c.mu.Lock()
	defer c.mu.Unlock()
	if !c.at.IsZero() && time.Since(c.at) < cacheTTL {
		return c.last
	}
	snapshot := Snapshot{
		CollectedAt:  time.Now(),
		Disks:        []DiskStatus{},
		ThermalZones: platformThermalZones(),
	}
	if percents, err := cpu.Percent(0, false); err == nil && len(percents) > 0 {
		snapshot.CPU = CPUStatus{Percent: percents[0]}
	}
	if memory, err := mem.VirtualMemory(); err == nil {
		snapshot.Memory = MemoryStatus{Percent: memory.UsedPercent, UsedBytes: memory.Used, TotalBytes: memory.Total}
	}
	snapshot.GPU = probeGPU(ctx)
	snapshot.Disks = attachDiskTemperatures(platformDisks(), diskTemperatures())
	c.last = snapshot
	c.at = time.Now()
	return snapshot
}

// attachDiskTemperatures 按顺序配对温度与磁盘：SMART 查询不提供盘符映射，只能尽力对齐；
// 数量对不上时宁缺毋滥，不展示可能错配的温度。
func attachDiskTemperatures(disks []DiskStatus, temperatures []float64) []DiskStatus {
	if len(disks) == 0 || len(temperatures) != len(disks) {
		return disks
	}
	for i := range disks {
		disks[i].TemperatureC = &temperatures[i]
	}
	return disks
}
