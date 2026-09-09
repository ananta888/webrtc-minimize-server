package main

import (
	"bytes"
	"context"
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

func TestLiveTrustedSourceProgramEncoder(t *testing.T) {
	if os.Getenv("RUN_LIVE_TRUSTED_SOURCE_DECODE") != "1" {
		t.Skip("set RUN_LIVE_TRUSTED_SOURCE_DECODE=1 with local FFmpeg")
	}
	ffmpeg, err := exec.LookPath("ffmpeg")
	if err != nil {
		t.Fatal("explicit encoder gate needs FFmpeg")
	}
	var initial [][]byte
	for _, epoch := range []sourceHLSEpoch{0, 1, 127} {
		t.Run(fmt.Sprint(epoch), func(t *testing.T) {
			init := liveTrustedSourceProgramEpoch(t, ffmpeg, epoch)
			if epoch == 0 {
				initial = init
				return
			}
			if len(init) != len(initial) {
				t.Fatal("rendition initialization count changed")
			}
			for i := range init {
				if !bytes.Equal(init[i], initial[i]) {
					t.Fatal("same-URI initialization changed across encoder timelines")
				}
			}
		})
	}
}

func liveTrustedSourceProgramEpoch(t *testing.T, ffmpeg string, epoch sourceHLSEpoch) [][]byte {
	t.Helper()
	c := sourceEncoderTestConfig(t.TempDir())
	c.ffmpegPath = ffmpeg
	c.hlsEpoch = epoch
	p, err := newSourceProgramEncoder(c)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		p.Close()
		awaitSource(t, p.finished)
		if p.cleanupFailed.Load() {
			t.Error("encoder cleanup failed")
		}
	})
	f := &sourceRenderFence{allowed: func() bool { return true }}
	var guard sourceRenderGuard
	guard.add(f)
	pcm := make([]byte, 3840)
	start := time.Now()
	for frame := 0; frame < 200; frame++ {
		for i := 0; i < 960; i++ {
			sample := int16(5000 * math.Sin(2*math.Pi*700*float64(frame*960+i)/48000))
			binary.LittleEndian.PutUint16(pcm[i*4:], uint16(sample))
			binary.LittleEndian.PutUint16(pcm[i*4+2:], uint16(sample))
		}
		if err = p.WriteProgramAudio(int64(frame*960), pcm, guard); err != nil {
			t.Fatal("real encoder audio input", frame, err)
		}
		if frame%5 == 0 {
			red, blue := byte(220), byte(0)
			if (frame/25)%2 == 1 {
				red, blue = 0, 220
			}
			if err = p.WriteProgramVideo(int64(frame*960), 1, solidVideoMix(64, 36, red, 0, blue), guard); err != nil {
				t.Fatal("real encoder video input", frame, err)
			}
		}
		time.Sleep(time.Until(start.Add(time.Duration(frame+1) * 20 * time.Millisecond)))
	}
	awaitSource(t, p.ready)
	master, err := os.ReadFile(filepath.Join(p.owner.output, "index.m3u8"))
	if err != nil || !strings.Contains(string(master), "low/index.m3u8") || !strings.Contains(string(master), "medium/index.m3u8") {
		t.Fatal("actual ABR master missing")
	}
	// Capture only this synthetic, already committed fragment while still
	// authorized. Revocation cannot recall data previously delivered to a viewer.
	initializations := make([][]byte, len(c.profile.Renditions))
	for i, r := range c.profile.Renditions {
		manifest, err := os.ReadFile(filepath.Join(p.owner.output, r.ID, "index.m3u8"))
		if err != nil {
			t.Fatal(err)
		}
		producer, err := os.ReadFile(filepath.Join(p.stage.pending, r.ID, "index.m3u8"))
		if err != nil {
			t.Fatal(err)
		}
		playlist, err := c.hlsEpoch.playlist(producer, renditionInitFilename(len(c.profile.Renditions), i))
		if err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(manifest, playlist.data) {
			t.Fatal("committed timeline differs from bounded epoch projection")
		}
		init, err := os.ReadFile(filepath.Join(p.owner.output, r.ID, playlist.media[0]))
		if err != nil {
			t.Fatal(err)
		}
		initializations[i] = append([]byte(nil), init...)
		segment, err := os.ReadFile(filepath.Join(p.owner.output, r.ID, playlist.media[1]))
		if err != nil {
			t.Fatal(err)
		}
		fragment := append(init, segment...)
		video := sourceDecodeEncodedFragment(t, ffmpeg, fragment, r.FramesPerSecond)
		frameBytes := r.Width * r.Height * 4
		if len(video) != 2*r.FramesPerSecond*frameBytes {
			t.Fatal("encoded video dimensions/frame count", len(video), frameBytes)
		}
		colors := make([]byte, len(video)/frameBytes)
		for frame := range colors {
			at := frame*frameBytes + (r.Height/2*r.Width+r.Width/2)*4
			if video[at] > 170 {
				colors[frame] = 'R'
			} else if video[at+2] > 170 {
				colors[frame] = 'B'
			} else {
				colors[frame] = '?'
			}
		}
		t.Logf("synthetic original rendition=%s fps=%d colors=%s", r.ID, r.FramesPerSecond, colors)
		// Inspect original frames inside each half-second plateau. A second
		// fps=2 resampler sampled the exact color boundaries, so AAC priming and
		// CFR quantization legitimately selected the preceding color there.
		for frame := 0; frame < 4; frame++ {
			index := r.FramesPerSecond * (2*frame + 1) / 4
			at := index*frameBytes + (r.Height/2*r.Width+r.Width/2)*4
			pixel := video[at : at+4]
			if pixel[1] > 40 || pixel[3] != 255 || frame%2 == 0 && (pixel[0] < 170 || pixel[2] > 40) || frame%2 == 1 && (pixel[2] < 170 || pixel[0] > 40) {
				t.Fatal("encoded alternating image missing", frame, pixel)
			}
		}
		audio := sourceDecodeEncodedFragment(t, ffmpeg, fragment, 0)
		if len(audio) < 48000*4 || len(audio)%4 != 0 {
			t.Fatal("encoded AAC duration")
		}
		var tone audioMixToneProbe
		tone.inspect(0, audio)
		if amplitude := tone.amplitude(0); amplitude < 0.10 || amplitude > 0.20 {
			t.Fatal("encoded AAC lost 700Hz tone", amplitude)
		}
		clear(fragment)
		clear(video)
		clear(audio)
	}
	f.closed.Store(true) // includes encoder-buffered contributions, not just raw queues
	awaitSource(t, p.finished)
	if p.cmd.ProcessState == nil {
		t.Fatal("encoder was not reaped")
	}
	if p.cleanupFailed.Load() {
		t.Fatal("encoder failed to remove its generation")
	}
	if _, err = os.Stat(filepath.Join(c.outputRoot, c.resourceRef)); !os.IsNotExist(err) {
		t.Fatal("revoked HLS generation survived")
	}
	if p.fence.Valid() || p.fence.sources.count != 0 {
		t.Fatal("encoder source generation revived/retained")
	}
	if p.CanRollover() != (epoch+1 < sourceHLSEpochLimit) {
		t.Fatal("confirmed source revoke lost its clean recovery classification")
	}
	return initializations
}

func sourceDecodeEncodedFragment(t *testing.T, ffmpeg string, fragment []byte, videoFPS int) []byte {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	args := []string{"-hide_banner", "-nostdin", "-loglevel", "error", "-threads", "1", "-filter_threads", "1", "-f", "mp4", "-i", "pipe:0"}
	if videoFPS > 0 {
		args = append(args, "-map", "0:v:0", "-fps_mode", "passthrough", "-frames:v", fmt.Sprint(2*videoFPS), "-pix_fmt", "rgba", "-f", "rawvideo", "pipe:1")
	} else {
		args = append(args, "-map", "0:a:0", "-t", "1", "-ac", "2", "-ar", "48000", "-f", "s16le", "pipe:1")
	}
	cmd := exec.CommandContext(ctx, ffmpeg, args...)
	cmd.Stdin = bytes.NewReader(fragment)
	data, err := cmd.Output()
	if err != nil {
		t.Fatal("encoded fragment did not decode", err)
	}
	return data
}
