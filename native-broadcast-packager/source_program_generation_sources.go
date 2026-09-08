package main

import (
	"errors"

	"github.com/ananta/webrtc-minimize-server/native-broadcast-packager/internal/trustedsframe"
)

type sourceGenerationSource struct {
	*sourceLazyDecoder
	video   *sourceVideoMixInput
	audio   *sourceAudioMixInput
	allowed func() bool
}

func (p *sourceProgramGeneration) matches(l trustedsframe.SourceLease) bool {
	s := p.cfg.scope
	return l.AssignmentID == s.assignmentID && l.WriterLeaseID == s.writerLeaseID && l.FencingRevision == s.fencingRevision &&
		l.Consent.RoomID == s.roomID && l.Consent.RoomEpoch == s.roomEpoch && l.Consent.ProgramID == s.programID && l.Consent.ProgramEpoch == s.programEpoch &&
		l.Consent.TenantID == s.tenantID && l.Consent.GranteeDeviceRef == s.deviceRef && l.Consent.GranteePackagerRef == p.cfg.encoder.packagerID
}

// The receiver, not the supplied metadata, attests current source authority.
// Retained handles are generation-local and bounded even after source close.
// No process starts here: the lazy decoder waits for report/codec readiness.
func (p *sourceProgramGeneration) AddSource(lease trustedsframe.SourceLease, receiver *trustedsframe.SourceReceiver) (*sourceGenerationSource, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if !p.permitted() || receiver == nil || !p.matches(lease) || !receiver.AliveFor(lease) || len(p.sources) >= p.cfg.maxSources || p.sources[lease.SourceLeaseID] != nil {
		return nil, errors.New("source program source denied")
	}
	key := sourceGenerationPublisher{lease.PublisherPeerID, lease.PublisherDeviceRef}
	group := p.publishers[key]
	created := false
	var err error
	if group == nil {
		if len(p.publishers) >= p.cfg.maxPublishers {
			return nil, errors.New("source program publisher budget")
		}
		group, err = newSourcePublisherClock(p.clock.cfg.start, p.cfg.now, p.cfg.delaySamples)
		if err != nil {
			return nil, err
		}
		created = true
	}
	var clock *sourceMediaClock
	audio := lease.Codec == "audio/opus"
	if audio {
		clock, err = group.NewAdaptiveAudioSource()
	} else {
		clock, err = group.NewSource()
	}
	if err != nil {
		if created {
			group.Close()
		}
		return nil, err
	}
	committed := false
	defer func() {
		if !committed {
			clock.Close()
			if created {
				group.Close()
			}
		}
	}()
	allowed := func() bool { return p.permitted() && receiver.AliveFor(lease) }
	s := &sourceGenerationSource{allowed: allowed}
	if audio {
		s.audio, err = p.audio.add(sourceAudioMixInputConfig{authorized: allowed, left: 32768, right: 32768}, true)
		if err != nil {
			return nil, err
		}
		processor, err := newSourceAudioResampler(sourceAudioResampleConfig{timing: clock.AudioTiming, authorized: allowed}, &sourceProgramAudioMixInput{s.audio})
		if err != nil {
			s.audio.Close()
			return nil, err
		}
		s.sourceLazyDecoder, err = newSourceLazyAudioDecoder(sourceAudioDecodeConfig{budget: p.budget, ffmpegPath: p.cfg.encoder.ffmpegPath, authorized: allowed, revoked: receiver.Done()}, clock, processor)
		if err != nil {
			processor.Close()
			return nil, err
		}
	} else {
		s.video, err = p.video.Add(sourceVideoMixInputConfig{width: p.cfg.sourceWidth, height: p.cfg.sourceHeight, kind: lease.Consent.SourceKind, fit: "contain", maxFrameAgeSamples: 24000, mapTimestamp: clock.Map, authorized: allowed})
		if err != nil {
			return nil, err
		}
		s.sourceLazyDecoder, err = newSourceLazyVideoDecoder(sourceVideoDecodeConfig{budget: p.budget, ffmpegPath: p.cfg.encoder.ffmpegPath, width: p.cfg.sourceWidth, height: p.cfg.sourceHeight, authorized: allowed, revoked: receiver.Done()}, clock, s.video)
		if err != nil {
			s.video.Close()
			return nil, err
		}
	}
	p.publishers[key], p.sources[lease.SourceLeaseID] = group, s
	committed = true
	return s, nil
}

// Presentation controls only. The external director adapter still has to
// authenticate its caller; these handles do not grant room/moderator rights.
func (p *sourceProgramGeneration) SetScene(expected uint64, layout string, ids []string, active string) (uint64, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if !p.permitted() || len(ids) > 20 {
		return 0, errors.New("source program scene denied")
	}
	inputs := make([]*sourceVideoMixInput, 0, len(ids))
	var selected *sourceVideoMixInput
	for _, id := range ids {
		s := p.sources[id]
		if s == nil || s.video == nil || !s.allowed() || s.closed.Load() {
			return 0, errors.New("source program scene source denied")
		}
		inputs = append(inputs, s.video)
		if id == active {
			selected = s.video
		}
	}
	if active != "" && selected == nil {
		return 0, errors.New("source program active source denied")
	}
	return p.video.SetScene(expected, layout, inputs, selected)
}

func (p *sourceProgramGeneration) SetGain(id string, left, right int) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	s := p.sources[id]
	if !p.permitted() || s == nil || s.audio == nil || !s.allowed() || s.closed.Load() {
		return errors.New("source program gain denied")
	}
	return s.audio.SetGain(left, right)
}
