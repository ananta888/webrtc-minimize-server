package main

import (
	"errors"
	"time"
)

type sourceAudioRejection struct {
	sourceAudioControlScope
	ObservedAt int64  `json:"observedAt"`
	ReasonCode string `json:"reasonCode"`
}

// The authenticated reader alone calls this adapter. A query or selection
// neither admits a source nor extends the current writer's authority.
func (c *client) handleSourceAudio(m serverMessage) error {
	if !c.cfg.sourcePrograms || !c.sessionAuthenticated.Load() || len(m.SourceAudio) == 0 {
		return errors.New("source audio control denied")
	}
	var q sourceAudioQuery
	var err error
	switch m.Type {
	case "source-program-audio-query":
		q, err = parseSourceAudioQuery(m.SourceAudio, time.Now())
	case "source-program-audio":
		var command sourceAudioCommand
		command, err = parseSourceAudioCommand(m.SourceAudio, time.Now())
		q = command.sourceAudioQuery
	default:
		return errors.New("source audio control denied")
	}
	if err != nil {
		return err
	}
	c.assignmentMu.Lock()
	a := c.assignment
	var owner *sourceAssignmentOwner
	if a != nil && a.AssignmentID == q.AssignmentID && a.ProgramID == q.ProgramID && int64(a.ProgramEpoch) == q.ProgramEpoch &&
		a.LeaseID == q.LeaseID && int64(a.FencingRevision) == q.FencingRevision {
		owner = a.sourceProgram
	}
	c.assignmentMu.Unlock()
	if owner == nil || !owner.permitted() {
		return errors.New("source audio owner unavailable")
	}
	p := owner.generation.Load()
	if p == nil {
		return errors.New("source audio generation unavailable")
	}
	var reply any
	if m.Type == "source-program-audio-query" {
		reply, err = p.QueryAudio(m.SourceAudio)
		if err != nil {
			return err
		}
	} else {
		reply, err = p.ApplyAudioCommand(m.SourceAudio)
		if err != nil {
			scope := q.sourceAudioControlScope
			scope.Type = "source-program-audio-rejected"
			reply = sourceAudioRejection{scope, time.Now().UnixMilli(), "AUDIO_NOT_APPLIED"}
		}
	}
	if !owner.permitted() || owner.generation.Load() != p || time.Now().UnixMilli() >= q.ExpiresAt {
		return errors.New("source audio authority expired")
	}
	return c.send(reply)
}
