package main

import (
	"bytes"
	"encoding/json"
	"os"
	"reflect"
	"sync"
	"testing"
	"time"
)

func sceneQueryBytes(t *testing.T, q sourceSceneQuery) []byte {
	t.Helper()
	raw, err := json.Marshal(q)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}
func sceneQueryFor(c sourceSceneCommand) sourceSceneQuery {
	return sourceSceneQuery{Version: 1, Type: "source-program-scene-query", CommandID: c.CommandID, AssignmentID: c.AssignmentID,
		ProgramID: c.ProgramID, ProgramEpoch: c.ProgramEpoch, LeaseID: c.LeaseID, FencingRevision: c.FencingRevision, IssuedAt: c.IssuedAt, ExpiresAt: c.ExpiresAt}
}

func TestSourceSceneQuerySharedFixtureAndClosedDecoder(t *testing.T) {
	raw, err := os.ReadFile("testdata/source-scene-query.v1.json")
	if err != nil {
		t.Fatal(err)
	}
	p, c, clock, _ := sceneFixture(t)
	q, err := parseSourceSceneQuery(raw, time.UnixMilli(clock.Load()))
	if err != nil {
		t.Fatal(err)
	}
	if q.command().AssignmentID != c.AssignmentID {
		t.Fatal("query scope changed")
	}
	if _, err := decodeServerMessage(raw); err == nil {
		t.Fatal("legacy decoder accepted query")
	}
	if _, err := decodePackagerControlMessage(raw, time.UnixMilli(clock.Load()), false); err == nil {
		t.Fatal("disabled query accepted")
	}
	borrowed := append([]byte(nil), raw...)
	m, err := decodePackagerControlMessage(borrowed, time.UnixMilli(clock.Load()), true)
	clear(borrowed)
	if err != nil || !bytes.Equal(m.SourceScene, raw) {
		t.Fatal("query bytes not owned")
	}
	for _, bad := range [][]byte{[]byte("null"), append(append([]byte(nil), raw...), []byte(" {}")...),
		bytes.Replace(raw, []byte(`"version": 1`), []byte(`"version": 1,"version": 1`), 1),
		bytes.Replace(raw, []byte(`"commandId"`), []byte(`"CommandId"`), 1),
		append([]byte{0xff}, raw...), make([]byte, maximumSourceSceneBytes+1)} {
		if _, err := parseSourceSceneQuery(bad, time.UnixMilli(clock.Load())); err == nil {
			t.Fatal("invalid query accepted")
		}
	}
	state, err := p.QueryScene(raw)
	if err != nil {
		t.Fatal(err)
	}
	encoded, _ := json.Marshal(state)
	expected, err := os.ReadFile("testdata/source-scene-state.v1.json")
	if err != nil {
		t.Fatal(err)
	}
	var actual, fixture any
	if json.Unmarshal(encoded, &actual) != nil || json.Unmarshal(expected, &fixture) != nil || !reflect.DeepEqual(actual, fixture) {
		t.Fatal("shared state mismatch")
	}
	clock.Add(4000)
	if _, err := p.QueryScene(raw); err == nil {
		t.Fatal("expired query accepted")
	}
}

func TestSourceSceneQueryObservesActualSelectionAndRevokedInput(t *testing.T) {
	c, lease, now := trustedSourceFixture(t)
	p, _ := generationTestOwner(t, generationTestConfig(t, lease), nil)
	receiver, err := c.prepareTrustedSource(sourceBytes(t, lease), now)
	if err != nil {
		t.Fatal(err)
	}
	source, err := p.AddSource(lease, receiver)
	if err != nil {
		t.Fatal(err)
	}
	command := sourceSceneCommand{Version: 1, Type: "source-program-scene", CommandID: "scn_aaaaaaaaaaaaaaaa",
		AssignmentID: lease.AssignmentID, ProgramID: lease.Consent.ProgramID, ProgramEpoch: lease.Consent.ProgramEpoch,
		LeaseID: lease.WriterLeaseID, FencingRevision: lease.FencingRevision, ExpectedSceneRevision: 1, Layout: "single",
		SourceLeaseIDs: []string{lease.SourceLeaseID}, ActiveSourceLeaseID: lease.SourceLeaseID, IssuedAt: now.UnixMilli(), ExpiresAt: now.Add(4 * time.Second).UnixMilli()}
	if _, err := p.ApplySceneCommand(sceneBytes(t, command)); err != nil {
		t.Fatal(err)
	}
	state, err := p.QueryScene(sceneQueryBytes(t, sceneQueryFor(command)))
	if err != nil {
		t.Fatal(err)
	}
	if state["sceneRevision"] != uint64(2) || state["activeSourceLeaseId"] != lease.SourceLeaseID || len(state["availableSources"].([]sourceSceneAvailable)) != 1 {
		t.Fatal("actual source selection missing")
	}
	source.Close()
	awaitSource(t, source.finished)
	state, err = p.QueryScene(sceneQueryBytes(t, sceneQueryFor(command)))
	if err != nil {
		t.Fatal(err)
	}
	if len(state["availableSources"].([]sourceSceneAvailable)) != 0 || state["sceneRevision"] != uint64(2) {
		t.Fatal("revoked input remained available or changed scene revision")
	}
}

func TestSourceSceneControlCurrentOwnerAndBenignConflict(t *testing.T) {
	c, r, local, _ := sourceOwnerFixture(t)
	c.cfg.sourcePrograms = true
	var replies []any
	var replyMu sync.Mutex
	c.sendOverride = func(v any) error {
		replyMu.Lock()
		defer replyMu.Unlock()
		if m, ok := v.(map[string]any); ok && m["type"] == "assignment-status" {
			return nil
		}
		replies = append(replies, v)
		return nil
	}
	if err := c.prepareSourceProgramAssignment(sourceAssignmentBytes(t, r), time.Now(), local, sourceOwnerTestFactory); err != nil {
		t.Fatal(err)
	}
	now := time.Now().UnixMilli()
	command := sourceSceneCommand{Version: 1, Type: "source-program-scene", CommandID: "scn_aaaaaaaaaaaaaaaa", AssignmentID: r.AssignmentID,
		ProgramID: r.ProgramID, ProgramEpoch: r.ProgramEpoch, LeaseID: r.LeaseID, FencingRevision: r.FencingRevision,
		ExpectedSceneRevision: 2, Layout: "grid", SourceLeaseIDs: []string{}, IssuedAt: now, ExpiresAt: now + 4000}
	handle := func(raw []byte) error {
		m, err := decodePackagerControlMessage(raw, time.Now(), true)
		if err != nil {
			return err
		}
		return c.handleSourceScene(m)
	}
	a := c.assignment
	if err := handle(sceneBytes(t, command)); err != nil {
		t.Fatal("benign conflict broke control", err)
	}
	if len(replies) != 1 || replies[0].(map[string]any)["type"] != "source-program-scene-rejected" || replies[0].(map[string]any)["reasonCode"] != "SCENE_NOT_APPLIED" || c.assignment != a || !a.sourceProgram.permitted() {
		t.Fatal("conflict changed owner")
	}
	command.ExpectedSceneRevision = 1
	if err := handle(sceneBytes(t, command)); err != nil {
		t.Fatal(err)
	}
	if replies[len(replies)-1].(sourceSceneReceipt).SceneRevision != 2 {
		t.Fatal("application not acknowledged")
	}
	if err := handle(sceneQueryBytes(t, sceneQueryFor(command))); err != nil {
		t.Fatal(err)
	}
	if replies[len(replies)-1].(map[string]any)["sceneRevision"] != uint64(2) {
		t.Fatal("query did not observe application")
	}
	count := len(replies)
	for _, change := range []func(*sourceSceneCommand){
		func(v *sourceSceneCommand) { v.AssignmentID = "asn_bbbbbbbbbbbbbbbb" }, func(v *sourceSceneCommand) { v.ProgramID = "prg_bbbbbbbbbbbbbbbb" },
		func(v *sourceSceneCommand) { v.ProgramEpoch++ }, func(v *sourceSceneCommand) { v.LeaseID = "lea_bbbbbbbbbbbbbbbb" }, func(v *sourceSceneCommand) { v.FencingRevision++ },
	} {
		bad := command
		change(&bad)
		if err := handle(sceneBytes(t, bad)); err == nil {
			t.Fatal("foreign owner accepted")
		}
	}
	c.cfg.sourcePrograms = false
	if err := handle(sceneBytes(t, command)); err == nil {
		t.Fatal("local opt-in bypassed")
	}
	c.cfg.sourcePrograms = true
	c.sessionAuthenticated.Store(false)
	if err := handle(sceneBytes(t, command)); err == nil {
		t.Fatal("authentication bypassed")
	}
	if len(replies) != count {
		t.Fatal("unauthorized request received scene metadata")
	}
}

func TestSourceSceneCommandExpiresWhileWaitingForRenderLock(t *testing.T) {
	p, c, clock, _ := sceneFixture(t)
	entered := make(chan struct{}, 1)
	p.cfg.now = func() time.Time {
		at := clock.Load()
		select {
		case entered <- struct{}{}:
		default:
		}
		return time.UnixMilli(at)
	}
	p.video.mu.Lock()
	finished := make(chan error, 1)
	go func() { _, err := p.ApplySceneCommand(sceneBytes(t, c)); finished <- err }()
	<-entered
	clock.Add(4000)
	p.video.mu.Unlock()
	if err := <-finished; err == nil || p.video.revision != 1 || p.video.closed {
		t.Fatal("expired queued command changed or closed compositor")
	}
}

// Called by the actual TLS/P-256 control test only after real HLS readiness.
func exerciseSourceSceneSocket(t *testing.T, r sourceProgramAssignment, write func(any), read func() map[string]any) {
	t.Helper()
	now := time.Now().UnixMilli()
	q := sourceSceneQuery{Version: 1, Type: "source-program-scene-query", CommandID: "scn_aaaaaaaaaaaaaaaa", AssignmentID: r.AssignmentID,
		ProgramID: r.ProgramID, ProgramEpoch: r.ProgramEpoch, LeaseID: r.LeaseID, FencingRevision: r.FencingRevision, IssuedAt: now, ExpiresAt: now + 4000}
	write(q)
	state := read()
	if state["type"] != "source-program-scene-state" || state["sceneRevision"] != float64(1) || state["layout"] != "waiting-slate" {
		t.Fatal("wire query missed native initial scene")
	}
	cmd := q.command()
	cmd.Layout = "grid"
	write(cmd)
	applied := read()
	if applied["type"] != "source-program-scene-applied" || applied["sceneRevision"] != float64(2) {
		t.Fatal("wire scene was not applied")
	}
	cmd.CommandID = "scn_bbbbbbbbbbbbbbbb"
	write(cmd)
	rejected := read()
	if rejected["type"] != "source-program-scene-rejected" || rejected["reasonCode"] != "SCENE_NOT_APPLIED" {
		t.Fatal("wire CAS conflict not rejected")
	}
	write(q)
	state = read()
	if state["type"] != "source-program-scene-state" || state["sceneRevision"] != float64(2) || state["layout"] != "grid" {
		t.Fatal("query after conflict failed or scene changed")
	}
}
