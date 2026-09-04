package main

import (
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/pion/rtp"
	"github.com/pion/rtp/codecs"
	"github.com/pion/webrtc/v4"
	"github.com/pion/webrtc/v4/pkg/media/ivfreader"
)

func transcodeAssignment() *packagerAssignment {
	return &packagerAssignment{
		ResourceRef: "res_0123456789abcdef",
		Profile: assignmentProfile{
			ProfileID:               "h264-aac-720p-v1",
			MaximumQueueFrames:      60,
			KeyframeIntervalSeconds: 2,
			Renditions: []assignmentRendition{
				{ID: "low", Width: 640, Height: 360, FramesPerSecond: 15, VideoBitsPerSecond: 500000, AudioBitsPerSecond: 64000},
				{ID: "medium", Width: 960, Height: 540, FramesPerSecond: 24, VideoBitsPerSecond: 1100000, AudioBitsPerSecond: 96000},
			},
		},
	}
}

func TestLiveVP8ToH264AACPipeline(t *testing.T) {
	if os.Getenv("RUN_LIVE_NATIVE_TRANSCODE") != "1" {
		t.Skip("set RUN_LIVE_NATIVE_TRANSCODE=1 with FFmpeg 6+")
	}
	ffmpeg, err := exec.LookPath("ffmpeg")
	if err != nil {
		t.Fatal("FFmpeg is required for the opted-in live gate")
	}
	root := t.TempDir()
	fixture := filepath.Join(root, "input.ivf")
	generate := exec.Command(ffmpeg, "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i",
		"testsrc2=size=640x360:rate=30", "-t", "4", "-an", "-c:v", "libvpx", "-deadline", "realtime", fixture)
	if output, generateErr := generate.CombinedOutput(); generateErr != nil {
		t.Fatalf("VP8 fixture generation failed: %v: %s", generateErr, output)
	}
	assignment := transcodeAssignment()
	assignment.Profile.MaximumQueueFrames = 120
	assignment.expiresAt.Store(time.Now().Add(time.Minute).UnixMilli())
	var failed atomic.Bool
	ready := make(chan struct{})
	pipeline, err := startTranscodePipeline(config{ffmpegPath: ffmpeg, outputRoot: root}, assignment,
		webrtc.RTPCodecParameters{RTPCodecCapability: webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeVP8, ClockRate: 90000}},
		webrtc.RTPCodecParameters{}, func() { close(ready) }, func() { failed.Store(true) })
	if err != nil {
		t.Fatal(err)
	}
	defer pipeline.close()
	input, err := os.Open(fixture)
	if err != nil {
		t.Fatal(err)
	}
	defer input.Close()
	reader, _, err := ivfreader.NewWith(input)
	if err != nil {
		t.Fatal(err)
	}
	packetizer := rtp.NewPacketizer(1200, 96, 0x12345678, &codecs.VP8Payloader{}, rtp.NewRandomSequencer(), 90000)
	for {
		frame, _, readErr := reader.ParseNextFrame()
		if readErr != nil && readErr != io.EOF {
			t.Fatal(readErr)
		}
		if frame == nil {
			break
		}
		for _, packet := range packetizer.Packetize(frame, 3000) {
			if err = pipeline.write(webrtc.RTPCodecTypeVideo, packet); err != nil {
				t.Fatal(err)
			}
		}
		time.Sleep(time.Second / 30)
	}
	master := filepath.Join(root, assignment.ResourceRef, "index.m3u8")
	deadline := time.Now().Add(8 * time.Second)
	for {
		contents, readErr := os.ReadFile(master)
		if readErr == nil && strings.Contains(string(contents), "low.m3u8") && strings.Contains(string(contents), "medium.m3u8") {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("ABR master playlist unavailable: failure=%t error=%v diagnostic=%s", failed.Load(), readErr, pipeline.diagnostic.String())
		}
		time.Sleep(100 * time.Millisecond)
	}
	select {
	case <-ready:
	case <-time.After(time.Second):
		t.Fatal("output-ready callback did not follow complete ABR manifests")
	}
	if failed.Load() || pipeline.dropped.Load() != 0 {
		t.Fatalf("live transcode degraded: failed=%t dropped=%d", failed.Load(), pipeline.dropped.Load())
	}
	pipeline.close()
	if _, err = os.Stat(filepath.Join(root, assignment.ResourceRef)); !os.IsNotExist(err) {
		t.Fatal("transient native output survived pipeline cleanup")
	}
}

func TestTranscodeInputQueueDropsInsteadOfGrowing(t *testing.T) {
	pipeline := &transcodePipeline{videoQ: make(chan *rtp.Packet, 1)}
	packet := &rtp.Packet{Header: rtp.Header{Version: 2}, Payload: []byte{1, 2, 3}}
	if err := pipeline.write(webrtc.RTPCodecTypeVideo, packet); err != nil {
		t.Fatal(err)
	}
	packet.Payload[0] = 9
	if queued := <-pipeline.videoQ; queued.Payload[0] != 1 {
		t.Fatal("queued RTP packet was not cloned")
	}
	if err := pipeline.write(webrtc.RTPCodecTypeVideo, packet); err != nil {
		t.Fatal(err)
	}
	if err := pipeline.write(webrtc.RTPCodecTypeVideo, packet); err != nil {
		t.Fatal(err)
	}
	if pipeline.dropped.Load() != 1 || len(pipeline.videoQ) != 1 {
		t.Fatalf("queue was not bounded: dropped=%d queued=%d", pipeline.dropped.Load(), len(pipeline.videoQ))
	}
}

func TestTranscodeArgumentsArePipeBoundedAndGenerateABR(t *testing.T) {
	output := filepath.Join(string(filepath.Separator), "tmp", "ananta-native-packager", "res_0123456789abcdef")
	args := ffmpegTranscodeArguments(transcodeAssignment(), output, true, true)
	joined := strings.Join(args, " ")
	for _, expected := range []string{
		"-f ivf -i pipe:3", "-f ogg -i pipe:4", "split=2[v0][v1]",
		"-c:v:0 libx264", "-c:v:1 libx264", "-c:a:0 aac", "-c:a:1 aac",
		"independent_segments+delete_segments+program_date_time+temp_file",
		"v:0,a:0,name:low v:1,a:1,name:medium",
	} {
		if !strings.Contains(joined, expected) {
			t.Fatalf("missing bounded transcode argument %q in %s", expected, joined)
		}
	}
	if slices.Contains(args, "-listen") || strings.Contains(joined, "http://") || strings.Contains(joined, "https://") {
		t.Fatal("transcode pipeline unexpectedly opens or targets a network endpoint")
	}
}

func TestTranscodeOutputCannotEscapeConfiguredRoot(t *testing.T) {
	root := filepath.Join(string(filepath.Separator), "tmp", "ananta-native-packager")
	output, err := validatedOutputDirectory(root, "res_0123456789abcdef")
	if err != nil || filepath.Dir(output) != root {
		t.Fatalf("valid output rejected: output=%s error=%v", output, err)
	}
	for _, invalid := range []string{"../escape", "res_short", "res_0123456789abcdef/child"} {
		if _, err = validatedOutputDirectory(root, invalid); err == nil {
			t.Fatalf("unsafe output accepted: %s", invalid)
		}
	}
}

func TestOutputCleanupRemovesOnlyBoundedResourceDirectories(t *testing.T) {
	root := t.TempDir()
	resource := filepath.Join(root, "res_0123456789abcdef")
	keep := filepath.Join(root, "identity.pem")
	if err := os.Mkdir(resource, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(keep, []byte("keep"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := cleanOutputRoot(root); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(resource); !os.IsNotExist(err) {
		t.Fatal("stale resource output survived startup cleanup")
	}
	if value, err := os.ReadFile(keep); err != nil || string(value) != "keep" {
		t.Fatal("startup cleanup touched a non-resource file")
	}
	if err := cleanOutputRoot(string(filepath.Separator)); err == nil {
		t.Fatal("filesystem root accepted for cleanup")
	}
}
