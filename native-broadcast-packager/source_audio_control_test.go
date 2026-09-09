package main

import (
	"encoding/json"
	"fmt"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func audioControlFixture(t *testing.T) (*sourceProgramGeneration, sourceAudioCommand, *atomic.Int64, *atomic.Bool, *atomic.Bool) {
	t.Helper()
	var c sourceAudioCommand
	if json.Unmarshal(audioControlFixtureBytes(t, "source-audio"), &c) != nil {
		t.Fatal("fixture")
	}
	clock := &atomic.Int64{}
	clock.Store(c.IssuedAt)
	owner, source := &atomic.Bool{}, &atomic.Bool{}
	owner.Store(true)
	source.Store(true)
	m := audioMixFixture(t, 960, 2)
	input, err := m.Add(sourceAudioMixInputConfig{left: 32768, right: 32768, authorized: source.Load,
		mapTimestamp: func(ts uint32) (int64, bool) { return int64(ts), true }})
	if err != nil {
		t.Fatal(err)
	}
	p := &sourceProgramGeneration{audio: m, sources: map[string]*sourceGenerationSource{c.Sources[0].SourceLeaseID: {sourceLazyDecoder: &sourceLazyDecoder{}, audio: input, kind: "microphone", allowed: source.Load}},
		cfg: sourceProgramGenerationConfig{now: func() time.Time { return time.UnixMilli(clock.Load()) },
			scope:   sourceProgramScope{assignmentID: c.AssignmentID, programID: c.ProgramID, programEpoch: c.ProgramEpoch, writerLeaseID: c.LeaseID, fencingRevision: c.FencingRevision},
			encoder: sourceProgramEncoderConfig{authorized: owner.Load, revoked: make(chan struct{})}}}
	return p, c, clock, owner, source
}

func audioQueryBytes(t *testing.T, c sourceAudioCommand) []byte {
	q := c.sourceAudioQuery
	q.Type = "source-program-audio-query"
	return audioControlBytes(t, q)
}

func TestSourceAudioControlSharedReceiptSnapshotAndReplay(t *testing.T) {
	p, c, _, owner, source := audioControlFixture(t)
	r, err := p.ApplyAudioCommand(audioControlBytes(t, c))
	if err != nil {
		t.Fatal(err)
	}
	var expected sourceAudioReceipt
	_ = json.Unmarshal(audioControlFixtureBytes(t, "source-audio-applied"), &expected)
	if r != expected {
		t.Fatal("shared receipt mismatch")
	}
	reply, err := p.QueryAudio(audioQueryBytes(t, c))
	if err != nil {
		t.Fatal(err)
	}
	var expectedState sourceAudioReply
	_ = json.Unmarshal(audioControlFixtureBytes(t, "source-audio-state"), &expectedState)
	if string(audioControlBytes(t, reply)) != string(audioControlBytes(t, expectedState)) {
		t.Fatal("shared state mismatch")
	}
	again, err := p.ApplyAudioCommand(audioControlBytes(t, c))
	if err != nil || again != r || p.audio.revision != r.AudioRevision {
		t.Fatal("replay mutated audio")
	}
	bad := c
	bad.Sources = append([]sourceProgramAudioLevel{}, c.Sources...)
	bad.Sources[0].Muted = false
	if _, err := p.ApplyAudioCommand(audioControlBytes(t, bad)); err == nil {
		t.Fatal("changed replay accepted")
	}
	bad = c
	bad.CommandID = "aud_bbbbbbbbbbbbbbbb"
	if _, err := p.ApplyAudioCommand(audioControlBytes(t, bad)); err == nil {
		t.Fatal("stale CAS accepted")
	}
	source.Store(false)
	if again, err := p.ApplyAudioCommand(audioControlBytes(t, c)); err != nil || again != r {
		t.Fatal("historical receipt unavailable")
	}
	state, err := p.QueryAudio(audioQueryBytes(t, c))
	if err != nil || len(state.Sources) != 0 {
		t.Fatal("receipt renewed source authority")
	}
	owner.Store(false)
	if _, err := p.ApplyAudioCommand(audioControlBytes(t, c)); err == nil {
		t.Fatal("revoked writer returned receipt")
	}
	if _, err := p.QueryAudio(audioQueryBytes(t, c)); err == nil {
		t.Fatal("revoked writer returned state")
	}
}

func TestSourceAudioControlScopeClockAndDeadline(t *testing.T) {
	for _, change := range []func(*sourceAudioCommand){
		func(c *sourceAudioCommand) { c.AssignmentID = "asn_bbbbbbbbbbbbbbbb" }, func(c *sourceAudioCommand) { c.ProgramID = "prg_bbbbbbbbbbbbbbbb" },
		func(c *sourceAudioCommand) { c.ProgramEpoch++ }, func(c *sourceAudioCommand) { c.LeaseID = "lea_bbbbbbbbbbbbbbbb" }, func(c *sourceAudioCommand) { c.FencingRevision++ },
	} {
		p, c, _, _, _ := audioControlFixture(t)
		change(&c)
		if _, err := p.ApplyAudioCommand(audioControlBytes(t, c)); err == nil || p.audio.revision != 2 {
			t.Fatal("foreign writer mutated audio")
		}
		if _, err := p.QueryAudio(audioQueryBytes(t, c)); err == nil {
			t.Fatal("foreign writer queried audio")
		}
	}
	for _, query := range []bool{false, true} {
		p, c, clock, _, _ := audioControlFixture(t)
		p.cfg.now = func() time.Time { return time.UnixMilli(clock.Add(4000) - 4000) }
		if query {
			if _, err := p.QueryAudio(audioQueryBytes(t, c)); err == nil {
				t.Fatal("query outlived deadline")
			}
		} else {
			if _, err := p.ApplyAudioCommand(audioControlBytes(t, c)); err == nil || p.audio.revision != 2 {
				t.Fatal("apply outlived deadline")
			}
		}
	}
	p, c, clock, _, _ := audioControlFixture(t)
	if _, err := p.QueryAudio(audioQueryBytes(t, c)); err != nil {
		t.Fatal(err)
	}
	clock.Add(-1)
	if _, err := p.QueryAudio(audioQueryBytes(t, c)); err == nil {
		t.Fatal("rollback query")
	}
	if _, err := p.ApplyAudioCommand(audioControlBytes(t, c)); err == nil || p.audio.revision != 2 {
		t.Fatal("rollback mutation")
	}
}

func TestSourceAudioControlHistoryBoundAndConcurrentCAS(t *testing.T) {
	p, c, clock, _, _ := audioControlFixture(t)
	for i := 0; i < maximumSourceAudioControlHistory; i++ {
		c.CommandID = fmt.Sprintf("aud_%016x", i)
		c.ExpectedAudioRevision = uint64(i + 2)
		if _, err := p.ApplyAudioCommand(audioControlBytes(t, c)); err != nil {
			t.Fatal(err)
		}
	}
	c.CommandID = "aud_zzzzzzzzzzzzzzzz"
	c.ExpectedAudioRevision++
	if _, err := p.ApplyAudioCommand(audioControlBytes(t, c)); err == nil {
		t.Fatal("unbounded receipt history")
	}
	clock.Add(4000)
	if _, err := p.ApplyAudioCommand(audioControlBytes(t, c)); err == nil {
		t.Fatal("expired command")
	}
	c.IssuedAt = clock.Load()
	c.ExpiresAt = c.IssuedAt + 4000
	if _, err := p.ApplyAudioCommand(audioControlBytes(t, c)); err != nil || len(p.audioControl.history) != 1 {
		t.Fatal("expired history not reclaimed", err)
	}
	p, c, _, _, _ = audioControlFixture(t)
	var wg sync.WaitGroup
	var successes atomic.Int64
	for i := 0; i < 16; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			v := c
			v.CommandID = fmt.Sprintf("aud_%016x", i)
			if _, err := p.ApplyAudioCommand(audioControlBytes(t, v)); err == nil {
				successes.Add(1)
			}
		}(i)
	}
	wg.Wait()
	if successes.Load() != 1 || p.audio.revision != 3 {
		t.Fatal("concurrent CAS bypassed")
	}
}

func TestSourceAudioControlWaitsForMixerWithoutExtendingDeadline(t *testing.T) {
	p, c, clock, _, _ := audioControlFixture(t)
	entered := make(chan struct{})
	var once sync.Once
	p.cfg.now = func() time.Time { at := clock.Load(); once.Do(func() { close(entered) }); return time.UnixMilli(at) }
	p.audio.mu.Lock()
	result := make(chan error, 1)
	raw := audioControlBytes(t, c)
	go func() { _, err := p.ApplyAudioCommand(raw); result <- err }()
	<-entered
	clock.Store(c.ExpiresAt)
	p.audio.mu.Unlock()
	select {
	case err := <-result:
		if err == nil || p.audio.revision != 2 {
			t.Fatal("waiting command extended authority")
		}
	case <-time.After(time.Second):
		t.Fatal("command did not leave render lock")
	}
}

func TestSourceAudioControlCanonicalBatchAndClosedSources(t *testing.T) {
	p, c, _, _, _ := audioControlFixture(t)
	id := "sls_bbbbbbbbbbbbbbbb"
	input := audioMixInputFixture(t, p.audio)
	p.sources[id] = &sourceGenerationSource{sourceLazyDecoder: &sourceLazyDecoder{}, audio: input, kind: "screen-audio", allowed: func() bool { return true }}
	c.ExpectedAudioRevision = 3
	c.Sources = append(c.Sources, sourceProgramAudioLevel{id, 0, 0, false})
	r, err := p.ApplyAudioCommand(audioControlBytes(t, c))
	if err != nil {
		t.Fatal(err)
	}
	c.Sources[0], c.Sources[1] = c.Sources[1], c.Sources[0]
	if again, err := p.ApplyAudioCommand(audioControlBytes(t, c)); err != nil || again != r {
		t.Fatal("equivalent batch replay changed receipt")
	}
	c.CommandID = "aud_bbbbbbbbbbbbbbbb"
	c.ExpectedAudioRevision = r.AudioRevision
	p.sources[id].closed.Store(true)
	if _, err := p.ApplyAudioCommand(audioControlBytes(t, c)); err == nil || p.audio.revision != r.AudioRevision {
		t.Fatal("closed source caused partial mutation")
	}
	p.closed.Store(true)
	if _, err := p.QueryAudio(audioQueryBytes(t, c)); err == nil {
		t.Fatal("closed program query")
	}
}

func TestSourceAudioControlUsesActualAuthorizedReceiver(t *testing.T) {
	client, lease, now := trustedSourceFixture(t)
	lease.Codec, lease.Consent.SourceKind = "audio/opus", "microphone"
	p, _ := generationTestOwner(t, generationTestConfig(t, lease), nil)
	receiver, err := client.prepareTrustedSource(sourceBytes(t, lease), now)
	if err != nil {
		t.Fatal(err)
	}
	source, err := p.AddSource(lease, receiver)
	if err != nil {
		t.Fatal(err)
	}
	state, err := p.AudioLevels()
	if err != nil {
		t.Fatal(err)
	}
	issuedAt := p.cfg.now().UnixMilli()
	command := sourceAudioCommand{sourceAudioQuery: sourceAudioQuery{sourceAudioControlScope: sourceAudioControlScope{
		Version: 1, Type: "source-program-audio", CommandID: "aud_aaaaaaaaaaaaaaaa", AssignmentID: lease.AssignmentID,
		ProgramID: lease.Consent.ProgramID, ProgramEpoch: lease.Consent.ProgramEpoch, LeaseID: lease.WriterLeaseID, FencingRevision: lease.FencingRevision},
		IssuedAt: issuedAt, ExpiresAt: issuedAt + 4000}, ExpectedAudioRevision: state.Revision,
		Sources: []sourceProgramAudioLevel{{lease.SourceLeaseID, 16384, 8192, true}}}
	receipt, err := p.ApplyAudioCommand(audioControlBytes(t, command))
	if err != nil || receipt.AudioRevision != state.Revision+1 {
		t.Fatal("actual receiver control failed", err)
	}
	reply, err := p.QueryAudio(audioQueryBytes(t, command))
	if err != nil || len(reply.Sources) != 1 || !reply.Sources[0].Muted || reply.Sources[0].Left != 16384 {
		t.Fatal("actual receiver state wrong", err)
	}
	if p.budget.processes != 0 {
		t.Fatal("control started decoder")
	}
	source.Close()
	awaitSource(t, source.finished)
	command.CommandID = "aud_bbbbbbbbbbbbbbbb"
	command.ExpectedAudioRevision = receipt.AudioRevision
	if _, err := p.ApplyAudioCommand(audioControlBytes(t, command)); err == nil {
		t.Fatal("closed receiver revived")
	}
}
