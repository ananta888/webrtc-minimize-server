package main

import (
	"encoding/json"
	"errors"
	"sort"
	"time"
	"unicode/utf8"
)

type sourceSceneQuery struct {
	Version         int    `json:"version"`
	Type            string `json:"type"`
	CommandID       string `json:"commandId"`
	AssignmentID    string `json:"assignmentId"`
	ProgramID       string `json:"programId"`
	ProgramEpoch    int64  `json:"programEpoch"`
	LeaseID         string `json:"leaseId"`
	FencingRevision int64  `json:"fencingRevision"`
	IssuedAt        int64  `json:"issuedAt"`
	ExpiresAt       int64  `json:"expiresAt"`
}

func (q sourceSceneQuery) command() sourceSceneCommand {
	c := sourceSceneCommand{Version: q.Version, Type: "source-program-scene", CommandID: q.CommandID,
		AssignmentID: q.AssignmentID, ProgramID: q.ProgramID, ProgramEpoch: q.ProgramEpoch, LeaseID: q.LeaseID,
		FencingRevision: q.FencingRevision, IssuedAt: q.IssuedAt, ExpiresAt: q.ExpiresAt,
		ExpectedSceneRevision: 1, Layout: "waiting-slate", SourceLeaseIDs: []string{}}
	if q.Version == 2 {
		fits := []string{}
		c.SourceFits = &fits
	}
	return c
}

func parseSourceSceneQuery(raw []byte, now time.Time) (sourceSceneQuery, error) {
	var q sourceSceneQuery
	if len(raw) == 0 || len(raw) > maximumSourceSceneBytes || !utf8.Valid(raw) {
		return q, errors.New("invalid source scene query")
	}
	_, exact := sourceProgramExactObject(raw, "version", "type", "commandId", "assignmentId", "programId", "programEpoch", "leaseId", "fencingRevision", "issuedAt", "expiresAt")
	if !exact || json.Unmarshal(raw, &q) != nil || q.Type != "source-program-scene-query" {
		return sourceSceneQuery{}, errors.New("invalid source scene query")
	}
	// Reuse the identical reference, numeric and freshness rules, not a weaker
	// query-specific authority path. No presentation change occurs here.
	candidate, _ := json.Marshal(q.command())
	if _, err := parseSourceSceneCommand(candidate, now); err != nil {
		return sourceSceneQuery{}, err
	}
	return q, nil
}

type sourceSceneAvailable struct {
	SourceLeaseID string `json:"sourceLeaseId"`
	SourceKind    string `json:"sourceKind"`
}

func sourceSceneReply(c sourceSceneCommand, kind string, now int64) map[string]any {
	return map[string]any{"version": c.Version, "type": kind, "commandId": c.CommandID, "assignmentId": c.AssignmentID,
		"programId": c.ProgramID, "programEpoch": c.ProgramEpoch, "leaseId": c.LeaseID, "fencingRevision": c.FencingRevision, "observedAt": now}
}

func (p *sourceProgramGeneration) sceneScopeCurrent(c sourceSceneCommand, now int64) bool {
	s := p.cfg.scope
	return p.permitted() && now >= p.sceneLastNow && now < c.ExpiresAt && c.AssignmentID == s.assignmentID &&
		c.ProgramID == s.programID && c.ProgramEpoch == s.programEpoch && c.LeaseID == s.writerLeaseID && c.FencingRevision == s.fencingRevision
}

// Snapshot of configured presentation and currently available owned inputs,
// not proof of decoded pixels, continued consent, or audience delivery.
func (p *sourceProgramGeneration) QueryScene(raw []byte) (map[string]any, error) {
	p.sceneMu.Lock()
	defer p.sceneMu.Unlock()
	q, err := parseSourceSceneQuery(raw, p.cfg.now())
	if err != nil {
		return nil, err
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	p.video.mu.Lock()
	defer p.video.mu.Unlock()
	now := p.cfg.now().UnixMilli()
	if !p.sceneScopeCurrent(q.command(), now) || p.video.closed {
		return nil, errors.New("source scene query authority changed")
	}
	p.sceneLastNow = now
	available := make([]sourceSceneAvailable, 0, len(p.sources))
	for id, s := range p.sources {
		if s == nil || s.video == nil {
			continue
		}
		if !s.closed.Load() && !s.video.closed && s.allowed() {
			available = append(available, sourceSceneAvailable{SourceLeaseID: id, SourceKind: s.video.cfg.kind})
		}
	}
	sort.Slice(available, func(i, j int) bool { return available[i].SourceLeaseID < available[j].SourceLeaseID })
	if p.sceneSelectionRevision != p.video.revision && !(p.sceneSelectionRevision == 0 && p.video.revision == 1 && len(p.video.scene) == 0) {
		return nil, errors.New("source scene observation unavailable")
	}
	selected := append([]string{}, p.sceneSelection...)
	reply := sourceSceneReply(q.command(), "source-program-scene-state", now)
	reply["sceneRevision"], reply["layout"] = p.video.revision, p.video.layout
	reply["sourceLeaseIds"], reply["activeSourceLeaseId"], reply["availableSources"] = selected, p.sceneSelectedActive, available
	if q.Version == 2 {
		if len(p.video.sceneFits) != len(selected) {
			return nil, errors.New("source scene presentation unavailable")
		}
		reply["sourceFits"] = append([]string{}, p.video.sceneFits...)
	}
	return reply, nil
}
