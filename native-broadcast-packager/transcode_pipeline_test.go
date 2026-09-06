package main

import (
	"context"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/pion/rtp"
	"github.com/pion/rtp/codecs"
	"github.com/pion/webrtc/v4"
	"github.com/pion/webrtc/v4/pkg/media/ivfreader"
	"github.com/pion/webrtc/v4/pkg/media/oggreader"
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
	testLiveTranscode(t, false)
}

func TestLiveVP8OpusToH264AACPipeline(t *testing.T) {
	testLiveTranscode(t, true)
}

func testLiveTranscode(t *testing.T, withAudio bool) {
	t.Helper()
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
	var audioPackets [][]byte
	if withAudio {
		audioFixture := filepath.Join(root, "input.ogg")
		generateAudio := exec.Command(ffmpeg, "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i",
			"sine=frequency=700:sample_rate=48000", "-t", "4", "-ac", "2", "-c:a", "libopus", "-frame_duration", "20", "-page_duration", "20000", audioFixture)
		if output, err := generateAudio.CombinedOutput(); err != nil {
			t.Fatalf("Opus fixture failed: %v: %s", err, output)
		}
		file, err := os.Open(audioFixture)
		if err != nil {
			t.Fatal(err)
		}
		defer file.Close()
		reader, _, err := oggreader.NewWith(file)
		if err != nil {
			t.Fatal(err)
		}
		for {
			data, header, err := reader.ParseNextPage()
			if err == io.EOF {
				break
			}
			if err != nil {
				t.Fatal(err)
			}
			if _, metadata := header.HeaderType(data); metadata {
				continue
			}
			audioPackets = append(audioPackets, data)
		}
		if len(audioPackets) < 190 || len(audioPackets) > 205 {
			t.Fatal("Opus fixture must have one 20ms packet per page")
		}
	}
	assignment := transcodeAssignment()
	assignment.Profile.MaximumQueueFrames = 120
	assignment.expiresAt.Store(time.Now().Add(time.Minute).UnixMilli())
	var failed atomic.Bool
	ready := make(chan struct{})
	audioCodec := webrtc.RTPCodecParameters{}
	if withAudio {
		audioCodec = webrtc.RTPCodecParameters{RTPCodecCapability: webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeOpus, ClockRate: 48000, Channels: 2}}
	}
	pipeline, err := startTranscodePipeline(config{ffmpegPath: ffmpeg, outputRoot: root, packagerID: "pkr_aaaaaaaaaaaaaaaa"}, assignment,
		webrtc.RTPCodecParameters{RTPCodecCapability: webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeVP8, ClockRate: 90000}},
		audioCodec, "libx264", func() { close(ready) }, func() { failed.Store(true) })
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
	audioIndex := 0
	started := time.Now()
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
		for audioIndex < len(audioPackets) && time.Duration(audioIndex)*20*time.Millisecond <= time.Since(started) {
			packet := &rtp.Packet{Header: rtp.Header{Version: 2, PayloadType: 111, SSRC: 0x87654321, SequenceNumber: uint16(audioIndex), Timestamp: uint32(audioIndex * 960)}, Payload: audioPackets[audioIndex]}
			if err := pipeline.write(webrtc.RTPCodecTypeAudio, packet); err != nil {
				t.Fatal(err)
			}
			audioIndex++
		}
		time.Sleep(time.Second / 30)
	}
	master := filepath.Join(root, assignment.ResourceRef, "index.m3u8")
	deadline := time.Now().Add(8 * time.Second)
	for {
		contents, readErr := os.ReadFile(master)
		if readErr == nil && strings.Contains(string(contents), "low/index.m3u8") && strings.Contains(string(contents), "medium/index.m3u8") {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("ABR master playlist unavailable: failure=%t error=%v playlist=%s diagnostic=%s", failed.Load(), readErr, contents, pipeline.diagnostic.String())
		}
		time.Sleep(100 * time.Millisecond)
	}
	select {
	case <-ready:
	case <-time.After(time.Second):
		var files []string
		_ = filepath.Walk(filepath.Join(root, assignment.ResourceRef), func(path string, info os.FileInfo, walkErr error) error {
			if walkErr == nil && info != nil && !info.IsDir() {
				if relative, relativeErr := filepath.Rel(filepath.Join(root, assignment.ResourceRef), path); relativeErr == nil {
					files = append(files, relative)
				}
			}
			return nil
		})
		t.Fatalf("output-ready callback did not follow complete playable ABR output: files=%v diagnostic=%s", files, pipeline.diagnostic.String())
	}
	for index, rendition := range assignment.Profile.Renditions {
		renditionDirectory := filepath.Join(root, assignment.ResourceRef, rendition.ID)
		contents, readErr := os.ReadFile(filepath.Join(renditionDirectory, "index.m3u8"))
		initFilename := renditionInitFilename(len(assignment.Profile.Renditions), index)
		if readErr != nil || !strings.Contains(string(contents), fmt.Sprintf(`#EXT-X-MAP:URI="%s"`, initFilename)) {
			t.Fatalf("rendition %s does not reference its local init segment: error=%v playlist=%s", rendition.ID, readErr, contents)
		}
		if _, statErr := os.Stat(filepath.Join(renditionDirectory, initFilename)); statErr != nil {
			t.Fatalf("rendition %s init segment unavailable: %v", rendition.ID, statErr)
		}
		segments, globErr := filepath.Glob(filepath.Join(renditionDirectory, "segment_*.m4s"))
		if globErr != nil || len(segments) == 0 {
			t.Fatalf("rendition %s media segments unavailable: error=%v", rendition.ID, globErr)
		}
	}
	if failed.Load() || pipeline.dropped.Load() != 0 {
		t.Fatalf("live transcode degraded: failed=%t dropped=%d", failed.Load(), pipeline.dropped.Load())
	}
	if withAudio {
		probeContext, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		checkAudio := exec.CommandContext(probeContext, ffmpeg, "-hide_banner", "-loglevel", "info", "-i", filepath.Join(root, assignment.ResourceRef, "low", "index.m3u8"),
			"-t", "1", "-vn", "-af", "volumedetect", "-f", "null", "-")
		output, err := checkAudio.CombinedOutput()
		match := regexp.MustCompile(`mean_volume:\s*(-?[0-9]+(?:\.[0-9]+)?) dB`).FindSubmatch(output)
		volume := -100.0
		if len(match) == 2 {
			volume, _ = strconv.ParseFloat(string(match[1]), 64)
		}
		if err != nil || volume < -50 || volume >= 0 {
			t.Fatalf("AAC output has no decoded input tone: %v: %s", err, output)
		}
	}
	pipeline.close()
	if _, err = os.Stat(filepath.Join(root, assignment.ResourceRef)); !os.IsNotExist(err) {
		t.Fatal("transient native output survived pipeline cleanup")
	}
}

func TestRenditionInitFilenameMatchesSingleAndMultiVariantFFmpegOutput(t *testing.T) {
	if filename := renditionInitFilename(1, 0); filename != "init.mp4" {
		t.Fatalf("single-rendition init filename mismatch: %s", filename)
	}
	for index, expected := range []string{"init_0.mp4", "init_1.mp4", "init_2.mp4"} {
		if filename := renditionInitFilename(3, index); filename != expected {
			t.Fatalf("multi-rendition init filename mismatch: got=%s expected=%s", filename, expected)
		}
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
		filepath.ToSlash(filepath.Join(output, "%v", "segment_%09d.m4s")),
		filepath.ToSlash(filepath.Join(output, "%v", "index.m3u8")),
	} {
		if !strings.Contains(joined, expected) {
			t.Fatalf("missing bounded transcode argument %q in %s", expected, joined)
		}
	}
	initIndex := slices.Index(args, "-hls_fmp4_init_filename")
	if initIndex < 0 || initIndex+1 >= len(args) || args[initIndex+1] != "init.mp4" {
		t.Fatal("each rendition must use a relative init segment inside its own output directory")
	}
	if slices.Contains(args, "-listen") || strings.Contains(joined, "http://") || strings.Contains(joined, "https://") {
		t.Fatal("transcode pipeline unexpectedly opens or targets a network endpoint")
	}
}

func TestHardwareArgumentsRemainExplicitAndSoftwareFallbackCompatible(t *testing.T) {
	assignment := transcodeAssignment()
	assignment.Profile.VideoEncoder = "h264_nvenc"
	assignment.Profile.SoftwareFallback = "libx264"
	output := filepath.Join(string(filepath.Separator), "tmp", "ananta-native-packager", assignment.ResourceRef)
	hardware := strings.Join(ffmpegTranscodeArguments(assignment, output, true, true), " ")
	software := strings.Join(ffmpegTranscodeArguments(assignment, output, true, true, "libx264"), " ")
	for _, expected := range []string{"-c:v:0 h264_nvenc", "-preset:v:0 p4", "-tune:v:0 ll"} {
		if !strings.Contains(hardware, expected) {
			t.Fatalf("hardware pipeline omitted %q: %s", expected, hardware)
		}
	}
	for _, expected := range []string{"-c:v:0 libx264", "-preset:v:0 veryfast", "-tune:v:0 zerolatency"} {
		if !strings.Contains(software, expected) {
			t.Fatalf("software fallback omitted %q: %s", expected, software)
		}
	}
}

func TestHardwareProcessFailureRetriesExactlyOnceWithSoftware(t *testing.T) {
	ffmpeg, err := exec.LookPath("ffmpeg")
	if err != nil {
		t.Skip("FFmpeg is not installed")
	}
	root := t.TempDir()
	wrapper := filepath.Join(root, "ffmpeg-hardware-failure")
	script := fmt.Sprintf(`#!/bin/sh
for argument in "$@"; do
  if [ "$argument" = "h264_nvenc" ]; then
    exit 23
  fi
done
exec %q "$@"
`, ffmpeg)
	if err = os.WriteFile(wrapper, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	assignment := transcodeAssignment()
	assignment.State = "starting"
	assignment.Profile.VideoEncoder = "h264_nvenc"
	assignment.Profile.SoftwareFallback = "libx264"
	assignment.expiresAt.Store(time.Now().Add(time.Minute).UnixMilli())
	statuses := make(chan map[string]any, 8)
	packager := &client{
		cfg:        config{ffmpegPath: wrapper, outputRoot: root, packagerID: "pkr_aaaaaaaaaaaaaaaa"},
		assignment: assignment,
		sendOverride: func(value any) error {
			statuses <- value.(map[string]any)
			return nil
		},
	}
	media := &nativeMediaSession{
		client: packager, assignment: assignment,
		videoCodec: webrtc.RTPCodecParameters{RTPCodecCapability: webrtc.RTPCodecCapability{
			MimeType: webrtc.MimeTypeVP8, ClockRate: 90000,
		}},
	}
	media.startTranscode()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		media.pipelineMu.Lock()
		pipeline := media.pipeline
		fallbackAttempted := media.fallbackAttempted
		media.pipelineMu.Unlock()
		if fallbackAttempted && pipeline != nil && pipeline.encoder == "libx264" {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	media.pipelineMu.Lock()
	pipeline := media.pipeline
	fallbackAttempted := media.fallbackAttempted
	media.pipeline = nil
	media.closed.Store(true)
	media.pipelineMu.Unlock()
	if pipeline != nil {
		pipeline.close()
	}
	if !fallbackAttempted || pipeline == nil || pipeline.encoder != "libx264" {
		t.Fatalf("hardware failure did not switch to bounded software fallback: attempted=%t pipeline=%v", fallbackAttempted, pipeline)
	}
	select {
	case status := <-statuses:
		if status["state"] != "degraded" || status["reasonCode"] != "HARDWARE_ENCODER_FALLBACK" {
			t.Fatalf("hardware fallback was not reported: %#v", status)
		}
	default:
		t.Fatal("hardware fallback emitted no status")
	}
}

func TestTranscodeOutputCannotEscapeConfiguredRoot(t *testing.T) {
	root := filepath.Join(t.TempDir(), "ananta-native-packager")
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

func TestOutputOwnershipReleasedAfterEncoderStartFailure(t *testing.T) {
	root := t.TempDir()
	assignment := transcodeAssignment()
	_, err := startTranscodePipeline(config{packagerID: outputTestOwner, outputRoot: root, ffmpegPath: filepath.Join(root, "missing-ffmpeg")},
		assignment, webrtc.RTPCodecParameters{RTPCodecCapability: webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeVP8}},
		webrtc.RTPCodecParameters{}, "libx264", nil, nil)
	if err == nil {
		t.Fatal("missing encoder started")
	}
	if _, err = os.Stat(filepath.Join(root, assignment.ResourceRef)); !os.IsNotExist(err) {
		t.Fatal("failed startup retained output")
	}
	retry, err := acquireOutputOwnership(root, assignment.ResourceRef, outputTestOther)
	if err != nil {
		t.Fatal("failed startup retained writer exclusivity")
	}
	if err = retry.close(); err != nil {
		t.Fatal(err)
	}
}

func TestOutputCleanupPreservesUnattributedResourceDirectories(t *testing.T) {
	root := t.TempDir()
	resource := filepath.Join(root, "res_0123456789abcdef")
	keep := filepath.Join(root, "identity.pem")
	if err := os.Mkdir(resource, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(keep, []byte("keep"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := cleanOutputRoot(root, "pkr_aaaaaaaaaaaaaaaa"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(resource); err != nil {
		t.Fatal("startup cleanup removed an unattributed resource")
	}
	if value, err := os.ReadFile(keep); err != nil || string(value) != "keep" {
		t.Fatal("startup cleanup touched a non-resource file")
	}
	if err := cleanOutputRoot(string(filepath.Separator), "pkr_aaaaaaaaaaaaaaaa"); err == nil {
		t.Fatal("filesystem root accepted for cleanup")
	}
}

func TestOutputCleanupRejectsRootSymlink(t *testing.T) {
	directory := t.TempDir()
	target := filepath.Join(directory, "target")
	resource := filepath.Join(target, "res_0123456789abcdef")
	if err := os.MkdirAll(resource, 0o700); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(directory, "link")
	if err := os.Symlink(target, link); err != nil {
		t.Skipf("OS account cannot create directory symlinks: %v", err)
	}
	if err := cleanOutputRoot(link, "pkr_aaaaaaaaaaaaaaaa"); err == nil {
		t.Fatal("output cleanup followed a root symlink")
	}
	if _, err := os.Stat(resource); err != nil {
		t.Fatal("output cleanup touched symlink target")
	}
}

func TestOutputScopeRejectsOSRootsAndMalformedPaths(t *testing.T) {
	root := filepath.VolumeName(t.TempDir()) + string(filepath.Separator)
	for _, invalid := range []string{root, filepath.Join(root, "folder", ".."), "relative", "", root + "invalid\npath"} {
		if validOutputRoot(invalid) {
			t.Fatalf("unsafe output root accepted: %q", invalid)
		}
		if _, err := validatedOutputDirectory(invalid, "res_0123456789abcdef"); err == nil {
			t.Fatal("unsafe root accepted for resource")
		}
		if err := cleanOutputRoot(invalid, "pkr_aaaaaaaaaaaaaaaa"); err == nil {
			t.Fatal("unsafe root accepted for cleanup")
		}
	}
}
