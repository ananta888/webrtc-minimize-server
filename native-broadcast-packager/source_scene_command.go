package main

import (
	"crypto/sha256"
	"encoding/json"
	"errors"
	"regexp"
	"time"
	"unicode/utf8"
)

const maximumSourceSceneBytes = 16 * 1024
const maximumSourceSceneHistory = 32

var sourceSceneCommandID = regexp.MustCompile(`^scn_[A-Za-z0-9_-]{16,64}$`)
var sourceSceneLeaseID = regexp.MustCompile(`^sls_[A-Za-z0-9_-]{16,64}$`)

type sourceSceneCommand struct {
	Version               int      `json:"version"`
	Type                  string   `json:"type"`
	CommandID             string   `json:"commandId"`
	AssignmentID          string   `json:"assignmentId"`
	ProgramID             string   `json:"programId"`
	ProgramEpoch          int64    `json:"programEpoch"`
	LeaseID               string   `json:"leaseId"`
	FencingRevision       int64    `json:"fencingRevision"`
	ExpectedSceneRevision uint64   `json:"expectedSceneRevision"`
	Layout                string   `json:"layout"`
	SourceLeaseIDs        []string `json:"sourceLeaseIds"`
	ActiveSourceLeaseID   string   `json:"activeSourceLeaseId"`
	IssuedAt              int64    `json:"issuedAt"`
	ExpiresAt             int64    `json:"expiresAt"`
}

type sourceSceneReceipt struct {
	Version         int    `json:"version"`
	Type            string `json:"type"`
	CommandID       string `json:"commandId"`
	AssignmentID    string `json:"assignmentId"`
	ProgramID       string `json:"programId"`
	ProgramEpoch    int64  `json:"programEpoch"`
	LeaseID         string `json:"leaseId"`
	FencingRevision int64  `json:"fencingRevision"`
	SceneRevision   uint64 `json:"sceneRevision"`
	AppliedAt       int64  `json:"appliedAt"`
}

type sourceSceneHistory struct {
	digest    [32]byte
	receipt   sourceSceneReceipt
	expiresAt int64
}

func parseSourceSceneCommand(raw []byte, now time.Time) (sourceSceneCommand, error) {
	var c sourceSceneCommand
	fail := func() (sourceSceneCommand, error) {
		return sourceSceneCommand{}, errors.New("invalid native source scene")
	}
	if len(raw) == 0 || len(raw) > maximumSourceSceneBytes || !utf8.Valid(raw) {
		return fail()
	}
	fields, ok := sourceProgramExactObject(raw, "version", "type", "commandId", "assignmentId", "programId", "programEpoch", "leaseId",
		"fencingRevision", "expectedSceneRevision", "layout", "sourceLeaseIds", "activeSourceLeaseId", "issuedAt", "expiresAt")
	if !ok {
		return fail()
	}
	var active *string
	if json.Unmarshal(fields["activeSourceLeaseId"], &active) != nil || active == nil {
		return fail()
	}
	if json.Unmarshal(raw, &c) != nil || c.Version != 1 || c.Type != "source-program-scene" || !sourceSceneCommandID.MatchString(c.CommandID) ||
		!assignmentIDPattern.MatchString(c.AssignmentID) || !programIDPattern.MatchString(c.ProgramID) || !leaseIDPattern.MatchString(c.LeaseID) ||
		c.ProgramEpoch < 1 || c.ProgramEpoch > sourceVideoSceneMaxRevision || c.FencingRevision < 1 || c.FencingRevision > sourceVideoSceneMaxRevision ||
		c.ExpectedSceneRevision < 1 || c.ExpectedSceneRevision >= sourceVideoSceneMaxRevision ||
		!oneOf(c.Layout, "single", "screen-presenter", "side-by-side", "active-speaker", "grid", "waiting-slate", "end-slate") ||
		c.SourceLeaseIDs == nil || len(c.SourceLeaseIDs) > 20 || c.IssuedAt < 1 || c.IssuedAt > sourceVideoSceneMaxRevision ||
		c.ExpiresAt < 1 || c.ExpiresAt > sourceVideoSceneMaxRevision || now.UnixMilli() < 1 || now.UnixMilli() > sourceVideoSceneMaxRevision ||
		c.IssuedAt > now.UnixMilli()+1000 || c.ExpiresAt <= now.UnixMilli() || c.ExpiresAt <= c.IssuedAt || c.ExpiresAt-c.IssuedAt > 4000 {
		return fail()
	}
	seen := map[string]bool{}
	for _, id := range c.SourceLeaseIDs {
		if !sourceSceneLeaseID.MatchString(id) || seen[id] {
			return fail()
		}
		seen[id] = true
	}
	if c.ActiveSourceLeaseID != "" && (!oneOf(c.Layout, "single", "active-speaker") || !seen[c.ActiveSourceLeaseID]) {
		return fail()
	}
	return c, nil
}

// Local presentation adapter only. A future socket/HTTP director must first
// authorize the actual caller; possession of these IDs is never authority.
func (p *sourceProgramGeneration) ApplySceneCommand(raw []byte) (sourceSceneReceipt, error) {
	p.sceneMu.Lock()
	defer p.sceneMu.Unlock()
	now := p.cfg.now()
	c, err := parseSourceSceneCommand(raw, now)
	if err != nil {
		return sourceSceneReceipt{}, err
	}
	s := p.cfg.scope
	if !p.permitted() || now.UnixMilli() < p.sceneLastNow || c.AssignmentID != s.assignmentID || c.ProgramID != s.programID ||
		c.ProgramEpoch != s.programEpoch || c.LeaseID != s.writerLeaseID || c.FencingRevision != s.fencingRevision {
		return sourceSceneReceipt{}, errors.New("source scene authority changed")
	}
	p.sceneLastNow = now.UnixMilli()
	canonical, _ := json.Marshal(c)
	digest := sha256.Sum256(canonical)
	if p.sceneHistory == nil {
		p.sceneHistory = make(map[string]sourceSceneHistory)
	}
	for id, previous := range p.sceneHistory {
		if previous.expiresAt <= now.UnixMilli() {
			delete(p.sceneHistory, id)
		}
	}
	if previous, ok := p.sceneHistory[c.CommandID]; ok {
		if previous.digest != digest {
			return sourceSceneReceipt{}, errors.New("source scene command conflict")
		}
		return previous.receipt, nil // Receipt of past application, not current-scene/source authority.
	}
	if len(p.sceneHistory) >= maximumSourceSceneHistory {
		return sourceSceneReceipt{}, errors.New("source scene capacity")
	}
	revision, err := p.SetScene(c.ExpectedSceneRevision, c.Layout, c.SourceLeaseIDs, c.ActiveSourceLeaseID)
	if err != nil {
		return sourceSceneReceipt{}, errors.New("source scene rejected")
	}
	r := sourceSceneReceipt{Version: 1, Type: "source-program-scene-applied", CommandID: c.CommandID, AssignmentID: c.AssignmentID,
		ProgramID: c.ProgramID, ProgramEpoch: c.ProgramEpoch, LeaseID: c.LeaseID, FencingRevision: c.FencingRevision,
		SceneRevision: revision, AppliedAt: now.UnixMilli()}
	p.sceneHistory[c.CommandID] = sourceSceneHistory{digest: digest, receipt: r, expiresAt: c.ExpiresAt}
	return r, nil
}
