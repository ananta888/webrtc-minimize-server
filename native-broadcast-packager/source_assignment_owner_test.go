package main

import (
	"encoding/json"
	"errors"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/ananta/webrtc-minimize-server/native-broadcast-packager/internal/trustedsframe"
)

func sourceOwnerFixture(t *testing.T) (*client, sourceProgramAssignment, sourceProgramGenerationConfig, trustedsframe.SourceLease) {
	t.Helper()
	c, lease, now := trustedSourceFixture(t)
	local := generationTestConfig(t, lease)
	a := c.assignment
	r := sourceProgramAssignment{Version: 4, Type: "assignment-prepare", InputMode: "trusted-sframe-v1", AssignmentID: a.AssignmentID, RoomID: a.RoomID,
		ProgramID: a.ProgramID, ProgramEpoch: int64(a.ProgramEpoch), LeaseID: a.LeaseID, FencingRevision: int64(a.FencingRevision), ResourceRef: a.ResourceRef,
		Profile: local.encoder.profile, ICEServers: []assignmentICEServer{}, ExpiresAt: now.Add(time.Minute).UnixMilli(),
		SourceContext: sourceProgramAssignmentContext{Schema: "ananta.trusted-source-program-context.v1", TenantID: lease.Consent.TenantID,
			RoomEpoch: lease.Consent.RoomEpoch, GranteeDeviceRef: c.trustedSourceDeviceRef(), FrameEnvelope: "codec-prefix-v1"}}
	r.Profile.VideoEncoder, r.Profile.SoftwareFallback = "libx264", "libx264"
	c.assignment = nil
	c.cfg.outputRoot, c.cfg.ffmpegPath = local.encoder.outputRoot, local.encoder.ffmpegPath
	c.cfg.maximumRenditions, c.cfg.maximumPixelsPerSecond = 3, 1280*720*30
	c.capability.videoEncoders, c.capability.audioEncoders = []string{"libx264"}, []string{"aac"}
	t.Cleanup(c.closeAssignmentMedia)
	return c, r, local, lease
}

func sourceAssignmentBytes(t *testing.T, r sourceProgramAssignment) []byte {
	t.Helper()
	raw, err := json.Marshal(r)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func sourceOwnerTestFactory(cfg sourceProgramGenerationConfig) (*sourceProgramGeneration, error) {
	return newSourceProgramGenerationWithOutput(cfg, func(sourceProgramEncoderConfig) (sourceGenerationOutput, error) {
		o := &sourceGenerationTestOutput{ready: make(chan struct{}), finished: make(chan struct{})}
		close(o.ready)
		return o, nil
	})
}

func TestSourceAssignmentBootstrapAndRenewalScope(t *testing.T) {
	c, r, local, lease := sourceOwnerFixture(t)
	if err := c.prepareSourceProgramAssignment(sourceAssignmentBytes(t, r), time.Now(), local, sourceOwnerTestFactory); err != nil {
		t.Fatal(err)
	}
	a := c.assignment
	if a.State != "ready" || a.Media != nil || a.PublisherPeerID != "" || !a.sourceProgram.generation.Load().Ready() {
		t.Fatal("program bootstrap or readiness claim")
	}
	for _, mutate := range []func(*trustedsframe.SourceLease){
		func(l *trustedsframe.SourceLease) { l.Consent.TenantID = "tn_bbbbbbbbbbbbbbbb" },
		func(l *trustedsframe.SourceLease) { l.Consent.RoomEpoch++ },
	} {
		wrong := lease
		mutate(&wrong)
		if _, err := c.prepareTrustedSource(sourceBytes(t, wrong), time.Now()); err == nil {
			t.Fatal("source escaped assignment scope")
		}
	}
	receiver, err := c.prepareTrustedSource(sourceBytes(t, lease), time.Now())
	if err != nil {
		t.Fatal("ready v4 could not admit source", err)
	}
	source := c.trustedSources[lease.SourceLeaseID]
	if _, err = c.sourceSinkFor(source); err != nil {
		t.Fatal("source did not reach generation", err)
	}
	c.cfg.stunURLs = []string{"stun:example.invalid:3478"}
	if len(c.sourceConfiguration().ICEServers) != 0 {
		t.Fatal("explicit empty v4 ICE list inherited STUN")
	}
	msg := serverMessage{AssignmentID: a.AssignmentID, ProgramEpoch: a.ProgramEpoch, FencingRevision: a.FencingRevision, ExpiresAt: r.ExpiresAt + 1000}
	if err = c.renewAssignment(msg, time.Now()); err != nil || !receiver.AliveNow() {
		t.Fatal("renew reset source", err)
	}
	msg.ExpiresAt--
	if err = c.renewAssignment(msg, time.Now()); err == nil {
		t.Fatal("renew decreased source writer lifetime")
	}
	c.setConsentedRooms(nil)
	c.setConsentedRooms([]string{a.RoomID})
	msg.ExpiresAt += 2000
	if err = c.renewAssignment(msg, time.Now()); err == nil {
		t.Fatal("restored room revived revoked generation")
	}
	awaitSource(t, a.sourceProgram.finished)
	if receiver.AliveNow() {
		t.Fatal("revoked source retained authority")
	}
}

func TestSourceAssignmentRejectsBeforeConstruction(t *testing.T) {
	for _, change := range []func(*client, *sourceProgramAssignment, *sourceProgramGenerationConfig){
		func(c *client, r *sourceProgramAssignment, l *sourceProgramGenerationConfig) {
			c.sessionAuthenticated.Store(false)
		},
		func(c *client, r *sourceProgramAssignment, l *sourceProgramGenerationConfig) {
			c.setConsentedRooms(nil)
		},
		func(c *client, r *sourceProgramAssignment, l *sourceProgramGenerationConfig) {
			r.SourceContext.GranteeDeviceRef = "dev_bbbbbbbbbbbbbbbb"
		},
		func(c *client, r *sourceProgramAssignment, l *sourceProgramGenerationConfig) {
			r.Profile.VideoEncoder = "h264_nvenc"
		},
		func(c *client, r *sourceProgramAssignment, l *sourceProgramGenerationConfig) {
			c.cfg.maximumRenditions = 1
		},
		func(c *client, r *sourceProgramAssignment, l *sourceProgramGenerationConfig) {
			c.cfg.maximumPixelsPerSecond = 1
		},
		func(c *client, r *sourceProgramAssignment, l *sourceProgramGenerationConfig) { l.maxSources = 81 },
	} {
		c, r, local, _ := sourceOwnerFixture(t)
		change(c, &r, &local)
		called := false
		err := c.prepareSourceProgramAssignment(sourceAssignmentBytes(t, r), time.Now(), local, func(sourceProgramGenerationConfig) (*sourceProgramGeneration, error) {
			called = true
			return nil, errors.New("fixture")
		})
		if err == nil || called || c.assignment != nil {
			t.Fatal("invalid assignment constructed or consumed slot")
		}
	}
}

func TestSourceAssignmentLateConstructorStopFencesSuccessor(t *testing.T) {
	c, r, local, _ := sourceOwnerFixture(t)
	constructed, release := make(chan *sourceProgramGeneration, 1), make(chan struct{})
	var releaseOnce sync.Once
	releaseConstructor := func() { releaseOnce.Do(func() { close(release) }) }
	defer releaseConstructor()
	result := make(chan error, 1)
	go func() {
		result <- c.prepareSourceProgramAssignment(sourceAssignmentBytes(t, r), time.Now(), local, func(cfg sourceProgramGenerationConfig) (*sourceProgramGeneration, error) {
			p, err := sourceOwnerTestFactory(cfg)
			if err != nil {
				return nil, err
			}
			constructed <- p
			<-release
			return p, nil
		})
	}()
	var p *sourceProgramGeneration
	select {
	case p = <-constructed:
	case <-time.After(3 * time.Second):
		t.Fatal("constructor blocked under registry lock")
	}
	c.assignmentMu.Lock()
	old := c.assignment
	c.assignmentMu.Unlock()
	stopped := make(chan error, 1)
	go func() {
		stopped <- c.stopAssignment(serverMessage{AssignmentID: old.AssignmentID, ProgramEpoch: old.ProgramEpoch, FencingRevision: old.FencingRevision, ReasonCode: "USER_STOP"})
	}()
	awaitSource(t, old.sourceProgram.done)
	select {
	case <-stopped:
		t.Fatal("stop acknowledged before constructor reaping")
	default:
	}
	r.AssignmentID, r.ResourceRef = "asn_bbbbbbbbbbbbbbbb", "res_bbbbbbbbbbbbbbbb"
	if err := c.prepareSourceProgramAssignment(sourceAssignmentBytes(t, r), time.Now(), local, sourceOwnerTestFactory); err != nil {
		t.Fatal(err)
	}
	next := c.assignment
	releaseConstructor()
	if err := <-result; err == nil {
		t.Fatal("late constructor committed")
	}
	if err := <-stopped; err != nil {
		t.Fatal(err)
	}
	awaitSource(t, p.finished)
	if c.assignment != next || !next.sourceProgram.permitted() {
		t.Fatal("predecessor stopped successor")
	}
}

func TestSourceAssignmentConstructorAuthorityExpiryAndFailure(t *testing.T) {
	c, r, local, _ := sourceOwnerFixture(t)
	r.ExpiresAt = time.Now().Add(100 * time.Millisecond).UnixMilli()
	err := c.prepareSourceProgramAssignment(sourceAssignmentBytes(t, r), time.Now(), local, func(cfg sourceProgramGenerationConfig) (*sourceProgramGeneration, error) {
		select {
		case <-cfg.encoder.revoked:
			return nil, errors.New("revoked")
		case <-time.After(time.Second):
			t.Error("constructor expiry not fenced")
			return nil, errors.New("timeout")
		}
	})
	if err == nil || c.assignment != nil {
		t.Fatal("expired constructor retained assignment")
	}
	c, r, local, _ = sourceOwnerFixture(t)
	c.cfg.ffmpegPath = filepath.Join(t.TempDir(), "missing-ffmpeg")
	if err = c.prepareSourceProgramAssignment(sourceAssignmentBytes(t, r), time.Now(), local, nil); err == nil || c.assignment != nil {
		t.Fatal("real failed codec construction retained assignment")
	}
}

func TestSourceAssignmentStopStatusAndReplayFence(t *testing.T) {
	c, r, local, _ := sourceOwnerFixture(t)
	readyEntered, releaseReady := make(chan struct{}), make(chan struct{})
	var releaseOnce sync.Once
	unblockReady := func() { releaseOnce.Do(func() { close(releaseReady) }) }
	defer unblockReady()
	stopSent := make(chan struct{})
	c.sendOverride = func(value any) error {
		state := value.(map[string]any)["state"]
		if state == "ready" {
			close(readyEntered)
			<-releaseReady
		}
		if state == "stopped" {
			close(stopSent)
		}
		return nil
	}
	prepared := make(chan error, 1)
	go func() {
		prepared <- c.prepareSourceProgramAssignment(sourceAssignmentBytes(t, r), time.Now(), local, sourceOwnerTestFactory)
	}()
	awaitSource(t, readyEntered)
	c.assignmentMu.Lock()
	a := c.assignment
	c.assignmentMu.Unlock()
	stopped := make(chan error, 1)
	go func() {
		stopped <- c.stopAssignment(serverMessage{AssignmentID: a.AssignmentID, ProgramEpoch: a.ProgramEpoch, FencingRevision: a.FencingRevision, ReasonCode: "USER_STOP"})
	}()
	awaitSource(t, a.sourceProgram.finished)
	select {
	case <-stopSent:
		t.Fatal("stop overtook in-flight ready")
	default:
	}
	unblockReady()
	if err := <-prepared; err != nil {
		t.Fatal(err)
	}
	if err := <-stopped; err != nil {
		t.Fatal(err)
	}
	called := false
	if err := c.prepareSourceProgramAssignment(sourceAssignmentBytes(t, r), time.Now(), local, func(sourceProgramGenerationConfig) (*sourceProgramGeneration, error) {
		called = true
		return nil, errors.New("fixture")
	}); err == nil || called {
		t.Fatal("stopped assignment replay reconstructed output")
	}
}

func TestSourceAssignmentMonotonicExpiryAndRenewalReplay(t *testing.T) {
	c, r, local, _ := sourceOwnerFixture(t)
	if err := c.prepareSourceProgramAssignment(sourceAssignmentBytes(t, r), time.Now(), local, sourceOwnerTestFactory); err != nil {
		t.Fatal(err)
	}
	a := c.assignment
	msg := serverMessage{AssignmentID: a.AssignmentID, ProgramEpoch: a.ProgramEpoch, FencingRevision: a.FencingRevision, ExpiresAt: r.ExpiresAt}
	first := a.sourceProgram.deadline.Load()
	if err := c.renewAssignment(msg, time.Now()); err != nil || a.sourceProgram.deadline.Load() != first {
		t.Fatal("renew replay reset monotonic timer", err)
	}
	// Model a monotonic deadline that has elapsed while wall expiry remains in
	// the future. No system clock mutation, sleep tolerance or replay extension.
	expired := time.Now().Add(-time.Second)
	a.sourceProgram.deadline.Store(&expired)
	msg.ExpiresAt++
	if err := c.renewAssignment(msg, time.Now()); err == nil || a.sourceProgram.permitted() {
		t.Fatal("wall clock expiry revived monotonic deadline")
	}
	awaitSource(t, a.sourceProgram.finished)
}
