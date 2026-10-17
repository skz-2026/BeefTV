package editing

import (
	"fmt"
	"infinite-canvas/backend/internal/mediatools"
	"math"
	"strings"
)

const (
	FFmpegPathEnv    = mediatools.FFmpegPathEnv
	SubtitleFileName = "render-subtitles.srt"
)

// ResolveFFmpegBinary returns the native ffmpeg executable.
// A configured CANVAS_FFMPEG_PATH is used as-is so tests can inject a missing binary
// without LookPath succeeding on a different ffmpeg.
func ResolveFFmpegBinary() (string, error) {
	return mediatools.ResolveFFmpeg()
}

// BuildFFmpegArgs lowers a compiled plan into one native ffmpeg filter_complex graph.
// files maps opaque source ids to paths relative to the command working directory
// (or absolute paths). Missing source files return nil so execution cannot succeed
// after dropping content. This function does not re-select or reorder plan clips.
func BuildFFmpegArgs(plan Plan, files map[string]string, target string) []string {
	if len(plan.Segments) == 0 {
		return nil
	}
	width, height, fps, rate := plan.Output.Width, plan.Output.Height, plan.Output.FPS, plan.Output.SampleRate
	if width <= 0 {
		width = DefaultWidth
	}
	if height <= 0 {
		height = DefaultHeight
	}
	if fps <= 0 {
		fps = DefaultFPS
	}
	if rate <= 0 {
		rate = DefaultSampleRate
	}
	args := []string{"-nostdin", "-y"}
	filters := []string{}
	labels := ""
	for i, seg := range plan.Segments {
		duration := float64(seg.DurationMs) / 1000
		seconds := fmt.Sprintf("%.3f", duration)
		path := files[seg.SourceID]
		if seg.Kind != KindGap && path == "" {
			return nil
		}
		switch seg.Kind {
		case KindGap:
			args = append(args, "-f", "lavfi", "-t", seconds, "-i", fmt.Sprintf("color=c=black:s=%dx%d:r=%d", width, height, fps))
		case KindImage:
			args = append(args, "-loop", "1", "-t", seconds, "-i", path)
		default:
			args = append(args, "-ss", fmt.Sprintf("%.3f", float64(seg.SourceStartMs)/1000), "-t", seconds, "-i", path)
		}
		if seg.Kind == KindVideo && seg.HasAudio && !seg.Muted {
			args = append(args, "-ss", fmt.Sprintf("%.3f", float64(seg.SourceStartMs)/1000), "-t", seconds, "-i", path)
		} else {
			args = append(args, "-f", "lavfi", "-t", seconds, "-i", fmt.Sprintf("anullsrc=r=%d:cl=stereo", rate))
		}
		volume := seg.Volume
		filters = append(filters, fmt.Sprintf("[%d:v]setpts=PTS-STARTPTS,fps=%d,scale=%d:%d:force_original_aspect_ratio=decrease,pad=%d:%d:(ow-iw)/2:(oh-ih)/2,setsar=1,tpad=stop_mode=clone:stop_duration=%.3f,trim=duration=%.3f[v%d]", 2*i, fps, width, height, width, height, duration, duration, i))
		filters = append(filters, fmt.Sprintf("[%d:a]aformat=sample_fmts=fltp:sample_rates=%d:channel_layouts=stereo,asetpts=PTS-STARTPTS,volume=%.3f,apad,atrim=duration=%.3f%s[a%d]", 2*i+1, rate, volume, duration, audioFades(seg.FadeInMs, seg.FadeOutMs, seg.DurationMs), i))
		labels += fmt.Sprintf("[v%d][a%d]", i, i)
	}
	filters = append(filters, fmt.Sprintf("%sconcat=n=%d:v=1:a=1[vbase][abase]", labels, len(plan.Segments)))
	mix := "[abase]"
	for i, seg := range plan.Audio {
		path := files[seg.SourceID]
		if path == "" {
			return nil
		}
		args = append(args, "-ss", fmt.Sprintf("%.3f", float64(seg.SourceStartMs)/1000), "-t", fmt.Sprintf("%.3f", float64(seg.DurationMs)/1000), "-i", path)
		volume := seg.Volume
		if seg.Muted {
			volume = 0
		}
		filters = append(filters, fmt.Sprintf("[%d:a]aformat=sample_fmts=fltp:sample_rates=%d:channel_layouts=stereo,asetpts=PTS-STARTPTS,volume=%.3f,apad,atrim=duration=%.3f%s,adelay=%d:all=1[extra%d]", 2*len(plan.Segments)+i, rate, volume, float64(seg.DurationMs)/1000, audioFades(seg.FadeInMs, seg.FadeOutMs, seg.DurationMs), seg.StartMs, i))
		mix += fmt.Sprintf("[extra%d]", i)
	}
	filters = append(filters, fmt.Sprintf("%samix=inputs=%d:duration=first:normalize=0,atrim=duration=%.3f[aout]", mix, len(plan.Audio)+1, float64(plan.DurationMs)/1000))
	// 图片叠加层（信息卡等）：输入接在视觉/音频输入之后，逐层 overlay 在 [vbase] 上，
	// 再烧字幕——字卡在画面上方、字幕保持在最顶层。
	overlayBase := 2*len(plan.Segments) + len(plan.Audio)
	for i := range plan.Overlays {
		path := files[plan.Overlays[i].SourceID]
		if path == "" {
			return nil
		}
		args = append(args, "-loop", "1", "-i", path)
	}
	videoChain := "[vbase]"
	for i, ov := range plan.Overlays {
		ow := max(1, int(math.Round(float64(width)*ov.W)))
		oh := max(1, int(math.Round(float64(height)*ov.H)))
		ox := int(math.Round(float64(width) * ov.X))
		oy := int(math.Round(float64(height) * ov.Y))
		start := float64(ov.StartMs) / 1000
		end := float64(ov.StartMs+ov.DurationMs) / 1000
		out := fmt.Sprintf("[vo%d]", i)
		filters = append(filters, fmt.Sprintf("[%d:v]scale=%d:%d,setsar=1,format=rgba[ovl%d]", overlayBase+i, ow, oh, i))
		filters = append(filters, fmt.Sprintf("%s[ovl%d]overlay=x=%d:y=%d:enable='between(t,%.3f,%.3f)'%s", videoChain, i, ox, oy, start, end, out))
		videoChain = out
	}
	if plan.Output.BurnSubtitles && plan.SubtitleSRT != "" {
		// 固定相对文件名避免工作目录/字幕文本进入滤镜表达式。
		filters = append(filters, fmt.Sprintf("%ssubtitles=filename=%s[vout]", videoChain, SubtitleFileName))
	} else {
		filters = append(filters, videoChain+"null[vout]")
	}
	args = append(args, "-filter_complex", strings.Join(filters, ";"), "-map", "[vout]", "-map", "[aout]", "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", "-t", fmt.Sprintf("%.3f", float64(plan.DurationMs)/1000), target)
	return args
}

func audioFades(fadeInMs, fadeOutMs, durationMs int64) string {
	filters := ""
	if duration := min(fadeInMs, durationMs); duration > 0 {
		filters += fmt.Sprintf(",afade=t=in:st=0:d=%.3f", float64(duration)/1000)
	}
	if duration := min(fadeOutMs, durationMs); duration > 0 {
		filters += fmt.Sprintf(",afade=t=out:st=%.3f:d=%.3f", float64(durationMs-duration)/1000, float64(duration)/1000)
	}
	return filters
}
