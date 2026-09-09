package main

import (
	"errors"
	"regexp"
	"sync"
	"sync/atomic"
	"time"
)

var sourceProgramTenant = regexp.MustCompile(`^tn_[A-Za-z0-9_-]{16,64}$`)
var sourceProgramDevice = regexp.MustCompile(`^dev_[A-Za-z0-9_-]{16,64}$`)

// Trusted local parent context, never authority inferred from a source message.
type sourceProgramScope struct {
	tenantID, deviceRef, roomID, programID, assignmentID, writerLeaseID string
	roomEpoch, programEpoch, fencingRevision                            int64
}

type sourceProgramGenerationConfig struct {
	scope                                  sourceProgramScope
	encoder                                sourceProgramEncoderConfig
	now                                    func() time.Time
	maxPublishers, maxSources, maxDecoders int
	maxDecodeBytes                         int64
	maxPCMBytes, maxRGBABytes              int
	sourceWidth, sourceHeight              int // Fixed decoder OUTPUT size, not assumed VP8 input size.
	delaySamples                           int64
}

type sourceGenerationOutput interface {
	sourceProgramOutput
	ReadySignal() <-chan struct{}
	Finished() <-chan struct{}
}

func (p *sourceProgramEncoder) ReadySignal() <-chan struct{} { return p.ready }
func (p *sourceProgramEncoder) Finished() <-chan struct{}    { return p.finished }

type sourceProgramGeneration struct {
	sceneMu        sync.Mutex
	sceneHistory   map[string]sourceSceneHistory
	sceneLastNow   int64
	mu             sync.Mutex
	cfg            sourceProgramGenerationConfig
	closed         atomic.Bool
	done, finished chan struct{}
	output         sourceGenerationOutput
	clock          *sourceProgramClock
	audio          *sourceAudioMixer
	video          *sourceVideoMixer
	budget         *sourceDecodeBudget
	publishers     map[sourceGenerationPublisher]*sourcePublisherClock
	sources        map[string]*sourceGenerationSource
}

type sourceGenerationPublisher struct{ peer, device string }

func validSourceProgramGeneration(c sourceProgramGenerationConfig) bool {
	s := c.scope
	return validSourceEncoderConfig(c.encoder) && c.encoder.startSample == 0 && c.now != nil &&
		sourceProgramTenant.MatchString(s.tenantID) && sourceProgramDevice.MatchString(s.deviceRef) && roomIDPattern.MatchString(s.roomID) &&
		programIDPattern.MatchString(s.programID) && assignmentIDPattern.MatchString(s.assignmentID) && leaseIDPattern.MatchString(s.writerLeaseID) &&
		s.roomEpoch >= 1 && s.roomEpoch <= sourceVideoSceneMaxRevision && s.programEpoch >= 1 && s.programEpoch <= sourceVideoSceneMaxRevision &&
		s.fencingRevision >= 1 && s.fencingRevision <= sourceVideoSceneMaxRevision &&
		c.maxPublishers >= 1 && c.maxPublishers <= 20 && c.maxSources >= 1 && c.maxSources <= 80 && c.maxDecoders >= 1 && c.maxDecoders <= 80 &&
		c.maxDecodeBytes >= 1 && c.maxDecodeBytes <= 2*1024*1024*1024 &&
		c.maxPCMBytes >= 48000*4 && c.maxPCMBytes <= 80*48000*4 &&
		c.maxRGBABytes >= c.encoder.width*c.encoder.height*4 && c.maxRGBABytes <= 256*1024*1024 &&
		validSourceVideoSize(c.sourceWidth, c.sourceHeight) && c.delaySamples >= 0 && c.delaySamples <= 48000
}

func newSourceProgramGeneration(c sourceProgramGenerationConfig) (*sourceProgramGeneration, error) {
	return newSourceProgramGenerationWithOutput(c, func(cfg sourceProgramEncoderConfig) (sourceGenerationOutput, error) {
		output, err := newSourceProgramEncoder(cfg)
		if err != nil {
			// Do not put a nil *encoder into a non-nil lifecycle interface.
			return nil, err
		}
		return output, nil
	})
}

// The output factory may spawn/wait for a codec. Construction must therefore
// happen outside assignment/source registry locks, never in a media callback.
func newSourceProgramGenerationWithOutput(c sourceProgramGenerationConfig, create func(sourceProgramEncoderConfig) (sourceGenerationOutput, error)) (*sourceProgramGeneration, error) {
	if !validSourceProgramGeneration(c) || create == nil {
		return nil, errors.New("source program generation config")
	}
	p := &sourceProgramGeneration{cfg: c, done: make(chan struct{}), finished: make(chan struct{}), publishers: make(map[sourceGenerationPublisher]*sourcePublisherClock), sources: make(map[string]*sourceGenerationSource)}
	p.cfg.encoder.profile.Renditions = append([]assignmentRendition(nil), c.encoder.profile.Renditions...)
	if !p.permitted() {
		return nil, errors.New("source program generation denied")
	}
	var err error
	p.budget, err = newSourceDecodeBudget(c.maxDecoders, c.maxDecodeBytes)
	if err != nil {
		return nil, err
	}
	committed := false
	defer func() {
		if !committed {
			p.cleanup()
		}
	}()
	p.audio, err = newSourceAudioMixer(sourceAudioMixConfig{maxSources: c.maxSources, queueSamples: 48000, maxPCMBytes: c.maxPCMBytes, authorized: p.permitted})
	if err != nil {
		return nil, err
	}
	p.video, err = newSourceVideoMixer(sourceVideoMixConfig{width: c.encoder.width, height: c.encoder.height, maxSources: c.maxSources, queueFrames: 2, maxRGBABytes: c.maxRGBABytes, lookAheadSamples: 48000, authorized: p.permitted})
	if err != nil {
		return nil, err
	}
	encoder := p.cfg.encoder
	encoder.authorized, encoder.revoked = p.permitted, p.done
	p.output, err = create(encoder)
	if err != nil || p.output == nil {
		return nil, errors.New("source program generation output")
	}
	if p.output.ReadySignal() == nil || p.output.Finished() == nil {
		return nil, errors.New("source program generation output lifecycle")
	}
	start := c.now()
	p.clock, err = newSourceProgramClock(sourceProgramClockConfig{start: start, now: c.now, framesPerSecond: c.encoder.fps, maxLagSamples: 4800, authorized: p.permitted, revoked: p.done}, p.audio, p.video, p.output)
	if err != nil {
		return nil, err
	}
	committed = true
	go p.run()
	return p, nil
}

func (p *sourceProgramGeneration) permitted() bool {
	if p.closed.Load() {
		return false
	}
	select {
	case <-p.cfg.encoder.revoked:
		return false
	default:
		return p.cfg.encoder.authorized()
	}
}

func (p *sourceProgramGeneration) Ready() bool {
	if !p.permitted() {
		return false
	}
	select {
	case <-p.output.Finished():
		return false
	default:
	}
	select {
	case <-p.output.ReadySignal():
		return true
	default:
		return false
	}
}

// Nonblocking fence only. finished means scheduler, source workers, mixer
// storage AND encoder/process ownership are completely released.
func (p *sourceProgramGeneration) Close() {
	if !p.closed.Swap(true) {
		close(p.done)
	}
	if p.output != nil {
		p.output.Close()
	}
}

func (p *sourceProgramGeneration) run() {
	defer p.cleanup()
	ticker := time.NewTicker(2 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-p.done:
			return
		case <-p.cfg.encoder.revoked:
			return
		case <-p.output.Finished():
			return
		case <-ticker.C:
			if p.clock.Step() != nil {
				return
			}
		}
	}
}

func (p *sourceProgramGeneration) cleanup() {
	p.Close()
	p.budget.Close()
	p.mu.Lock()
	sources := p.sources
	p.sources = nil
	publishers := p.publishers
	p.publishers = nil
	p.mu.Unlock()
	for _, s := range sources {
		s.Close()
	}
	for _, c := range publishers {
		c.Close()
	}
	if p.clock != nil {
		p.clock.Close()
	} else {
		if p.audio != nil {
			p.audio.Close()
		}
		if p.video != nil {
			p.video.Close()
		}
	}
	for _, s := range sources {
		<-s.finished
	}
	if p.output != nil && p.output.Finished() != nil {
		<-p.output.Finished()
	}
	close(p.finished)
}
