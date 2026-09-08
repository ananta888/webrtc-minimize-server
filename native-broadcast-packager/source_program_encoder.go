package main

import (
	"errors"
	"fmt"
	"io"
	"os/exec"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

type sourceProgramEncoderConfig struct {
	ffmpegPath, outputRoot, packagerID, resourceRef string
	width, height, fps                              int
	startSample                                     int64
	profile                                         assignmentProfile
	maxRawBytes                                     int
	maxOutputBytes                                  int64
	authorized                                      func() bool
	revoked                                         <-chan struct{}
}

type sourceProgramEncoder struct {
	cfg                   sourceProgramEncoderConfig
	fence                 *sourceEncoderFence
	stage                 *sourceHLSStage
	owner                 *outputOwnership
	cmd                   *exec.Cmd
	raw                   *sourceProgramRaw
	inputs                *transcodeInputs
	closed                atomic.Bool
	stopOnce              sync.Once
	done, finished, ready chan struct{}
	cleanupFailed         atomic.Bool
}

func validSourceEncoderConfig(c sourceProgramEncoderConfig) bool {
	if c.ffmpegPath == "" || !validOutputRoot(c.outputRoot) || !packagerIDPattern.MatchString(c.packagerID) || !resourceIDPattern.MatchString(c.resourceRef) ||
		!validSourceVideoSize(c.width, c.height) || c.fps < 1 || c.fps > 60 || c.startSample < 0 || c.startSample > sourceAudioMixMaxTime-48000 || c.authorized == nil || c.revoked == nil ||
		c.profile.MaximumQueueFrames < 2 || c.profile.MaximumQueueFrames > 120 || c.maxRawBytes < min(16, c.profile.MaximumQueueFrames)*3840+min(8, c.profile.MaximumQueueFrames)*c.width*c.height*4 || c.maxRawBytes > 128*1024*1024 || c.maxOutputBytes < 1 || c.maxOutputBytes > 128*1024*1024 ||
		c.profile.ProfileID != "h264-aac-720p-v1" || c.profile.KeyframeIntervalSeconds < 1 || c.profile.KeyframeIntervalSeconds > 10 ||
		len(c.profile.Renditions) < 1 || len(c.profile.Renditions) > 3 || !oneOf(selectedVideoEncoder(c.profile), "libx264", "h264_nvenc", "h264_videotoolbox") {
		return false
	}
	seen := map[string]bool{}
	for _, r := range c.profile.Renditions {
		if !oneOf(r.ID, "low", "medium", "high") || seen[r.ID] || !validSourceVideoSize(r.Width, r.Height) || r.Width < 160 || r.Height < 90 || r.FramesPerSecond < 1 || r.FramesPerSecond > 60 ||
			r.VideoBitsPerSecond < 100000 || r.VideoBitsPerSecond > 10000000 || r.AudioBitsPerSecond < 16000 || r.AudioBitsPerSecond > 320000 {
			return false
		}
		seen[r.ID] = true
	}
	return true
}

func sourceProgramEncoderArguments(c sourceProgramEncoderConfig, output, videoURL, audioURL string) []string {
	args := []string{"-hide_banner", "-nostdin", "-loglevel", "error", "-xerror", "-max_alloc", "33554432", "-filter_complex_threads", "1",
		"-thread_queue_size", "8", "-threads", "1", "-f", "rawvideo", "-pixel_format", "rgba", "-video_size", fmt.Sprintf("%dx%d", c.width, c.height), "-framerate", fmt.Sprint(c.fps), "-i", videoURL,
		"-thread_queue_size", "8", "-threads", "1", "-f", "s16le", "-ar", "48000", "-ac", "2", "-probesize", "32", "-analyzeduration", "0", "-i", audioURL}
	// Raw program timestamps require explicit per-branch frame selection. Do
	// not let independent output vsync heuristics retime their source content.
	splits := make([]string, len(c.profile.Renditions))
	for i := range splits {
		splits[i] = fmt.Sprintf("[v%d]", i)
	}
	filters := []string{fmt.Sprintf("[0:v]split=%d%s", len(splits), strings.Join(splits, ""))}
	for i, r := range c.profile.Renditions {
		filters = append(filters, fmt.Sprintf("[v%d]fps=fps=%d:round=near,scale=w=%d:h=%d:force_original_aspect_ratio=decrease,pad=%d:%d:(ow-iw)/2:(oh-ih)/2[v%dout]", i, r.FramesPerSecond, r.Width, r.Height, r.Width, r.Height, i))
	}
	return append(args, ffmpegTranscodeOutputForFilterGraph(&packagerAssignment{Profile: c.profile}, output, selectedVideoEncoder(c.profile), filters)...)
}

func newSourceProgramEncoder(c sourceProgramEncoderConfig) (*sourceProgramEncoder, error) {
	if !validSourceEncoderConfig(c) {
		return nil, errors.New("source encoder config")
	}
	p := &sourceProgramEncoder{cfg: c, done: make(chan struct{}), finished: make(chan struct{}), ready: make(chan struct{})}
	p.cfg.profile.Renditions = append([]assignmentRendition(nil), c.profile.Renditions...)
	p.fence = &sourceEncoderFence{writer: func() bool {
		if p.closed.Load() {
			return false
		}
		select {
		case <-c.revoked:
			return false
		default:
			return c.authorized()
		}
	}}
	if !p.fence.Valid() {
		return nil, errors.New("source encoder denied")
	}
	owner, err := acquireOutputOwnership(c.outputRoot, c.resourceRef, c.packagerID)
	if err != nil {
		return nil, err
	}
	p.owner = owner
	committed := false
	defer func() {
		if !committed {
			_ = owner.close()
		}
	}()
	stage, err := newSourceHLSStage(owner, p.fence, p.cfg.profile, c.maxOutputBytes)
	if err != nil {
		return nil, err
	}
	p.stage = stage
	inputs, err := newTranscodeInputs(true, true)
	if err != nil {
		return nil, errors.New("source encoder inputs unavailable")
	}
	p.inputs = inputs
	cmd := exec.Command(c.ffmpegPath, sourceProgramEncoderArguments(p.cfg, stage.pending, inputs.videoURL, inputs.audioURL)...)
	cmd.Dir = stage.pending
	setSourceCodecEnvironment(cmd)
	inputs.configure(cmd)
	inheritOutputLock(cmd, owner.file)
	cmd.Stdout, cmd.Stderr = io.Discard, io.Discard
	p.cmd = cmd
	if !p.fence.Valid() {
		inputs.close()
		return nil, errors.New("source encoder startup revoked")
	}
	if err = cmd.Start(); err != nil {
		inputs.close()
		return nil, errors.New("source encoder start failed")
	}
	inputs.started(cmd)
	raw, err := newSourceProgramRaw(sourceProgramRawConfig{width: c.width, height: c.height, fps: c.fps, startSample: c.startSample,
		audioFrames: min(16, c.profile.MaximumQueueFrames), videoFrames: min(8, c.profile.MaximumQueueFrames), maxBytes: c.maxRawBytes, writeTimeout: 2 * time.Second, authorized: p.fence.Valid, revoked: p.done, abort: p.abort}, inputs.audio, inputs.video)
	if err != nil {
		p.abort()
		inputs.close()
		_ = cmd.Wait()
		return nil, err
	}
	p.raw = raw
	committed = true
	watched := make(chan struct{})
	waited := make(chan struct{})
	go func() { defer close(watched); p.watch() }()
	go func() { _ = cmd.Wait(); p.Close(); close(waited) }()
	go func() {
		<-p.done
		p.raw.Close()
		p.abort()
		inputs.close()
		<-waited
		<-watched
		<-raw.finished
		if owner.close() != nil {
			p.cleanupFailed.Store(true)
		}
		p.fence.Clear()
		close(p.finished)
	}()
	return p, nil
}

func (p *sourceProgramEncoder) abort() {
	p.stopOnce.Do(func() {
		p.fence.Revoke()
		if p.stage.Invalidate() != nil {
			p.cleanupFailed.Store(true)
		}
		_ = p.cmd.Process.Kill()
		p.Close()
	})
}

func (p *sourceProgramEncoder) WriteProgramAudio(at int64, pcm []byte, g sourceRenderGuard) error {
	if !p.fence.Admit(g) {
		p.Close()
		return errors.New("source encoder audio generation revoked")
	}
	return p.raw.WriteProgramAudio(at, pcm, g)
}
func (p *sourceProgramEncoder) WriteProgramVideo(at int64, revision uint64, pixels []byte, g sourceRenderGuard) error {
	if !p.fence.Admit(g) {
		p.Close()
		return errors.New("source encoder video generation revoked")
	}
	return p.raw.WriteProgramVideo(at, revision, pixels, g)
}
func (p *sourceProgramEncoder) Close() {
	p.fence.Revoke()
	if !p.closed.Swap(true) {
		close(p.done)
	}
}

func (p *sourceProgramEncoder) watch() {
	ticker := time.NewTicker(50 * time.Millisecond)
	defer ticker.Stop()
	defer p.Close()
	started, lastProgress := time.Now(), time.Now()
	var cycle uint64
	announced := false
	for {
		select {
		case <-p.done:
			return
		case <-p.cfg.revoked:
			return
		case now := <-ticker.C:
			if !p.fence.Valid() {
				return
			}
			ready, err := p.stage.Publish()
			if err != nil {
				return
			}
			if ready && !announced {
				close(p.ready)
				announced = true
			}
			p.stage.mu.Lock()
			current := p.stage.cycle
			p.stage.mu.Unlock()
			if current != cycle {
				cycle = current
				lastProgress = now
			}
			if !announced && now.Sub(started) > 15*time.Second || now.Sub(lastProgress) > 20*time.Second {
				return
			}
		}
	}
}
