package main

import (
	"testing"
	"time"
)

// Execute the post-detach cleanup after a successor has obtained the registry.
// Wire IDs deliberately remain identical: object identity is the local fence.
func TestTrustedSourceLateAssignmentCleanupPreservesSuccessor(t *testing.T) {
	c, lease, now := trustedSourceFixture(t)
	old := c.assignment
	previous, err := c.prepareTrustedSource(sourceBytes(t, lease), now)
	if err != nil {
		t.Fatal(err)
	}
	c.assignmentMu.Lock()
	old.State = "stopped"
	next := assignmentFrom(assignmentMessage(now))
	next.State = "running"
	c.assignment = next
	c.assignmentMu.Unlock()
	lease.SourceLeaseID = "sls_bbbbbbbbbbbbbbbb"
	lease.Consent.ConsentID = "cns_bbbbbbbbbbbbbbbb"
	lease.Consent.SourceID = "src_bbbbbbbbbbbbbbbb"
	current, err := c.prepareTrustedSource(sourceBytes(t, lease), time.Now())
	if err != nil {
		t.Fatal(err)
	}
	c.closeAssignmentTrustedSources(old)
	if !current.AliveNow() || len(c.trustedSources) != 1 {
		t.Fatal("late predecessor cleanup stopped successor source")
	}
	select {
	case <-previous.Done():
	default:
		t.Fatal("predecessor source retained")
	}
	c.closeAssignmentTrustedSources(nil)
	if !current.AliveNow() {
		t.Fatal("nil assignment erased successor")
	}
	c.closeAssignmentTrustedSources(next)
	if current.AliveNow() || len(c.trustedSources) != 0 || len(c.trustedSourceHistory) != 2 {
		t.Fatal("owned cleanup did not close source or retain consent history")
	}
}
