//go:build !windows

package systemstats

import (
	"sort"

	"github.com/shirou/gopsutil/v4/disk"
)

// platformDisks 非 Windows 平台用 gopsutil 枚举挂载点；温度与热区传感器各平台
// 实现差异大（powermetrics/smartctl 均需提权），先不采集。
func platformDisks() []DiskStatus {
	partitions, err := disk.Partitions(false)
	if err != nil {
		return []DiskStatus{}
	}
	sort.Slice(partitions, func(i, j int) bool { return partitions[i].Mountpoint < partitions[j].Mountpoint })
	disks := make([]DiskStatus, 0, len(partitions))
	for _, partition := range partitions {
		if partition.Mountpoint == "" {
			continue
		}
		usage, err := disk.Usage(partition.Mountpoint)
		if err != nil || usage.Total == 0 {
			continue
		}
		disks = append(disks, DiskStatus{
			Mount:      partition.Mountpoint,
			Percent:    usage.UsedPercent,
			UsedBytes:  usage.Used,
			TotalBytes: usage.Total,
		})
		if len(disks) >= maxDisks {
			break
		}
	}
	return disks
}

func diskTemperatures() []float64 { return nil }

func platformThermalZones() []ThermalZoneStatus { return []ThermalZoneStatus{} }
