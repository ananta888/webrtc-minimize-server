package main

import (
	"crypto/sha256"
	"encoding/json"
	"errors"
	"sort"
	"sync"
)

type sourceAudioControlHistory struct {
	digest    [32]byte
	receipt   sourceAudioReceipt
	expiresAt int64
}

type sourceAudioControlState struct {
	mu      sync.Mutex
	lastNow int64
	history map[string]sourceAudioControlHistory
}

func (p *sourceProgramGeneration) audioScopeCurrent(q sourceAudioQuery, now int64) bool {
	s := p.cfg.scope
	return p.permitted() && now >= p.audioControl.lastNow && now < q.ExpiresAt &&
		(q.Version != 2 || p.cfg.encoder.outputAudioChannels() == 2) &&
		q.AssignmentID == s.assignmentID && q.ProgramID == s.programID && q.ProgramEpoch == s.programEpoch &&
		q.LeaseID == s.writerLeaseID && q.FencingRevision == s.fencingRevision
}

// These methods require the authenticated socket's current owner selection.
// They do not authorize a remote director, create sources or advertise capability.
func (p *sourceProgramGeneration) ApplyAudioCommand(raw []byte) (sourceAudioReceipt, error) {
	p.audioControl.mu.Lock()
	defer p.audioControl.mu.Unlock()
	fail := func() (sourceAudioReceipt, error) {
		return sourceAudioReceipt{}, errors.New("source audio control denied")
	}
	now := p.cfg.now()
	c, err := parseSourceAudioCommand(raw, now)
	if err != nil {
		return sourceAudioReceipt{}, err
	}
	if !p.audioScopeCurrent(c.sourceAudioQuery, now.UnixMilli()) {
		return fail()
	}
	p.audioControl.lastNow = now.UnixMilli()
	sort.Slice(c.Sources, func(i, j int) bool { return c.Sources[i].SourceLeaseID < c.Sources[j].SourceLeaseID })
	canonical, _ := json.Marshal(c)
	digest := sha256.Sum256(canonical)
	if p.audioControl.history == nil {
		p.audioControl.history = make(map[string]sourceAudioControlHistory)
	}
	for id, previous := range p.audioControl.history {
		if previous.expiresAt <= now.UnixMilli() {
			delete(p.audioControl.history, id)
		}
	}
	if previous, exists := p.audioControl.history[c.CommandID]; exists {
		if previous.digest != digest {
			return fail()
		}
		return previous.receipt, nil // Historical application only; never renews source authority.
	}
	if len(p.audioControl.history) >= maximumSourceAudioControlHistory {
		return fail()
	}
	appliedAt := now.UnixMilli()
	revision, err := p.setAudioLevelsStrategy(c.ExpectedAudioRevision, c.Sources, c.Strategy, func() bool {
		appliedAt = p.cfg.now().UnixMilli()
		return appliedAt >= now.UnixMilli() && p.audioScopeCurrent(c.sourceAudioQuery, appliedAt)
	})
	if err != nil {
		return fail()
	}
	scope := c.sourceAudioControlScope
	scope.Type = "source-program-audio-applied"
	receipt := sourceAudioReceipt{scope, revision, appliedAt}
	p.audioControl.lastNow = appliedAt
	p.audioControl.history[c.CommandID] = sourceAudioControlHistory{digest, receipt, c.ExpiresAt}
	return receipt, nil
}

func (p *sourceProgramGeneration) QueryAudio(raw []byte) (sourceAudioReply, error) {
	p.audioControl.mu.Lock()
	defer p.audioControl.mu.Unlock()
	fail := func() (sourceAudioReply, error) {
		return sourceAudioReply{}, errors.New("source audio observation denied")
	}
	now := p.cfg.now()
	q, err := parseSourceAudioQuery(raw, now)
	if err != nil {
		return sourceAudioReply{}, err
	}
	if !p.audioScopeCurrent(q, now.UnixMilli()) {
		return fail()
	}
	state, err := p.audioLevels(q.Version)
	observedAt := p.cfg.now().UnixMilli()
	if err != nil || observedAt < now.UnixMilli() || !p.audioScopeCurrent(q, observedAt) {
		return fail()
	}
	p.audioControl.lastNow = observedAt
	scope := q.sourceAudioControlScope
	scope.Type = "source-program-audio-state"
	return sourceAudioReply{scope, state, observedAt}, nil
}
