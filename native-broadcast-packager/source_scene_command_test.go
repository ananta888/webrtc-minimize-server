package main

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func sceneBytes(t *testing.T, c sourceSceneCommand) []byte {
	t.Helper()
	raw, err := json.Marshal(c)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func sceneFixture(t *testing.T) (*sourceProgramGeneration, sourceSceneCommand, *atomic.Int64, *atomic.Bool) {
	t.Helper()
	raw, err := os.ReadFile("testdata/source-scene.v1.json")
	if err != nil {
		t.Fatal(err)
	}
	var c sourceSceneCommand
	if json.Unmarshal(raw, &c) != nil {
		t.Fatal("fixture")
	}
	clock := &atomic.Int64{}
	clock.Store(c.IssuedAt)
	authorized := &atomic.Bool{}
	authorized.Store(true)
	p := &sourceProgramGeneration{video: videoMixFixture(t, 4), sources: make(map[string]*sourceGenerationSource),
		cfg: sourceProgramGenerationConfig{now: func() time.Time { return time.UnixMilli(clock.Load()) },
			scope: sourceProgramScope{assignmentID: c.AssignmentID, programID: c.ProgramID, programEpoch: c.ProgramEpoch,
				writerLeaseID: c.LeaseID, fencingRevision: c.FencingRevision},
			encoder: sourceProgramEncoderConfig{authorized: authorized.Load, revoked: make(chan struct{})}}}
	c.SourceLeaseIDs = []string{}
	return p, c, clock, authorized
}

func TestSourceSceneCommandSharedFixtureAndStrictShape(t *testing.T) {
	raw, err := os.ReadFile("testdata/source-scene.v1.json")
	if err != nil {
		t.Fatal(err)
	}
	var base sourceSceneCommand
	_ = json.Unmarshal(raw, &base)
	if _, err := parseSourceSceneCommand(raw, time.UnixMilli(base.IssuedAt)); err != nil {
		t.Fatal(err)
	}
	for _, change := range []func(map[string]any){
		func(m map[string]any) { m["extra"] = true }, func(m map[string]any) { delete(m, "type") },
		func(m map[string]any) { m["version"] = 2 }, func(m map[string]any) { m["commandId"] = "bad" },
		func(m map[string]any) { m["expectedSceneRevision"] = sourceVideoSceneMaxRevision },
		func(m map[string]any) { m["activeSourceLeaseId"] = nil }, func(m map[string]any) { m["sourceLeaseIds"] = nil },
		func(m map[string]any) { m["sourceLeaseIds"] = []string{"sls_aaaaaaaaaaaaaaaa", "sls_aaaaaaaaaaaaaaaa"} },
		func(m map[string]any) { m["activeSourceLeaseId"] = "sls_aaaaaaaaaaaaaaaa" },
		func(m map[string]any) { m["layout"] = "single"; m["activeSourceLeaseId"] = "sls_bbbbbbbbbbbbbbbb" },
		func(m map[string]any) { m["expiresAt"] = base.IssuedAt },
		func(m map[string]any) { m["expiresAt"] = base.IssuedAt + 4001 },
		func(m map[string]any) { m["issuedAt"] = base.IssuedAt + 1001 },
	} {
		var m map[string]any
		_ = json.Unmarshal(raw, &m)
		change(m)
		bad, _ := json.Marshal(m)
		if _, err := parseSourceSceneCommand(bad, time.UnixMilli(base.IssuedAt)); err == nil {
			t.Fatal("invalid shape accepted")
		}
	}
	for _, bad := range [][]byte{
		[]byte(strings.Replace(string(raw), `"version": 1`, `"version": 1, "version": 1`, 1)),
		append(append([]byte(nil), raw...), []byte(` {}`)...), []byte(strings.Repeat(" ", maximumSourceSceneBytes+1)),
		append([]byte{0xff}, raw...),
	} {
		if _, err := parseSourceSceneCommand(bad, time.UnixMilli(base.IssuedAt)); err == nil {
			t.Fatal("invalid raw bytes accepted")
		}
	}
}

func TestSourceSceneCommandCASReceiptsAndReplay(t *testing.T) {
	p, c, _, _ := sceneFixture(t)
	for i, layout := range []string{"single", "screen-presenter", "side-by-side", "active-speaker", "grid", "waiting-slate", "end-slate"} {
		c.CommandID = fmt.Sprintf("scn_%016d", i)
		c.Layout = layout
		c.ExpectedSceneRevision = uint64(i + 1)
		r, err := p.ApplySceneCommand(sceneBytes(t, c))
		if err != nil || r.SceneRevision != uint64(i+2) || p.video.layout != layout {
			t.Fatal("scene not applied", err)
		}
		again, err := p.ApplySceneCommand(sceneBytes(t, c))
		if err != nil || again != r || p.video.revision != r.SceneRevision {
			t.Fatal("retry changed scene")
		}
		bad := c
		bad.Layout = "grid"
		if layout == "grid" {
			bad.Layout = "single"
		}
		if _, err := p.ApplySceneCommand(sceneBytes(t, bad)); err == nil {
			t.Fatal("changed replay accepted")
		}
		bad = c
		bad.CommandID = "scn_zzzzzzzzzzzzzzzz"
		if _, err := p.ApplySceneCommand(sceneBytes(t, bad)); err == nil {
			t.Fatal("stale CAS accepted")
		}
	}
}

func TestSourceSceneCommandSharedReceipt(t *testing.T) {
	p, c, _, _ := sceneFixture(t)
	r, err := p.ApplySceneCommand(sceneBytes(t, c))
	if err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile("testdata/source-scene-applied.v1.json")
	if err != nil {
		t.Fatal(err)
	}
	var expected sourceSceneReceipt
	if json.Unmarshal(raw, &expected) != nil || r != expected {
		t.Fatal("shared receipt mismatch")
	}
}

func TestSourceSceneCommandScopeAndRevocation(t *testing.T) {
	for _, change := range []func(*sourceSceneCommand){
		func(c *sourceSceneCommand) { c.AssignmentID = "asn_bbbbbbbbbbbbbbbb" },
		func(c *sourceSceneCommand) { c.ProgramID = "prg_bbbbbbbbbbbbbbbb" }, func(c *sourceSceneCommand) { c.ProgramEpoch++ },
		func(c *sourceSceneCommand) { c.LeaseID = "lea_bbbbbbbbbbbbbbbb" }, func(c *sourceSceneCommand) { c.FencingRevision++ },
		func(c *sourceSceneCommand) { c.SourceLeaseIDs = []string{"sls_aaaaaaaaaaaaaaaa"} },
	} {
		p, c, _, _ := sceneFixture(t)
		change(&c)
		if _, err := p.ApplySceneCommand(sceneBytes(t, c)); err == nil || p.video.revision != 1 {
			t.Fatal("foreign scene mutated state")
		}
	}
	p, c, clock, authorized := sceneFixture(t)
	if _, err := p.ApplySceneCommand(sceneBytes(t, c)); err != nil {
		t.Fatal(err)
	}
	authorized.Store(false)
	if _, err := p.ApplySceneCommand(sceneBytes(t, c)); err == nil {
		t.Fatal("receipt revived revoked parent")
	}
	authorized.Store(true)
	clock.Add(-1)
	if _, err := p.ApplySceneCommand(sceneBytes(t, c)); err == nil {
		t.Fatal("backwards clock accepted")
	}
}

func TestSourceSceneCommandBoundedHistoryAndExpiry(t *testing.T) {
	p, c, clock, _ := sceneFixture(t)
	for i := 0; i < maximumSourceSceneHistory; i++ {
		c.CommandID = fmt.Sprintf("scn_%016d", i)
		c.ExpectedSceneRevision = uint64(i + 1)
		if _, err := p.ApplySceneCommand(sceneBytes(t, c)); err != nil {
			t.Fatal(err)
		}
	}
	c.CommandID = "scn_zzzzzzzzzzzzzzzz"
	c.ExpectedSceneRevision++
	if _, err := p.ApplySceneCommand(sceneBytes(t, c)); err == nil {
		t.Fatal("unbounded history")
	}
	clock.Add(4000)
	if _, err := p.ApplySceneCommand(sceneBytes(t, c)); err == nil {
		t.Fatal("expired command accepted")
	}
	c.IssuedAt = clock.Load()
	c.ExpiresAt = c.IssuedAt + 4000
	if _, err := p.ApplySceneCommand(sceneBytes(t, c)); err != nil || len(p.sceneHistory) != 1 {
		t.Fatal("expired capacity not reclaimed", err)
	}
}

func TestSourceSceneCommandConcurrentCAS(t *testing.T) {
	p, c, _, _ := sceneFixture(t)
	var successes atomic.Int64
	var wg sync.WaitGroup
	for i := 0; i < 16; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			command := c
			command.CommandID = fmt.Sprintf("scn_%016d", i)
			if _, err := p.ApplySceneCommand(sceneBytes(t, command)); err == nil {
				successes.Add(1)
			}
		}(i)
	}
	wg.Wait()
	if successes.Load() != 1 || p.video.revision != 2 {
		t.Fatal("competing directors bypassed CAS")
	}
}

func TestSourceSceneCommandUsesActualAuthorizedSourceOwner(t *testing.T) {
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
		LeaseID: lease.WriterLeaseID, FencingRevision: lease.FencingRevision, ExpectedSceneRevision: 1,
		Layout: "single", SourceLeaseIDs: []string{lease.SourceLeaseID}, ActiveSourceLeaseID: lease.SourceLeaseID,
		IssuedAt: now.UnixMilli(), ExpiresAt: now.Add(4 * time.Second).UnixMilli()}
	if receipt, err := p.ApplySceneCommand(sceneBytes(t, command)); err != nil || receipt.SceneRevision != 2 {
		t.Fatal("authorized source not selected", err)
	}
	source.Close()
	awaitSource(t, source.finished)
	command.CommandID = "scn_bbbbbbbbbbbbbbbb"
	command.ExpectedSceneRevision = 2
	if _, err := p.ApplySceneCommand(sceneBytes(t, command)); err == nil {
		t.Fatal("closed source selected")
	}
}
