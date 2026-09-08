package main

import (
	"encoding/json"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestSourceAssignmentIdenticalPrepareReusesGeneration(t *testing.T) {
	c, r, local, lease := sourceOwnerFixture(t)
	raw := sourceAssignmentBytes(t, r)
	creates := 0
	factory := func(cfg sourceProgramGenerationConfig) (*sourceProgramGeneration, error) {
		creates++
		return sourceOwnerTestFactory(cfg)
	}
	if err := c.prepareSourceProgramAssignment(raw, time.Now(), local, factory); err != nil {
		t.Fatal(err)
	}
	a := c.assignment
	receiver, err := c.prepareTrustedSource(sourceBytes(t, lease), time.Now())
	if err != nil {
		t.Fatal(err)
	}
	deadline := a.sourceProgram.deadline.Load()
	if err = c.prepareSourceProgramAssignment(raw, time.Now(), local, factory); err != nil {
		t.Fatal("identical prepare rejected", err)
	}
	if creates != 1 || c.assignment != a || a.sourceProgram.deadline.Load() != deadline || a.expiresAt.Load() != r.ExpiresAt || !receiver.AliveNow() {
		t.Fatal("retry replaced generation, rights or deadline")
	}
	msg := serverMessage{AssignmentID: a.AssignmentID, ProgramEpoch: a.ProgramEpoch, FencingRevision: a.FencingRevision, ExpiresAt: r.ExpiresAt + 1000}
	if err = c.renewAssignment(msg, time.Now()); err != nil {
		t.Fatal(err)
	}
	deadline = a.sourceProgram.deadline.Load()
	if err = c.prepareSourceProgramAssignment(raw, time.Now(), local, factory); err != nil || a.sourceProgram.deadline.Load() != deadline || a.expiresAt.Load() != msg.ExpiresAt || creates != 1 || !receiver.AliveNow() {
		t.Fatal("prepare replay changed renewed owner", err)
	}
	r.ExpiresAt = msg.ExpiresAt
	if err = c.prepareSourceProgramAssignment(sourceAssignmentBytes(t, r), time.Now(), local, factory); err != nil || a.sourceProgram.deadline.Load() != deadline || creates != 1 || !receiver.AliveNow() {
		t.Fatal("current server expiry was not an idempotent retry", err)
	}
}

func TestSourceAssignmentRetryRejectsChangedWireFields(t *testing.T) {
	c, r, local, _ := sourceOwnerFixture(t)
	raw := sourceAssignmentBytes(t, r)
	if err := c.prepareSourceProgramAssignment(raw, time.Now(), local, sourceOwnerTestFactory); err != nil {
		t.Fatal(err)
	}
	a := c.assignment
	for _, mutate := range []func(*sourceProgramAssignment){
		func(r *sourceProgramAssignment) { r.AssignmentID = "asn_bbbbbbbbbbbbbbbb" },
		func(r *sourceProgramAssignment) { r.ProgramID = "prg_bbbbbbbbbbbbbbbb" },
		func(r *sourceProgramAssignment) { r.ProgramEpoch++ },
		func(r *sourceProgramAssignment) { r.FencingRevision++ },
		func(r *sourceProgramAssignment) { r.LeaseID = "lea_bbbbbbbbbbbbbbbb" },
		func(r *sourceProgramAssignment) { r.ResourceRef = "res_bbbbbbbbbbbbbbbb" },
		func(r *sourceProgramAssignment) { r.SourceContext.TenantID = "tn_bbbbbbbbbbbbbbbb" },
		func(r *sourceProgramAssignment) { r.SourceContext.RoomEpoch++ },
		func(r *sourceProgramAssignment) { r.ExpiresAt++ },
		func(r *sourceProgramAssignment) { r.Profile.Renditions[0].VideoBitsPerSecond++ },
		func(r *sourceProgramAssignment) {
			r.ICEServers = []assignmentICEServer{{URLs: []string{"stun:example.invalid:3478"}}}
		},
	} {
		var changed sourceProgramAssignment
		if err := json.Unmarshal(raw, &changed); err != nil {
			t.Fatal(err)
		}
		mutate(&changed)
		called := false
		err := c.prepareSourceProgramAssignment(sourceAssignmentBytes(t, changed), time.Now(), local, func(sourceProgramGenerationConfig) (*sourceProgramGeneration, error) {
			called = true
			return nil, errors.New("unexpected constructor")
		})
		if err == nil || called || c.assignment != a || !a.sourceProgram.permitted() {
			t.Fatal("changed assignment treated as retry")
		}
	}
	local.maxSources--
	if err := c.prepareSourceProgramAssignment(raw, time.Now(), local, sourceOwnerTestFactory); err == nil || c.assignment != a || !a.sourceProgram.permitted() {
		t.Fatal("retry silently accepted different local resource policy")
	}
}

func TestSourceAssignmentRetryReportsCurrentStateAndReason(t *testing.T) {
	c, r, local, _ := sourceOwnerFixture(t)
	var mu sync.Mutex
	var last map[string]any
	c.sendOverride = func(value any) error { mu.Lock(); last = value.(map[string]any); mu.Unlock(); return nil }
	raw := sourceAssignmentBytes(t, r)
	if err := c.prepareSourceProgramAssignment(raw, time.Now(), local, sourceOwnerTestFactory); err != nil {
		t.Fatal(err)
	}
	for _, status := range [][2]string{{"running", "OUTPUT_READY"}, {"degraded", "THERMAL_PRESSURE"}, {"running", "THERMAL_RECOVERED"}} {
		if err := c.transitionAssignment(c.assignment, status[0], status[1]); err != nil {
			t.Fatal(err)
		}
		if err := c.prepareSourceProgramAssignment(raw, time.Now(), local, sourceOwnerTestFactory); err != nil {
			t.Fatal(err)
		}
		mu.Lock()
		state, reason := last["state"], last["reasonCode"]
		mu.Unlock()
		if state != status[0] || reason != status[1] {
			t.Fatal("retry regressed state or replaced readiness reason")
		}
	}
}

func waitSourceRetryResult(t *testing.T, result <-chan error) error {
	t.Helper()
	select {
	case err := <-result:
		return err
	case <-time.After(3 * time.Second):
		t.Fatal("retry fixture did not terminate")
		return nil
	}
}

func TestSourceAssignmentPendingRetriesBoundedAndRevocable(t *testing.T) {
	for _, revoke := range []bool{false, true} {
		t.Run(map[bool]string{false: "release", true: "revoke"}[revoke], func(t *testing.T) {
			c, r, local, _ := sourceOwnerFixture(t)
			raw := sourceAssignmentBytes(t, r)
			entered, release := make(chan struct{}), make(chan struct{})
			var once sync.Once
			unblock := func() { once.Do(func() { close(release) }) }
			defer unblock()
			var creates atomic.Int32
			factory := func(cfg sourceProgramGenerationConfig) (*sourceProgramGeneration, error) {
				creates.Add(1)
				close(entered)
				<-release
				return sourceOwnerTestFactory(cfg)
			}
			first := make(chan error, 1)
			go func() { first <- c.prepareSourceProgramAssignment(raw, time.Now(), local, factory) }()
			awaitSource(t, entered)
			c.assignmentMu.Lock()
			a := c.assignment
			c.assignmentMu.Unlock()
			results := make(chan error, maximumSourcePrepareWaiters)
			for i := 0; i < maximumSourcePrepareWaiters; i++ {
				go func() { results <- c.prepareSourceProgramAssignment(raw, time.Now(), local, factory) }()
			}
			deadline := time.Now().Add(time.Second)
			for a.sourceProgram.waiters.Load() != maximumSourcePrepareWaiters && time.Now().Before(deadline) {
				time.Sleep(time.Millisecond)
			}
			if a.sourceProgram.waiters.Load() != maximumSourcePrepareWaiters {
				t.Fatal("pending retry slots not occupied")
			}
			if err := c.prepareSourceProgramAssignment(raw, time.Now(), local, factory); err == nil {
				t.Fatal("retry capacity exceeded")
			}
			if revoke {
				c.setConsentedRooms(nil)
			} else {
				unblock()
			}
			for i := 0; i < maximumSourcePrepareWaiters; i++ {
				if err := waitSourceRetryResult(t, results); (err != nil) != revoke {
					t.Fatal("retry result did not follow owner", err)
				}
			}
			unblock()
			if err := waitSourceRetryResult(t, first); (err != nil) != revoke {
				t.Fatal("original owner outcome", err)
			}
			if creates.Load() != 1 || a.sourceProgram.waiters.Load() != 0 {
				t.Fatal("retry created another generation or retained waiter")
			}
		})
	}
}

func TestSourceAssignmentRetryCannotOvertakeStatusTransition(t *testing.T) {
	c, r, local, _ := sourceOwnerFixture(t)
	raw := sourceAssignmentBytes(t, r)
	if err := c.prepareSourceProgramAssignment(raw, time.Now(), local, sourceOwnerTestFactory); err != nil {
		t.Fatal(err)
	}
	a := c.assignment
	entered, release := make(chan struct{}), make(chan struct{})
	var once sync.Once
	unblock := func() { once.Do(func() { close(release) }) }
	defer unblock()
	var states []string
	var mu sync.Mutex
	c.sendOverride = func(value any) error {
		state := value.(map[string]any)["state"].(string)
		if state == "ready" {
			close(entered)
			<-release
		}
		mu.Lock()
		states = append(states, state)
		mu.Unlock()
		return nil
	}
	retry, transition := make(chan error, 1), make(chan error, 1)
	go func() { retry <- c.prepareSourceProgramAssignment(raw, time.Now(), local, sourceOwnerTestFactory) }()
	awaitSource(t, entered)
	go func() { transition <- c.transitionAssignment(a, "running", "OUTPUT_READY") }()
	unblock()
	if err := waitSourceRetryResult(t, retry); err != nil {
		t.Fatal(err)
	}
	if err := waitSourceRetryResult(t, transition); err != nil {
		t.Fatal(err)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(states) != 3 || states[0] != "ready" || states[1] != "starting" || states[2] != "running" {
		t.Fatal("retry and transition wire order", states)
	}
}

func TestSourceAssignmentRetryTimeoutPreservesPendingOwner(t *testing.T) {
	c, r, local, _ := sourceOwnerFixture(t)
	raw := sourceAssignmentBytes(t, r)
	entered, release := make(chan struct{}), make(chan struct{})
	var once sync.Once
	unblock := func() { once.Do(func() { close(release) }) }
	defer unblock()
	first := make(chan error, 1)
	go func() {
		first <- c.prepareSourceProgramAssignment(raw, time.Now(), local, func(cfg sourceProgramGenerationConfig) (*sourceProgramGeneration, error) {
			close(entered)
			<-release
			return sourceOwnerTestFactory(cfg)
		})
	}()
	awaitSource(t, entered)
	c.assignmentMu.Lock()
	a := c.assignment
	c.assignmentMu.Unlock()
	result := make(chan error, 1)
	go func() { result <- c.prepareSourceProgramAssignment(raw, time.Now(), local, sourceOwnerTestFactory) }()
	select {
	case err := <-result:
		if err == nil || err.Error() != "source assignment retry timeout" {
			t.Fatal("unexpected timeout outcome", err)
		}
	case <-time.After(6 * time.Second):
		t.Fatal("pending prepare retry exceeded deadline")
	}
	if !a.sourceProgram.permitted() || a.sourceProgram.waiters.Load() != 0 {
		t.Fatal("retry timeout revoked parent or retained slot")
	}
	unblock()
	if err := waitSourceRetryResult(t, first); err != nil {
		t.Fatal(err)
	}
}
