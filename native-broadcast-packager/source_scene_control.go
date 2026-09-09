package main

import (
	"errors"
	"time"
)

// Invoked only by the authenticated control reader. It cannot allocate a
// program/source or infer consent from the scene's reference fields.
func (c *client) handleSourceScene(m serverMessage) error {
	if !c.cfg.sourcePrograms || !c.sessionAuthenticated.Load() || len(m.SourceScene) == 0 {
		return errors.New("source scene control denied")
	}
	var command sourceSceneCommand
	var err error
	if m.Type == "source-program-scene-query" {
		var q sourceSceneQuery
		q, err = parseSourceSceneQuery(m.SourceScene, time.Now())
		command = q.command()
	} else if m.Type == "source-program-scene" {
		command, err = parseSourceSceneCommand(m.SourceScene, time.Now())
	} else {
		return errors.New("source scene control denied")
	}
	if err != nil {
		return err
	}
	c.assignmentMu.Lock()
	a := c.assignment
	var owner *sourceAssignmentOwner
	if a != nil && a.AssignmentID == command.AssignmentID && a.ProgramID == command.ProgramID &&
		int64(a.ProgramEpoch) == command.ProgramEpoch && a.LeaseID == command.LeaseID && int64(a.FencingRevision) == command.FencingRevision {
		owner = a.sourceProgram
	}
	c.assignmentMu.Unlock()
	if owner == nil || !owner.permitted() {
		return errors.New("source scene owner unavailable")
	}
	p := owner.generation.Load()
	if p == nil {
		return errors.New("source scene generation unavailable")
	}
	var reply any
	if m.Type == "source-program-scene-query" {
		reply, err = p.QueryScene(m.SourceScene)
		if err != nil {
			return err
		}
	} else {
		var receipt sourceSceneReceipt
		receipt, err = p.ApplySceneCommand(m.SourceScene)
		if err != nil {
			// A conflict with the current owner's presentation is not a new authority
			// grant and must not destroy the running encoder. The director must query.
			rejected := sourceSceneReply(command, "source-program-scene-rejected", time.Now().UnixMilli())
			rejected["reasonCode"] = "SCENE_NOT_APPLIED"
			reply = rejected
		} else {
			reply = receipt
		}
	}
	if !owner.permitted() || time.Now().UnixMilli() >= command.ExpiresAt {
		return errors.New("source scene authority expired")
	}
	return c.send(reply)
}
