package main

import (
	"encoding/json"
	"errors"
	"time"
)

func sourceProgramsEnabled(raw string) (bool, error) {
	switch defaultValue(raw, "disabled") {
	case "disabled":
		return false, nil
	case "enabled":
		return true, nil
	default:
		return false, errors.New("NATIVE_PACKAGER_SOURCE_PROGRAMS is invalid")
	}
}

// The legacy decoder remains closed to v4. Only this explicitly enabled
// control path can project a fully validated v4 assignment into its own slot.
func decodePackagerControlMessage(raw []byte, now time.Time, sources bool) (serverMessage, error) {
	if len(raw) > 96*1024 {
		return serverMessage{}, errors.New("control message size")
	}
	var header struct {
		Version int    `json:"version"`
		Type    string `json:"type"`
	}
	if json.Unmarshal(raw, &header) != nil {
		return serverMessage{}, errors.New("invalid control message")
	}
	if header.Type == "source-program-scene" || header.Type == "source-program-scene-query" {
		if !sources {
			return serverMessage{}, errors.New("source scenes disabled")
		}
		var err error
		if header.Type == "source-program-scene" {
			_, err = parseSourceSceneCommand(raw, now)
		} else {
			_, err = parseSourceSceneQuery(raw, now)
		}
		if err != nil {
			return serverMessage{}, err
		}
		return serverMessage{Version: 1, Type: header.Type, SourceScene: append(json.RawMessage(nil), raw...)}, nil
	}
	if header.Version == 4 && header.Type == "assignment-prepare" {
		if !sources {
			return serverMessage{}, errors.New("source programs disabled")
		}
		if _, err := parseSourceProgramAssignment(raw, now); err != nil {
			return serverMessage{}, err
		}
		return serverMessage{Version: 4, Type: "assignment-prepare", SourceProgram: append(json.RawMessage(nil), raw...)}, nil
	}
	return decodeServerMessage(raw)
}

func (c *client) prepareControlAssignment(m serverMessage, now time.Time) error {
	if m.Version != 4 {
		return c.prepareAssignment(m, now)
	}
	if !c.cfg.sourcePrograms || !c.sessionAuthenticated.Load() || len(m.SourceProgram) == 0 {
		return errors.New("source control admission denied")
	}
	r, err := parseSourceProgramAssignment(m.SourceProgram, now)
	if err != nil {
		return err
	}
	if err := c.prepareLocalSourceProgramAssignment(m.SourceProgram, now, nil); err != nil {
		return err
	}
	c.assignmentMu.Lock()
	a := c.assignment
	var owner *sourceAssignmentOwner
	if a != nil && a.AssignmentID == r.AssignmentID && int64(a.ProgramEpoch) == r.ProgramEpoch && int64(a.FencingRevision) == r.FencingRevision {
		owner = a.sourceProgram
	}
	c.assignmentMu.Unlock()
	if owner != nil {
		owner.observeOutputReadiness()
	}
	return nil
}

// Called only after the initial ready response has completed. A real output
// readiness signal may precede source ingress: a valid slate is still output,
// never evidence that a publisher has delivered media or consented to a source.
func (o *sourceAssignmentOwner) observeOutputReadiness() {
	o.outputStatusOnce.Do(func() {
		go func() {
			p := o.generation.Load()
			if p == nil {
				return
			}
			if output, ok := p.output.(sourceChangingOutput); ok {
				o.observeChangingOutput(p, output)
				return
			}
			select {
			case <-o.done:
				return
			case <-p.finished:
				return
			case <-p.output.ReadySignal():
			}
			if p.Ready() {
				if err := o.transition("running", "OUTPUT_READY"); err != nil {
					o.cancel()
				}
			}
		}()
	})
}

// Constant-time authority invalidation precedes any codec/resource reaping.
func (c *client) revokeControlSession() {
	c.sessionAuthenticated.Store(false)
	c.assignmentMu.Lock()
	var owner *sourceAssignmentOwner
	if c.assignment != nil {
		owner = c.assignment.sourceProgram
	}
	if owner != nil {
		owner.once.Do(func() { close(owner.done) })
	}
	c.assignmentMu.Unlock()
	if owner != nil {
		owner.cancel()
	}
}
