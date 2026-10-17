package motion

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func buildTemplateZip(t *testing.T, mutate func(entries map[string][]byte) map[string][]byte) []byte {
	t.Helper()
	motionJSON := `{
  "format": "motiongit-template",
  "specVersion": "0.1.0-draft.1",
  "template": {"id": "kinetic-tech", "version": "0.2.7-open-beta", "name": "Kinetic Tech"},
  "runtime": {"profile": "kinetic-user-core/1", "entry": "adapter.py"},
  "parameters": {"schema": "params.schema.json"},
  "output": {"width": 1920, "height": 1080, "fps": {"num": 60, "den": 1}}
}`
	entries := map[string][]byte{
		"motion.json":        []byte(motionJSON),
		"adapter.py":         []byte("# /// script\n# requires-python = \">=3.11\"\n# ///\n"),
		"params.schema.json": []byte(`{"type":"object","required":["mode"],"properties":{"mode":{"const":"user-media"}}}`),
		"core/index.html":    []byte("<html></html>"),
	}
	if mutate != nil {
		entries = mutate(entries)
	}
	var buf bytes.Buffer
	writer := zip.NewWriter(&buf)
	for name, data := range entries {
		file, err := writer.Create(name)
		if err != nil {
			t.Fatalf("create zip entry: %v", err)
		}
		if _, err := file.Write(data); err != nil {
			t.Fatalf("write zip entry: %v", err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatalf("close zip: %v", err)
	}
	return buf.Bytes()
}

func importFixture(t *testing.T, data []byte) (*Store, *TemplateSummary) {
	t.Helper()
	store := NewStore(t.TempDir(), "user-a")
	summary, err := store.ImportArchive(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		t.Fatalf("ImportArchive: %v", err)
	}
	return store, summary
}

func TestImportAndVerifyRoundtrip(t *testing.T) {
	store, summary := importFixture(t, buildTemplateZip(t, nil))

	if summary.TemplateID != "kinetic-tech" || summary.VersionID != "0.2.7-open-beta" {
		t.Fatalf("unexpected identity: %+v", summary)
	}
	if summary.FPS != 60 || summary.Width != 1920 || summary.Height != 1080 {
		t.Fatalf("unexpected output: %+v", summary)
	}
	var schema map[string]any
	if err := json.Unmarshal(summary.ParamsSchema, &schema); err != nil {
		t.Fatalf("params schema not JSON: %v", err)
	}

	verified, err := store.Verify(Pin{TemplateID: summary.TemplateID, VersionID: summary.VersionID, ContentDigest: summary.ContentDigest})
	if err != nil {
		t.Fatalf("Verify: %v", err)
	}
	if verified.Dir == "" || !strings.HasSuffix(filepath.ToSlash(verified.Dir), "kinetic-tech/0.2.7-open-beta") {
		t.Fatalf("unexpected template dir: %s", verified.Dir)
	}

	// 列表投影包含导入的版本。
	list, err := store.List()
	if err != nil || len(list) != 1 {
		t.Fatalf("List: %v, len=%d", err, len(list))
	}
}

func TestImportIdempotentOnSameContent(t *testing.T) {
	data := buildTemplateZip(t, nil)
	store, first := importFixture(t, data)
	second, err := store.ImportArchive(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		t.Fatalf("re-import: %v", err)
	}
	if second.ContentDigest != first.ContentDigest {
		t.Fatalf("digest drifted between identical imports")
	}
}

func TestImportRejectsContentMismatchOnSameVersion(t *testing.T) {
	store, _ := importFixture(t, buildTemplateZip(t, nil))
	mutated := buildTemplateZip(t, func(entries map[string][]byte) map[string][]byte {
		entries["core/index.html"] = []byte("<html>changed</html>")
		return entries
	})
	if _, err := store.ImportArchive(bytes.NewReader(mutated), int64(len(mutated))); err == nil {
		t.Fatal("same version with different content must be rejected")
	}
}

func TestVerifyRejectsTamperedFiles(t *testing.T) {
	store, summary := importFixture(t, buildTemplateZip(t, nil))
	target := filepath.Join(summary.Dir, "core", "index.html")
	if err := os.WriteFile(target, []byte("<html>tampered</html>"), 0o644); err != nil {
		t.Fatalf("tamper: %v", err)
	}
	if _, err := store.Verify(Pin{TemplateID: summary.TemplateID, VersionID: summary.VersionID, ContentDigest: summary.ContentDigest}); err == nil {
		t.Fatal("tampered template must fail Verify")
	}
}

func TestVerifyRejectsDigestMismatch(t *testing.T) {
	store, summary := importFixture(t, buildTemplateZip(t, nil))
	pin := Pin{TemplateID: summary.TemplateID, VersionID: summary.VersionID, ContentDigest: strings.Repeat("a", 64)}
	if _, err := store.Verify(pin); err == nil {
		t.Fatal("foreign content digest must fail Verify")
	}
	_ = store
}

func TestImportRejectsUnsupportedSpec(t *testing.T) {
	data := buildTemplateZip(t, func(entries map[string][]byte) map[string][]byte {
		var spec map[string]any
		if err := json.Unmarshal(entries["motion.json"], &spec); err != nil {
			t.Fatalf("unmarshal: %v", err)
		}
		spec["specVersion"] = "9.9.9"
		raw, _ := json.Marshal(spec)
		entries["motion.json"] = raw
		return entries
	})
	if _, err := (NewStore(t.TempDir(), "user-a")).ImportArchive(bytes.NewReader(data), int64(len(data))); err == nil {
		t.Fatal("unsupported spec must be rejected")
	}
}

func TestImportRejectsUnsafeEntryPath(t *testing.T) {
	var buf bytes.Buffer
	writer := zip.NewWriter(&buf)
	file, _ := writer.Create("../escape.txt")
	_, _ = file.Write([]byte("bad"))
	_ = writer.Close()
	if _, err := (NewStore(t.TempDir(), "user-a")).ImportArchive(bytes.NewReader(buf.Bytes()), int64(buf.Len())); err == nil {
		t.Fatal("zip-slip entry must be rejected")
	}
}

func TestImportStripsSingleTopLevelDirectory(t *testing.T) {
	var buf bytes.Buffer
	writer := zip.NewWriter(&buf)
	files := map[string]string{
		"pkg/motion.json":        `{"format":"motiongit-template","specVersion":"0.1.0-draft.1","template":{"id":"t","version":"1","name":"T"},"runtime":{"entry":"adapter.py"},"parameters":{"schema":"params.schema.json"},"output":{"width":16,"height":9,"fps":{"num":30,"den":1}}}`,
		"pkg/params.schema.json": `{"type":"object"}`,
		"pkg/adapter.py":         "# stub",
	}
	for name, content := range files {
		file, _ := writer.Create(name)
		_, _ = file.Write([]byte(content))
	}
	_ = writer.Close()
	store := NewStore(t.TempDir(), "user-a")
	summary, err := store.ImportArchive(bytes.NewReader(buf.Bytes()), int64(buf.Len()))
	if err != nil {
		t.Fatalf("ImportArchive with top-level dir: %v", err)
	}
	if _, err := store.Verify(Pin{TemplateID: "t", VersionID: "1", ContentDigest: summary.ContentDigest}); err != nil {
		t.Fatalf("Verify after strip: %v", err)
	}
}
