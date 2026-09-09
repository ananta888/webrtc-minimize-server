package main

import (
	"bytes"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestSourceControlQueueBoundsAndFencesPendingConstruction(t *testing.T) {
	c, r, _, _ := sourceOwnerFixture(t)
	c.cfg.sourcePrograms, c.cfg.sourceBudget = true, "compact-v1"
	entered, release := make(chan struct{}), make(chan struct{})
	var once sync.Once
	unblock := func() { once.Do(func() { close(release) }) }
	var calls atomic.Int32
	failed := make(chan struct{}, 1)
	q := newSourceControlQueue(c, func(m serverMessage, now time.Time) error {
		calls.Add(1)
		return c.prepareLocalSourceProgramAssignment(m.SourceProgram, now, func(cfg sourceProgramGenerationConfig) (*sourceProgramGeneration, error) {
			close(entered)
			<-release
			return sourceOwnerTestFactory(cfg)
		})
	}, func() { failed <- struct{}{} })
	t.Cleanup(func() { unblock(); q.Close() })
	var wires [][]byte
	push := func() error {
		raw := sourceAssignmentBytes(t, r)
		err := q.Enqueue(serverMessage{Version: 4, Type: "assignment-prepare", SourceProgram: raw})
		if err == nil {
			wires = append(wires, raw)
		}
		return err
	}
	if err := push(); err != nil {
		t.Fatal(err)
	}
	select {
	case <-entered:
	case <-time.After(time.Second):
		t.Fatal("constructor not reached")
	}
	c.assignmentMu.Lock()
	a := c.assignment
	c.assignmentMu.Unlock()
	for i := 0; i < maximumQueuedSourcePrepares; i++ {
		if err := push(); err != nil {
			t.Fatal("bounded pending slot missing", err)
		}
	}
	if err := push(); err == nil {
		t.Fatal("unbounded source prepare queue")
	}
	// This is the reader's room-revocation path while its worker is held.
	c.setConsentedRooms(nil)
	if a.sourceProgram.permitted() {
		t.Fatal("held constructor blocked reader revocation")
	}
	closed := make(chan struct{})
	go func() { q.Close(); close(closed) }()
	select {
	case <-closed:
		t.Fatal("reported reaping before constructor returned")
	default:
	}
	unblock()
	awaitSource(t, closed)
	awaitSource(t, a.sourceProgram.finished)
	if calls.Load() != 1 || c.assignment != nil || c.sessionAuthenticated.Load() {
		t.Fatal("queued work revived revoked connection")
	}
	for _, wire := range wires {
		if !bytes.Equal(wire, make([]byte, len(wire))) {
			t.Fatal("pending control bytes retained")
		}
	}
	if err := push(); err == nil {
		t.Fatal("closed worker admitted request")
	}
}

func TestSourceControlQueueFailureRevokesBeforeConnectionClose(t *testing.T) {
	c, r, _, _ := sourceOwnerFixture(t)
	c.cfg.sourcePrograms = true
	called := make(chan bool, 1)
	q := newSourceControlQueue(c, func(serverMessage, time.Time) error { return errors.New("synthetic admission failure") }, func() {
		called <- c.sessionAuthenticated.Load()
	})
	t.Cleanup(q.Close)
	if err := q.Enqueue(serverMessage{Version: 4, Type: "assignment-prepare", SourceProgram: sourceAssignmentBytes(t, r)}); err != nil {
		t.Fatal(err)
	}
	select {
	case authenticated := <-called:
		if authenticated {
			t.Fatal("socket failure preceded authority fence")
		}
	case <-time.After(time.Second):
		t.Fatal("worker failure not reported")
	}
	awaitSource(t, q.finished)
}
