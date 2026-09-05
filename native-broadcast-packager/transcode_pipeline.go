package main

import (
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"
	"github.com/pion/webrtc/v4/pkg/media/ivfwriter"
	"github.com/pion/webrtc/v4/pkg/media/oggwriter"
)

const pipelineStopTimeout = 5 * time.Second

type rtpPacketWriter interface {
	WriteRTP(*rtp.Packet) error
	Close() error
}

type boundedDiagnostic struct {
	mu    sync.Mutex
	value []byte
}

func (diagnostic *boundedDiagnostic) Write(value []byte) (int, error) {
	diagnostic.mu.Lock()
	defer diagnostic.mu.Unlock()
	remaining := 4096 - len(diagnostic.value)
	if remaining > 0 {
		if len(value) < remaining {
			remaining = len(value)
		}
		diagnostic.value = append(diagnostic.value, value[:remaining]...)
	}
	return len(value), nil
}

func (diagnostic *boundedDiagnostic) String() string {
	diagnostic.mu.Lock()
	defer diagnostic.mu.Unlock()
	return string(diagnostic.value)
}

type transcodePipeline struct {
	mu         sync.Mutex
	cmd        *exec.Cmd
	video      rtpPacketWriter
	audio      rtpPacketWriter
	videoQ     chan *rtp.Packet
	audioQ     chan *rtp.Packet
	writers    sync.WaitGroup
	dropped    atomic.Uint64
	diagnostic *boundedDiagnostic
	done       chan error
	output     string
	encoder    string
	closed     bool
	onReady    func()
	onFailure  func()
}

func validatedOutputDirectory(root, resourceRef string) (string, error) {
	if !filepath.IsAbs(root) || filepath.Clean(root) == string(filepath.Separator) || !resourceIDPattern.MatchString(resourceRef) {
		return "", errors.New("invalid native-packager output scope")
	}
	cleanRoot := filepath.Clean(root)
	output := filepath.Join(cleanRoot, resourceRef)
	if filepath.Dir(output) != cleanRoot {
		return "", errors.New("invalid native-packager output scope")
	}
	return output, nil
}

func cleanOutputRoot(root string) error {
	if !filepath.IsAbs(root) || filepath.Clean(root) == string(filepath.Separator) {
		return errors.New("invalid native-packager output root")
	}
	cleanRoot := filepath.Clean(root)
	if err := os.MkdirAll(cleanRoot, 0o700); err != nil {
		return err
	}
	entries, err := os.ReadDir(cleanRoot)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if resourceIDPattern.MatchString(entry.Name()) {
			if err := os.RemoveAll(filepath.Join(cleanRoot, entry.Name())); err != nil {
				return err
			}
		}
	}
	return nil
}

func selectedVideoEncoder(profile assignmentProfile) string {
	if profile.VideoEncoder == "" {
		return "libx264"
	}
	return profile.VideoEncoder
}

func ffmpegVideoEncoderArguments(encoder string, index int) []string {
	suffix := fmt.Sprint(index)
	switch encoder {
	case "h264_nvenc":
		return []string{"-preset:v:" + suffix, "p4", "-tune:v:" + suffix, "ll"}
	case "h264_videotoolbox":
		return []string{"-realtime:v:" + suffix, "1", "-allow_sw:v:" + suffix, "0"}
	default:
		return []string{"-preset:v:" + suffix, "veryfast", "-tune:v:" + suffix, "zerolatency"}
	}
}

func ffmpegTranscodeArguments(assignment *packagerAssignment, output string, hasVideo, hasAudio bool, encoderOverride ...string) []string {
	encoder := selectedVideoEncoder(assignment.Profile)
	if len(encoderOverride) == 1 {
		encoder = encoderOverride[0]
	}
	args := []string{"-hide_banner", "-nostdin", "-loglevel", "warning"}
	if hasVideo {
		args = append(args, "-f", "ivf", "-i", "pipe:3")
	} else {
		args = append(args, "-re", "-f", "lavfi", "-i", "color=c=black:s=1280x720:r=30")
	}
	if hasAudio {
		audioFD := "pipe:3"
		if hasVideo {
			audioFD = "pipe:4"
		}
		args = append(args, "-f", "ogg", "-i", audioFD)
	} else {
		args = append(args, "-re", "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo")
	}
	splits := make([]string, len(assignment.Profile.Renditions))
	filters := make([]string, 0, len(assignment.Profile.Renditions)+1)
	for index := range assignment.Profile.Renditions {
		splits[index] = fmt.Sprintf("[v%d]", index)
	}
	filters = append(filters, fmt.Sprintf("[0:v]split=%d%s", len(splits), strings.Join(splits, "")))
	for index, rendition := range assignment.Profile.Renditions {
		filters = append(filters, fmt.Sprintf(
			"[v%d]scale=w=%d:h=%d:force_original_aspect_ratio=decrease,pad=%d:%d:(ow-iw)/2:(oh-ih)/2[v%dout]",
			index, rendition.Width, rendition.Height, rendition.Width, rendition.Height, index,
		))
	}
	args = append(args, "-filter_complex", strings.Join(filters, ";"))
	variants := make([]string, 0, len(assignment.Profile.Renditions))
	for index, rendition := range assignment.Profile.Renditions {
		args = append(args,
			"-map", fmt.Sprintf("[v%dout]", index), "-map", "1:a:0",
			fmt.Sprintf("-c:v:%d", index), encoder,
		)
		args = append(args, ffmpegVideoEncoderArguments(encoder, index)...)
		args = append(args,
			fmt.Sprintf("-b:v:%d", index), fmt.Sprint(rendition.VideoBitsPerSecond),
			fmt.Sprintf("-maxrate:v:%d", index), fmt.Sprint(rendition.VideoBitsPerSecond*115/100),
			fmt.Sprintf("-bufsize:v:%d", index), fmt.Sprint(rendition.VideoBitsPerSecond*2),
			fmt.Sprintf("-r:v:%d", index), fmt.Sprint(rendition.FramesPerSecond),
			fmt.Sprintf("-g:v:%d", index), fmt.Sprint(rendition.FramesPerSecond*assignment.Profile.KeyframeIntervalSeconds),
			fmt.Sprintf("-sc_threshold:v:%d", index), "0",
			fmt.Sprintf("-profile:v:%d", index), "main",
			fmt.Sprintf("-level:v:%d", index), "3.1",
			fmt.Sprintf("-pix_fmt:v:%d", index), "yuv420p",
			fmt.Sprintf("-c:a:%d", index), "aac",
			fmt.Sprintf("-b:a:%d", index), fmt.Sprint(rendition.AudioBitsPerSecond),
			fmt.Sprintf("-ar:a:%d", index), "48000",
			fmt.Sprintf("-ac:a:%d", index), "2",
		)
		variants = append(variants, fmt.Sprintf("v:%d,a:%d,name:%s", index, index, rendition.ID))
	}
	return append(args,
		"-shortest", "-max_muxing_queue_size", "128", "-max_interleave_delta", "1000000",
		"-f", "hls", "-hls_time", "2", "-hls_segment_type", "fmp4",
		"-hls_list_size", "7", "-hls_delete_threshold", "2",
		"-hls_flags", "independent_segments+delete_segments+program_date_time+temp_file",
		"-hls_fmp4_init_filename", "init.mp4",
		"-hls_segment_filename", filepath.Join(output, "%v", "segment_%09d.m4s"),
		"-master_pl_name", "index.m3u8", "-var_stream_map", strings.Join(variants, " "),
		filepath.Join(output, "%v", "index.m3u8"),
	)
}

func startTranscodePipeline(cfg config, assignment *packagerAssignment, videoCodec, audioCodec webrtc.RTPCodecParameters, encoder string, onReady, onFailure func()) (*transcodePipeline, error) {
	hasVideo := videoCodec.MimeType != ""
	hasAudio := audioCodec.MimeType != ""
	if hasVideo && !strings.EqualFold(videoCodec.MimeType, webrtc.MimeTypeVP8) {
		return nil, errors.New("native packager requires VP8 video ingress")
	}
	if hasAudio && !strings.EqualFold(audioCodec.MimeType, webrtc.MimeTypeOpus) {
		return nil, errors.New("native packager requires Opus audio ingress")
	}
	if !hasVideo && !hasAudio {
		return nil, errors.New("native packager has no media ingress")
	}
	if !oneOf(encoder, "libx264", "h264_nvenc", "h264_videotoolbox") {
		return nil, errors.New("native packager video encoder unavailable")
	}
	output, err := validatedOutputDirectory(cfg.outputRoot, assignment.ResourceRef)
	if err != nil {
		return nil, err
	}
	if err = os.RemoveAll(output); err != nil {
		return nil, errors.New("native packager output cleanup failed")
	}
	if err = os.MkdirAll(output, 0o700); err != nil {
		return nil, errors.New("native packager output unavailable")
	}
	readers := []*os.File{}
	writers := []*os.File{}
	closeFiles := func(files []*os.File) {
		for _, file := range files {
			_ = file.Close()
		}
	}
	if hasVideo {
		reader, writer, pipeErr := os.Pipe()
		if pipeErr != nil {
			return nil, pipeErr
		}
		readers = append(readers, reader)
		writers = append(writers, writer)
	}
	if hasAudio {
		reader, writer, pipeErr := os.Pipe()
		if pipeErr != nil {
			closeFiles(readers)
			closeFiles(writers)
			return nil, pipeErr
		}
		readers = append(readers, reader)
		writers = append(writers, writer)
	}
	cmd := exec.Command(cfg.ffmpegPath, ffmpegTranscodeArguments(assignment, output, hasVideo, hasAudio, encoder)...)
	diagnostic := &boundedDiagnostic{}
	cmd.ExtraFiles = readers
	cmd.Stdout = io.Discard
	cmd.Stderr = diagnostic
	if err = cmd.Start(); err != nil {
		closeFiles(readers)
		closeFiles(writers)
		_ = os.RemoveAll(output)
		return nil, errors.New("native packager transcode start failed")
	}
	closeFiles(readers)
	pipeline := &transcodePipeline{
		cmd: cmd, done: make(chan error, 1), output: output, encoder: encoder,
		onReady: onReady, onFailure: onFailure, diagnostic: diagnostic,
	}
	writerIndex := 0
	if hasVideo {
		pipeline.video, err = ivfwriter.NewWith(writers[writerIndex], ivfwriter.WithCodec(webrtc.MimeTypeVP8))
		writerIndex++
	}
	if err == nil && hasAudio {
		pipeline.audio, err = oggwriter.NewWith(writers[writerIndex], 48000, 2)
	}
	if err != nil {
		closeFiles(writers)
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
		_ = os.RemoveAll(output)
		return nil, errors.New("native packager media writer unavailable")
	}
	queueSize := assignment.Profile.MaximumQueueFrames
	if hasVideo {
		pipeline.videoQ = make(chan *rtp.Packet, queueSize)
		pipeline.startWriter(pipeline.video, pipeline.videoQ)
	}
	if hasAudio {
		pipeline.audioQ = make(chan *rtp.Packet, queueSize)
		pipeline.startWriter(pipeline.audio, pipeline.audioQ)
	}
	go func() {
		waitErr := cmd.Wait()
		pipeline.done <- waitErr
		close(pipeline.done)
		pipeline.mu.Lock()
		unexpected := !pipeline.closed
		pipeline.mu.Unlock()
		if unexpected && pipeline.onFailure != nil {
			pipeline.onFailure()
		}
	}()
	go pipeline.watchReadiness(assignment)
	return pipeline, nil
}

func (pipeline *transcodePipeline) watchReadiness(assignment *packagerAssignment) {
	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()
	for range ticker.C {
		pipeline.mu.Lock()
		closed := pipeline.closed
		pipeline.mu.Unlock()
		if closed || time.Now().UnixMilli() >= assignment.expiresAt.Load() {
			return
		}
		if _, err := os.Stat(filepath.Join(pipeline.output, "index.m3u8")); err != nil {
			continue
		}
		ready := true
		for index, rendition := range assignment.Profile.Renditions {
			renditionDirectory := filepath.Join(pipeline.output, rendition.ID)
			if _, err := os.Stat(filepath.Join(renditionDirectory, "index.m3u8")); err != nil {
				ready = false
				break
			}
			if _, err := os.Stat(filepath.Join(renditionDirectory, renditionInitFilename(len(assignment.Profile.Renditions), index))); err != nil {
				ready = false
				break
			}
			segments, err := filepath.Glob(filepath.Join(renditionDirectory, "segment_*.m4s"))
			if err != nil || len(segments) == 0 {
				ready = false
				break
			}
		}
		if ready {
			if pipeline.onReady != nil {
				pipeline.onReady()
			}
			return
		}
	}
}

func renditionInitFilename(renditionCount, index int) string {
	if renditionCount == 1 {
		return "init.mp4"
	}
	return fmt.Sprintf("init_%d.mp4", index)
}

func (pipeline *transcodePipeline) startWriter(writer rtpPacketWriter, queue <-chan *rtp.Packet) {
	pipeline.writers.Add(1)
	go func() {
		defer pipeline.writers.Done()
		defer writer.Close()
		for packet := range queue {
			if err := writer.WriteRTP(packet); err != nil {
				_ = pipeline.cmd.Process.Kill()
				return
			}
		}
	}()
}

func (pipeline *transcodePipeline) write(kind webrtc.RTPCodecType, packet *rtp.Packet) error {
	if packet == nil {
		return errors.New("invalid native packager RTP packet")
	}
	pipeline.mu.Lock()
	defer pipeline.mu.Unlock()
	if pipeline.closed {
		return errors.New("native packager pipeline closed")
	}
	queue := pipeline.audioQ
	if kind == webrtc.RTPCodecTypeVideo {
		queue = pipeline.videoQ
	}
	if queue == nil {
		return nil
	}
	select {
	case queue <- packet.Clone():
	default:
		pipeline.dropped.Add(1)
	}
	return nil
}

func (pipeline *transcodePipeline) close() {
	pipeline.mu.Lock()
	if pipeline.closed {
		pipeline.mu.Unlock()
		return
	}
	pipeline.closed = true
	if pipeline.videoQ != nil {
		close(pipeline.videoQ)
	}
	if pipeline.audioQ != nil {
		close(pipeline.audioQ)
	}
	process := pipeline.cmd.Process
	pipeline.mu.Unlock()
	writersDone := make(chan struct{})
	go func() {
		pipeline.writers.Wait()
		close(writersDone)
	}()
	select {
	case <-writersDone:
	case <-time.After(pipelineStopTimeout):
		_ = process.Kill()
		<-writersDone
	}
	select {
	case <-pipeline.done:
	case <-time.After(pipelineStopTimeout):
		_ = process.Kill()
		<-pipeline.done
	}
	_ = os.RemoveAll(pipeline.output)
}
