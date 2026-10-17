package editing

import (
	"encoding/json"
	"strings"
	"testing"
)

func overlayProject() Project {
	return Project{
		Version: ProjectVersion,
		Tracks:  []Track{{ID: "v1", Kind: KindVideo}},
		Clips: []Clip{{
			ID: "c1", Kind: KindVideo, TrackID: "v1", StartMs: 0, DurationMs: 4000, Volume: 1,
			DirectMedia: &DirectMedia{ID: "seg", Kind: KindVideo, StorageKey: "resource:seg"},
		}},
		DurationMs: 4000,
	}
}

func TestCompileOverlaysClampsAndDrops(t *testing.T) {
	opts := DefaultOptions()
	opts.Width, opts.Height, opts.FPS = 704, 1280, 24
	opts.Overlays = []OverlaySpec{
		{SourceID: "card-b", StartMs: 2000, DurationMs: 5000, X: -0.2, Y: 0.1, W: 1.7, H: 0.5}, // 时间窗截断 + 坐标 clamp
		{SourceID: "card-a", StartMs: 0, DurationMs: 1500, X: 0.08, Y: 0.1, W: 0.6, H: 0.2},
		{SourceID: "card-zero", StartMs: 0, DurationMs: 800, W: 0, H: 0},                       // 零尺寸丢弃
		{SourceID: "card-late", StartMs: 9000, DurationMs: 500, W: 0.2, H: 0.1},                // 完全出窗丢弃
	}
	plan, err := Compile(overlayProject(), nil, opts)
	if err != nil {
		t.Fatalf("compile: %v", err)
	}
	if len(plan.Overlays) != 2 {
		t.Fatalf("want 2 overlays, got %d", len(plan.Overlays))
	}
	first := plan.Overlays[0]
	if first.SourceID != "card-a" || first.StartMs != 0 || first.DurationMs != 1500 {
		t.Fatalf("first overlay not sorted/normalized: %+v", first)
	}
	second := plan.Overlays[1]
	if second.StartMs != 2000 || second.DurationMs != 2000 {
		t.Fatalf("time window not clamped to plan duration: %+v", second)
	}
	if second.X != 0 || second.W != 1 {
		t.Fatalf("coords not clamped to [0,1]: %+v", second)
	}
	ids := plan.VisualSourceIDs()
	joined := strings.Join(ids, ",")
	if !strings.Contains(joined, "card-a") || !strings.Contains(joined, "card-b") || strings.Contains(joined, "card-zero") {
		t.Fatalf("overlay sources not part of materialization set: %v", ids)
	}
}

func TestCompileOverlaysRejectsInvalid(t *testing.T) {
	opts := DefaultOptions()
	opts.Overlays = []OverlaySpec{{SourceID: " ", StartMs: 0, DurationMs: 500, W: 0.5, H: 0.2}}
	if _, err := Compile(overlayProject(), nil, opts); err == nil {
		t.Fatal("empty source id must be rejected")
	}
	opts.Overlays = []OverlaySpec{{SourceID: "card", StartMs: -1, DurationMs: 500, W: 0.5, H: 0.2}}
	if _, err := Compile(overlayProject(), nil, opts); err == nil {
		t.Fatal("negative start must be rejected")
	}
}

func TestBuildFFmpegArgsOverlayChain(t *testing.T) {
	burn := false
	plan := &Plan{
		Version: PlanVersion,
		Output:  Output{Width: 704, Height: 1280, FPS: 24, SampleRate: 44100, BurnSubtitles: burn},
		Segments: []Segment{{
			Kind: KindVideo, ClipID: "c1", SourceID: "seg", StartMs: 0, DurationMs: 4000, Volume: 1, HasAudio: true,
		}},
		Overlays: []Overlay{
			{SourceID: "card", StartMs: 300, DurationMs: 1500, X: 0.08, Y: 0.1, W: 0.6, H: 0.2},
		},
	}
	files := map[string]string{"seg": "src-0.mp4", "card": "src-1.mp4"}
	args := BuildFFmpegArgs(*plan, files, "out.mp4")
	if args == nil {
		t.Fatal("args must build")
	}
	joined := strings.Join(args, " ")
	// overlay 输入在视觉(2)+音频(2)+额外音频(0)之后，索引 2
	if !strings.Contains(joined, "-loop 1 -i src-1.mp4") {
		t.Fatalf("overlay input missing: %s", joined)
	}
	if !strings.Contains(joined, "[2:v]scale=422:256,setsar=1,format=rgba[ovl0]") {
		t.Fatalf("overlay scale filter wrong: %s", joined)
	}
	if !strings.Contains(joined, "[vbase][ovl0]overlay=x=56:y=128:enable='between(t,0.300,1.800)'[vo0]") {
		t.Fatalf("overlay chain wrong: %s", joined)
	}
	if !strings.Contains(joined, "[vo0]null[vout]") {
		t.Fatalf("output chain must start from last overlay: %s", joined)
	}
}

func TestOverlaySpecJSONRoundTrip(t *testing.T) {
	raw := `{"sourceId":"card","startMs":300,"durationMs":1500,"x":0.08,"y":0.1,"w":0.6,"h":0.2}`
	var spec OverlaySpec
	if err := json.Unmarshal([]byte(raw), &spec); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if spec.SourceID != "card" || spec.StartMs != 300 || spec.W != 0.6 {
		t.Fatalf("round trip mismatch: %+v", spec)
	}
}
