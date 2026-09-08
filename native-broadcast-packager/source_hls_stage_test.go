package main

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func sourceStageFixture(t *testing.T) (*sourceHLSStage, *sourceRenderFence) {
	t.Helper()
	o, err := acquireOutputOwnership(t.TempDir(), "res_aaaaaaaaaaaaaaaa", outputTestOwner)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := o.close(); err != nil {
			t.Error(err)
		}
	})
	f := &sourceEncoderFence{writer: func() bool { return true }}
	source := &sourceRenderFence{allowed: func() bool { return true }}
	var g sourceRenderGuard
	g.add(source)
	if !f.Admit(g) {
		t.Fatal("stage generation")
	}
	s, err := newSourceHLSStage(o, f, transcodeAssignment().Profile, 1024*1024)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := s.Invalidate(); err != nil {
			t.Error(err)
		}
	})
	return s, source
}

func sourceStagePlaylist(init string, sequence int) string {
	return fmt.Sprintf("#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:%d\n#EXT-X-INDEPENDENT-SEGMENTS\n#EXT-X-MAP:URI=\"%s\"\n#EXTINF:2.000000,\n#EXT-X-PROGRAM-DATE-TIME:2026-09-08T10:00:00.000+0000\nsegment_%09d.m4s\n", sequence, init, sequence)
}

func sourceStageFiles(t *testing.T, s *sourceHLSStage, sequence int) {
	t.Helper()
	for i, r := range s.profile.Renditions {
		init := renditionInitFilename(len(s.profile.Renditions), i)
		for name, data := range map[string]string{init: "synthetic init", fmt.Sprintf("segment_%09d.m4s", sequence): "synthetic segment", "index.m3u8": sourceStagePlaylist(init, sequence)} {
			if name == init {
				if _, err := os.Stat(filepath.Join(s.pending, r.ID, name)); err == nil {
					continue
				}
			}
			if err := os.WriteFile(filepath.Join(s.pending, r.ID, name), []byte(data), 0600); err != nil {
				t.Fatal(err)
			}
		}
	}
}

func TestSourceHLSStagePublishesExactProfileAndInvalidatesGeneration(t *testing.T) {
	s, source := sourceStageFixture(t)
	if ready, err := s.Publish(); ready || err != nil {
		t.Fatal("empty stage claimed readiness", err)
	}
	sourceStageFiles(t, s, 0)
	if _, err := os.Stat(filepath.Join(s.owner.output, "index.m3u8")); !os.IsNotExist(err) {
		t.Fatal("private encoder output already exposed")
	}
	if ready, err := s.Publish(); !ready || err != nil {
		t.Fatal("publish", err)
	}
	master, err := os.ReadFile(filepath.Join(s.owner.output, "index.m3u8"))
	if err != nil || !strings.Contains(string(master), "low/index.m3u8") || !strings.Contains(string(master), "medium/index.m3u8") {
		t.Fatal("master profile")
	}
	if len(s.published) != 7 {
		t.Fatal("unexpected committed files", len(s.published))
	}
	cycle := s.cycle
	if ready, err := s.Publish(); !ready || err != nil || s.cycle != cycle {
		t.Fatal("unchanged stage churned")
	}
	source.closed.Store(true)
	if ready, err := s.Publish(); ready || err == nil {
		t.Fatal("revoked generation published")
	}
	if err := s.Invalidate(); err != nil {
		t.Fatal(err)
	}
	for _, r := range s.profile.Renditions {
		entries, err := os.ReadDir(filepath.Join(s.owner.output, r.ID))
		if err != nil || len(entries) != 0 {
			t.Fatal("published media survived revoke")
		}
	}
	if _, err := os.Stat(filepath.Join(s.owner.output, "index.m3u8")); !os.IsNotExist(err) {
		t.Fatal("master survived revoke")
	}
	if _, err := os.Stat(filepath.Join(s.pending, "low", "index.m3u8")); err != nil {
		t.Fatal("staging must remain owned until process reaping")
	}
}

type sourceStageRevokingReader struct {
	source *sourceRenderFence
	sent   bool
}

func (r *sourceStageRevokingReader) Read(b []byte) (int, error) {
	if r.sent {
		return 0, io.EOF
	}
	r.sent = true
	r.source.closed.Store(true)
	return copy(b, []byte("synthetic media")), nil
}

func TestSourceHLSStageRechecksFenceAfterPrivateCopy(t *testing.T) {
	s, source := sourceStageFixture(t)
	s.mu.Lock()
	err := s.commit(filepath.Join("low", "segment_000000000.m4s"), &sourceStageRevokingReader{source: source}, 15)
	s.mu.Unlock()
	if err == nil {
		t.Fatal("copy-time revoke crossed publication")
	}
	if _, err := os.Stat(filepath.Join(s.owner.output, "low", "segment_000000000.m4s")); !os.IsNotExist(err) {
		t.Fatal("revoked copy became visible")
	}
	entries, err := os.ReadDir(s.pending)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), ".publish-") {
			t.Fatal("copy temporary retained")
		}
	}
}

func TestSourceHLSStageRejectsUnknownPathsObjectsAndBudgets(t *testing.T) {
	for _, mode := range []string{"unknown", "symlink", "object-limit", "byte-limit", "external-uri", "unexpected-map", "missing-segment", "unattributed-output", "private-count"} {
		t.Run(mode, func(t *testing.T) {
			s, _ := sourceStageFixture(t)
			sourceStageFiles(t, s, 0)
			switch mode {
			case "unknown":
				if err := os.WriteFile(filepath.Join(s.pending, "unexpected.json"), []byte("synthetic"), 0600); err != nil {
					t.Fatal(err)
				}
			case "symlink":
				if err := os.Symlink(filepath.Join(s.pending, "low", "init_0.mp4"), filepath.Join(s.pending, "low", "segment_000000001.m4s")); err != nil {
					t.Fatal(err)
				}
			case "object-limit":
				file, err := os.Create(filepath.Join(s.pending, "low", "segment_000000001.m4s"))
				if err != nil {
					t.Fatal(err)
				}
				err = file.Truncate(24*1024*1024 + 1)
				file.Close()
				if err != nil {
					t.Fatal(err)
				}
			case "byte-limit":
				s.maxBytes = 1
			case "external-uri", "unexpected-map":
				data := sourceStagePlaylist("init_0.mp4", 0)
				if mode == "external-uri" {
					data = strings.ReplaceAll(data, "segment_000000000.m4s", "https://example.invalid/private.m4s")
				} else {
					data = strings.ReplaceAll(data, "init_0.mp4", "../medium/init_1.mp4")
				}
				if err := os.WriteFile(filepath.Join(s.pending, "low", "index.m3u8"), []byte(data), 0600); err != nil {
					t.Fatal(err)
				}
			case "missing-segment":
				if err := os.Remove(filepath.Join(s.pending, "low", "segment_000000000.m4s")); err != nil {
					t.Fatal(err)
				}
			case "unattributed-output":
				if err := os.WriteFile(filepath.Join(s.owner.output, "low", "init_0.mp4"), []byte("preserve"), 0600); err != nil {
					t.Fatal(err)
				}
			case "private-count":
				for i := 1; i < 66; i++ {
					if err := os.WriteFile(filepath.Join(s.pending, "low", fmt.Sprintf("segment_%09d.m4s", i)), []byte("bounded"), 0600); err != nil {
						t.Fatal(err)
					}
				}
			}
			if ready, err := s.Publish(); ready || err == nil {
				t.Fatal("unsafe staging accepted")
			}
			if _, err := os.Stat(filepath.Join(s.owner.output, "index.m3u8")); !os.IsNotExist(err) {
				t.Fatal("invalid stage published manifest")
			}
			if mode == "unattributed-output" {
				b, err := os.ReadFile(filepath.Join(s.owner.output, "low", "init_0.mp4"))
				if err != nil || string(b) != "preserve" {
					t.Fatal("unattributed output overwritten")
				}
			}
		})
	}
}

func TestSourceHLSPlaylistRejectsNonProfileFeatures(t *testing.T) {
	base := sourceStagePlaylist("init.mp4", 0)
	for _, bad := range []string{
		strings.ReplaceAll(base, "#EXTINF:2.000000,", "#EXTINF:NaN,"), strings.ReplaceAll(base, "#EXTINF:2.000000,", "#EXTINF:13,"),
		strings.ReplaceAll(base, "segment_000000000.m4s", "../segment_000000000.m4s"), strings.ReplaceAll(base, "#EXTINF:2.000000,\n", ""),
		base + "#EXT-X-KEY:METHOD=AES-128,URI=\"key\"\n", base + "#EXT-X-MAP:URI=\"init.mp4\"\n", base + "#EXT-X-MEDIA-SEQUENCE:0\n",
		strings.ReplaceAll(base, "\n", "\r\n"), strings.Repeat(base, 1000),
	} {
		if _, err := sourceHLSParsePlaylist([]byte(bad), "init.mp4"); err == nil {
			t.Fatal("non-profile playlist accepted")
		}
	}
}

func TestSourceHLSStageRetainsBoundedWindowAndRejectsChangedInit(t *testing.T) {
	s, _ := sourceStageFixture(t)
	for sequence := 0; sequence < 8; sequence++ {
		sourceStageFiles(t, s, sequence)
		if ready, err := s.Publish(); !ready || err != nil {
			t.Fatal("rolling publication", err)
		}
		if len(s.published) > 11 {
			t.Fatal("published window grew")
		}
	}
	if _, err := os.Stat(filepath.Join(s.owner.output, "low", "segment_000000000.m4s")); !os.IsNotExist(err) {
		t.Fatal("expired rolling object retained")
	}
	if _, err := os.Stat(filepath.Join(s.owner.output, "low", "segment_000000005.m4s")); err != nil {
		t.Fatal("two prior snapshots lost", err)
	}
	if err := os.WriteFile(filepath.Join(s.pending, "low", "init_0.mp4"), []byte("changed synthetic init"), 0600); err != nil {
		t.Fatal(err)
	}
	sourceStageFiles(t, s, 8)
	if ready, err := s.Publish(); ready || err == nil {
		t.Fatal("mutable init reused")
	}
}
