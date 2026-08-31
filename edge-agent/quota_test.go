package main

import (
	"testing"
	"time"
)

func TestQuotaReservesAndReleasesHardLimits(t *testing.T) {
	now := time.Unix(1_000_000, 0)
	quota := newQuotaTracker(2, 1, func() time.Time { return now })
	if !quota.handler("alice", "realm", nil) || quota.handler("alice", "realm", nil) {
		t.Fatal("per-user reservation limit was not enforced")
	}
	if !quota.handler("bob", "realm", nil) || quota.handler("carol", "realm", nil) {
		t.Fatal("global reservation limit was not enforced")
	}
	events := quota.eventHandler()
	events.OnAllocationCreated(nil, nil, "UDP", "alice", "realm", nil, 0)
	events.OnAllocationDeleted(nil, nil, "UDP", "alice", "realm")
	if !quota.handler("alice", "realm", nil) {
		t.Fatal("released allocation did not restore quota")
	}
	now = now.Add(6 * time.Second)
	if !quota.handler("carol", "realm", nil) {
		t.Fatal("failed allocation reservation did not expire")
	}
}
