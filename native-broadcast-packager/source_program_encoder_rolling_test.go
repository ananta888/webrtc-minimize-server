package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestLiveTrustedSourceProgramEncoderRollingWindow(t *testing.T) {
	if os.Getenv("RUN_LIVE_TRUSTED_SOURCE_DECODE") != "1" {
		t.Skip("set RUN_LIVE_TRUSTED_SOURCE_DECODE=1 with local FFmpeg")
	}
	ffmpeg, err := exec.LookPath("ffmpeg")
	if err != nil {
		t.Fatal("explicit encoder gate needs FFmpeg")
	}
	c := sourceEncoderTestConfig(t.TempDir())
	c.ffmpegPath = ffmpeg
	var allowed atomic.Bool
	allowed.Store(true)
	c.authorized = allowed.Load
	p, err := newSourceProgramEncoder(c)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		p.Close()
		awaitSource(t, p.finished)
		if p.cleanupFailed.Load() {
			t.Error("rolling encoder cleanup failed")
		}
	})
	pcm := make([]byte, 3840)
	pixels := solidVideoMix(64, 36, 220, 0, 0)
	start := time.Now()
	for frame := 0; frame < 1300; frame++ {
		if err := p.WriteProgramAudio(int64(frame*960), pcm, sourceRenderGuard{}); err != nil {
			t.Fatalf("rolling encoder audio stopped at frame %d: %v", frame, err)
		}
		if frame%5 == 0 {
			if err := p.WriteProgramVideo(int64(frame*960), 1, pixels, sourceRenderGuard{}); err != nil {
				t.Fatalf("rolling encoder video stopped at frame %d: %v", frame, err)
			}
		}
		time.Sleep(time.Until(start.Add(time.Duration(frame+1) * 20 * time.Millisecond)))
	}
	awaitSource(t, p.ready)
	p.stage.mu.Lock()
	cycle, count, size := p.stage.cycle, len(p.stage.published), p.stage.fileBytes()
	inventoryErr := p.stage.inventory()
	p.stage.mu.Unlock()
	if cycle < 10 || count > 25 || size > c.maxOutputBytes || inventoryErr != nil {
		t.Fatalf("rolling output budget/progress: cycles=%d files=%d bytes=%d inventory=%v", cycle, count, size, inventoryErr)
	}
	for i, r := range c.profile.Renditions {
		data, err := os.ReadFile(filepath.Join(p.owner.output, r.ID, "index.m3u8"))
		if err != nil {
			t.Fatal(err)
		}
		playlist, err := sourceHLSParsePlaylist(data, renditionInitFilename(len(c.profile.Renditions), i))
		if err != nil || len(playlist.media) != 8 || strings.Contains(string(data), "#EXT-X-MEDIA-SEQUENCE:0\n") {
			t.Fatal("rendition window did not advance", r.ID, err)
		}
		for _, name := range playlist.media {
			info, err := os.Stat(filepath.Join(p.owner.output, r.ID, name))
			if err != nil || !info.Mode().IsRegular() || info.Size() == 0 {
				t.Fatal("rolling playlist references unavailable media")
			}
		}
		if _, err := os.Stat(filepath.Join(p.owner.output, r.ID, "segment_000000000.m4s")); !os.IsNotExist(err) {
			t.Fatal("old rolling media retained")
		}
	}
	allowed.Store(false)
	awaitSource(t, p.finished)
	if p.cmd.ProcessState == nil || p.cleanupFailed.Load() {
		t.Fatal("writer revoke did not reap and clean encoder")
	}
	if _, err := os.Stat(filepath.Join(c.outputRoot, c.resourceRef)); !os.IsNotExist(err) {
		t.Fatal("writer-revoked output retained")
	}
	t.Logf("26s synthetic raw HLS: cycles=%d files=%d bytes=%d; both rolling renditions and writer stop verified", cycle, count, size)
}
