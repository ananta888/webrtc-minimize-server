package main

import (
	"bytes"
	"encoding/binary"
	"fmt"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

type rolloverLiveSnapshot struct {
	epoch     sourceHLSEpoch
	fragments [][]byte
}

func rolloverSnapshot(t *testing.T, p *sourceProgramRollover, epoch sourceHLSEpoch) rolloverLiveSnapshot {
	t.Helper()
	p.mu.Lock()
	encoder, ok := p.current.(*sourceProgramEncoder)
	p.mu.Unlock()
	if !ok || encoder.cfg.hlsEpoch != epoch || !p.CurrentReady() {
		t.Fatal("expected ready replacement generation", epoch)
	}
	encoder.stage.mu.Lock()
	defer encoder.stage.mu.Unlock()
	result := rolloverLiveSnapshot{epoch: epoch}
	for i, r := range encoder.cfg.profile.Renditions {
		root := filepath.Join(encoder.owner.output, r.ID)
		manifest, err := os.ReadFile(filepath.Join(root, "index.m3u8"))
		if err != nil {
			t.Fatal(err)
		}
		// Reconstruct only the local projection, not a more permissive producer parser.
		var original strings.Builder
		for _, line := range strings.Split(strings.TrimSuffix(string(manifest), "\n"), "\n") {
			if line == "#EXT-X-DISCONTINUITY" || strings.HasPrefix(line, "#EXT-X-DISCONTINUITY-SEQUENCE:") {
				continue
			}
			original.WriteString(line)
			original.WriteByte('\n')
		}
		playlist, err := epoch.playlist([]byte(original.String()), renditionInitFilename(len(encoder.cfg.profile.Renditions), i))
		if err != nil || !bytes.Equal(playlist.data, manifest) {
			t.Fatal("real replacement timeline not projected", err)
		}
		init, err := os.ReadFile(filepath.Join(root, playlist.media[0]))
		if err != nil {
			t.Fatal(err)
		}
		media, err := os.ReadFile(filepath.Join(root, playlist.media[1]))
		if err != nil {
			t.Fatal(err)
		}
		result.fragments = append(result.fragments, append(init, media...))
	}
	return result
}

func TestLiveSourceRolloverKeepsRemainingSourceThenSlate(t *testing.T) {
	if os.Getenv("RUN_LIVE_TRUSTED_SOURCE_DECODE") != "1" {
		t.Skip("set RUN_LIVE_TRUSTED_SOURCE_DECODE=1 with local FFmpeg")
	}
	ffmpeg, err := exec.LookPath("ffmpeg")
	if err != nil {
		t.Fatal(err)
	}
	c := sourceEncoderTestConfig(t.TempDir())
	c.ffmpegPath = ffmpeg
	p, err := newSourceProgramRollover(c)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { p.Close(); awaitSource(t, p.finished) })
	a, b := &sourceRenderFence{allowed: func() bool { return true }}, &sourceRenderFence{allowed: func() bool { return true }}
	var ga, gb sourceRenderGuard
	ga.add(a)
	gb.add(b)
	var snapshots []rolloverLiveSnapshot
	pcm := make([]byte, 3840)
	red, blue, slate := solidVideoMix(64, 36, 220, 0, 0), solidVideoMix(64, 36, 0, 0, 220), solidVideoMix(64, 36, 20, 20, 20)
	start := time.Now()
	for frame := 0; frame < 750; frame++ {
		if frame == 250 {
			a.closed.Store(true)
		}
		if frame == 500 {
			b.closed.Store(true)
		}
		audioGuard, videoGuard, pixels := gb, ga, red
		if frame >= 250 {
			videoGuard, pixels = gb, blue
		}
		if frame >= 500 {
			audioGuard, videoGuard, pixels = sourceRenderGuard{}, sourceRenderGuard{}, slate
		}
		for n := 0; n < 960; n++ {
			sample := int16(5000 * math.Sin(2*math.Pi*700*float64(frame*960+n)/48000))
			if frame >= 500 {
				sample = 0
			}
			binary.LittleEndian.PutUint16(pcm[n*4:], uint16(sample))
			binary.LittleEndian.PutUint16(pcm[n*4+2:], uint16(sample))
		}
		if err = p.WriteProgramAudio(int64(frame*960), pcm, audioGuard); err != nil {
			t.Fatal("program audio", frame, err)
		}
		if frame%5 == 0 {
			if err = p.WriteProgramVideo(int64(frame*960), 1, pixels, videoGuard); err != nil {
				t.Fatal("program video", frame, err)
			}
		}
		if frame == 225 || frame == 475 || frame == 725 {
			snapshots = append(snapshots, rolloverSnapshot(t, p, sourceHLSEpoch(frame/250)))
		}
		time.Sleep(time.Until(start.Add(time.Duration(frame+1) * 20 * time.Millisecond)))
	}
	p.Close()
	awaitSource(t, p.finished)
	if _, err := os.Stat(filepath.Join(c.outputRoot, c.resourceRef)); !os.IsNotExist(err) {
		t.Fatal("parent stop retained output")
	}
	for _, s := range snapshots {
		for i, fragment := range s.fragments {
			r := c.profile.Renditions[i]
			video := sourceDecodeEncodedFragment(t, ffmpeg, fragment, r.FramesPerSecond)
			frameBytes := r.Width * r.Height * 4
			if len(video) != 2*r.FramesPerSecond*frameBytes {
				t.Fatal("replacement decoded frame count")
			}
			for at := (r.Height/2*r.Width + r.Width/2) * 4; at+4 <= len(video); at += frameBytes {
				pixel := video[at : at+4]
				valid := s.epoch == 0 && pixel[0] > 170 && pixel[2] < 50 || s.epoch == 1 && pixel[2] > 170 && pixel[0] < 50 || s.epoch == 2 && pixel[0] < 50 && pixel[1] < 50 && pixel[2] < 50
				if !valid {
					t.Fatal("old or missing frame after replacement", s.epoch, pixel)
				}
			}
			var tone audioMixToneProbe
			audio := sourceDecodeEncodedFragment(t, ffmpeg, fragment, 0)
			tone.inspect(0, audio)
			level := tone.amplitude(0)
			if s.epoch < 2 && (level < 0.10 || level > 0.20) || s.epoch == 2 && level > 0.001 {
				t.Fatal("remaining or revoked audio wrong", s.epoch, level)
			}
			t.Log(fmt.Sprintf("epoch=%d rendition=%s exact decoded new color, 700Hz amplitude=%.5f", s.epoch, r.ID, level))
			clear(video)
			clear(audio)
			clear(fragment)
		}
	}
}
