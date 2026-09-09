package main

import (
	"errors"
	"time"
)

const maximumSourcePrepareWaiters = 8
const sourcePrepareRetryTimeout = 5 * time.Second

func (o *sourceAssignmentOwner) retryPrepare() error {
	if o.waiters.Add(1) > maximumSourcePrepareWaiters {
		o.waiters.Add(-1)
		return errors.New("source assignment retry capacity")
	}
	defer o.waiters.Add(-1)
	if !o.permitted() {
		return errors.New("source assignment retry revoked")
	}
	timer := time.NewTimer(sourcePrepareRetryTimeout)
	defer timer.Stop()
	select {
	case <-o.prepared:
	case <-o.done:
		return errors.New("source assignment retry revoked")
	case <-timer.C:
		return errors.New("source assignment retry timeout")
	}
	return o.sendCurrentStatus()
}

func (o *sourceAssignmentOwner) sendCurrentStatus() error {
	o.statusMu.Lock()
	defer o.statusMu.Unlock()
	if !o.permitted() || !o.attached.Load() {
		return errors.New("source assignment status revoked")
	}
	c, a := o.client, o.assignment
	c.assignmentMu.Lock()
	current := c.assignment == a && oneOf(a.State, "ready", "starting", "running", "degraded")
	state, reason := a.State, o.reasonCode
	c.assignmentMu.Unlock()
	if !current {
		return errors.New("source assignment status stale")
	}
	return c.send(c.assignmentStatus(a, state, reason))
}

// Every nonterminal v4 state change and retry uses the same wire-order lock.
// Registry locks protect only the state snapshot, never socket IO or reaping.
func (o *sourceAssignmentOwner) transition(state, reason string) error {
	if state == "failed" {
		return o.fail(reason)
	}
	o.statusMu.Lock()
	defer o.statusMu.Unlock()
	c, a := o.client, o.assignment
	for {
		if !o.permitted() {
			return nil
		}
		c.assignmentMu.Lock()
		// Output readiness may heal only its own bounded encoder restart, never
		// thermal pressure or another independently degraded assignment state.
		if state == "running" && reason == "OUTPUT_READY" && a.State == "degraded" && o.reasonCode != "SOURCE_PROGRAM_RESTARTING" {
			c.assignmentMu.Unlock()
			return nil
		}
		if c.assignment != a {
			c.assignmentMu.Unlock()
			return nil
		}
		if a.State == state {
			if state == "degraded" && o.reasonCode == "SOURCE_PROGRAM_RESTARTING" && reason != "SOURCE_PROGRAM_RESTARTING" {
				o.reasonCode = reason
				c.assignmentMu.Unlock()
				return c.send(c.assignmentStatus(a, state, reason))
			}
			c.assignmentMu.Unlock()
			return nil
		}
		next, nextReason := state, reason
		if a.State == "ready" && state == "running" {
			next, nextReason = "starting", "PROGRAM_STARTING"
		}
		if !allowedAssignmentTransition(a.State, next) {
			c.assignmentMu.Unlock()
			return nil
		}
		a.State, o.reasonCode = next, nextReason
		c.assignmentMu.Unlock()
		if err := c.send(c.assignmentStatus(a, next, nextReason)); err != nil {
			return err
		}
		if next == state {
			return nil
		}
	}
}

func (o *sourceAssignmentOwner) fail(reason string) error {
	c, a := o.client, o.assignment
	o.statusMu.Lock()
	c.assignmentMu.Lock()
	if c.assignment != a || !allowedAssignmentTransition(a.State, "failed") {
		c.assignmentMu.Unlock()
		o.statusMu.Unlock()
		return nil
	}
	a.State, o.reasonCode = "failed", reason
	o.once.Do(func() { close(o.done) })
	c.assignmentMu.Unlock()
	o.statusMu.Unlock()
	c.closeAssignmentTrustedResources(a)
	o.statusMu.Lock()
	defer o.statusMu.Unlock()
	c.assignmentMu.Lock()
	current := c.assignment == a && a.State == "failed"
	c.assignmentMu.Unlock()
	if !current {
		return nil
	}
	return c.send(c.assignmentStatus(a, "failed", reason))
}
