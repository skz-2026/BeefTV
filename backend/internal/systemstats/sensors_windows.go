//go:build windows

package systemstats

import (
	"math"
	"sort"
	"strings"

	"github.com/yusufpapurcu/wmi"
)

// Win32_LogicalDisk DriveType=3 为固定本地磁盘；网络盘和可移动盘不进监控，
// 也避免对失联网络盘的用量查询阻塞采集。
type logicalDiskStat struct {
	DeviceID  string
	Size      uint64
	FreeSpace uint64
}

func platformDisks() []DiskStatus {
	var records []logicalDiskStat
	if err := wmi.Query("SELECT DeviceID, Size, FreeSpace FROM Win32_LogicalDisk WHERE DriveType = 3", &records); err != nil {
		return []DiskStatus{}
	}
	sort.Slice(records, func(i, j int) bool { return records[i].DeviceID < records[j].DeviceID })
	disks := make([]DiskStatus, 0, len(records))
	for _, record := range records {
		if record.Size == 0 {
			continue
		}
		used := record.Size - record.FreeSpace
		disks = append(disks, DiskStatus{
			Mount:      record.DeviceID,
			Percent:    float64(used) / float64(record.Size) * 100,
			UsedBytes:  used,
			TotalBytes: record.Size,
		})
		if len(disks) >= maxDisks {
			break
		}
	}
	return disks
}

type smartAttributeBlock struct {
	InstanceName   string
	VendorSpecific []byte
}

// diskTemperatures 读取 SATA 盘 SMART 194(温度)/190(气流温度)（root\wmi）。
// NVMe 或无驱动支持时查询失败，返回空由调用方按缺失处理。
func diskTemperatures() []float64 {
	var records []smartAttributeBlock
	if err := wmi.QueryNamespace("SELECT InstanceName, VendorSpecific FROM MSStorageDriver_FailurePredictData", &records, "root/wmi"); err != nil {
		return nil
	}
	temperatures := make([]float64, 0, len(records))
	for _, record := range records {
		if temperature, ok := smartTemperature(record.VendorSpecific); ok {
			temperatures = append(temperatures, temperature)
		}
	}
	return temperatures
}

// smartTemperature 解析 SMART 属性表：每项 12 字节（ID、标志×2、当前值、原始值×8），
// 温度取原始值首字节。
func smartTemperature(data []byte) (float64, bool) {
	if raw, ok := smartRawValue(data, 194); ok && plausibleTemperature(raw) {
		return float64(raw), true
	}
	if raw, ok := smartRawValue(data, 190); ok && plausibleTemperature(raw) {
		return float64(raw), true
	}
	return 0, false
}

func smartRawValue(data []byte, id byte) (byte, bool) {
	for i := 0; i+12 <= len(data); i += 12 {
		if data[i] != id {
			continue
		}
		return data[i+4], true
	}
	return 0, false
}

func plausibleTemperature(raw byte) bool { return raw > 0 && raw < 100 }

type acpiThermalZoneStat struct {
	InstanceName       string
	CurrentTemperature uint32
}

// platformThermalZones 读取 ACPI 热区温度（root\wmi，单位 0.1 开尔文）。
// 多数机器需要管理员权限，查询失败时返回空。
func platformThermalZones() []ThermalZoneStatus {
	var records []acpiThermalZoneStat
	if err := wmi.QueryNamespace("SELECT InstanceName, CurrentTemperature FROM MSAcpi_ThermalZoneTemperature", &records, "root/wmi"); err != nil {
		return []ThermalZoneStatus{}
	}
	zones := make([]ThermalZoneStatus, 0, len(records))
	for _, record := range records {
		celsius := float64(record.CurrentTemperature)/10 - 273.15
		if celsius <= -20 || celsius >= 120 {
			continue
		}
		zones = append(zones, ThermalZoneStatus{Name: thermalZoneLabel(record.InstanceName), TemperatureC: math.Round(celsius*10) / 10})
	}
	return zones
}

func thermalZoneLabel(instanceName string) string {
	name := instanceName
	if idx := strings.Index(name, "\\"); idx >= 0 {
		name = name[:idx]
	}
	if name = strings.TrimSpace(name); name == "" {
		name = "热区"
	}
	return name
}
