package main

import (
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/ananta/webrtc-minimize-server/native-broadcast-packager/internal/trustedsframe"
)

func TestSourceProgramGenerationEncoderStartFailure(t *testing.T) {
	_, lease, _ := trustedSourceFixture(t)
	cfg := generationTestConfig(t, lease)
	cfg.encoder.ffmpegPath = filepath.Join(t.TempDir(), "missing-ffmpeg")
	p, err := newSourceProgramGeneration(cfg)
	if p != nil || err == nil {
		t.Fatal("missing codec accepted")
	}
	if _, err = os.Stat(filepath.Join(cfg.encoder.outputRoot, cfg.encoder.resourceRef)); !os.IsNotExist(err) {
		t.Fatal("failed generation retained output")
	}
}

func TestSourceProgramGenerationRetainsBoundedSourceHistory(t *testing.T) {
	c, lease, now := trustedSourceFixture(t)
	cfg := generationTestConfig(t, lease)
	cfg.maxSources = 1
	p, _ := generationTestOwner(t, cfg, nil)
	r, err := c.prepareTrustedSource(sourceBytes(t, lease), now)
	if err != nil {
		t.Fatal(err)
	}
	s, err := p.AddSource(lease, r)
	if err != nil {
		t.Fatal(err)
	}
	r.Destroy()
	awaitSource(t, s.finished)
	lease.SourceLeaseID = "sls_bbbbbbbbbbbbbbbb"
	lease.Consent.ConsentID, lease.Consent.SourceID = "cns_bbbbbbbbbbbbbbbb", "src_bbbbbbbbbbbbbbbb"
	r, err = c.prepareTrustedSource(sourceBytes(t, lease), time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if _, err = p.AddSource(lease, r); err == nil {
		t.Fatal("source churn bypassed generation history bound")
	}
	if len(p.sources) != 1 || len(p.publishers) != 1 {
		t.Fatal("rejected source consumed owner capacity")
	}
}

type sourceGenerationTestOutput struct {
	ready, finished chan struct{}
	closed          atomic.Bool
	audio, video    atomic.Int64
	once            sync.Once
	release         <-chan struct{}
}

func (o *sourceGenerationTestOutput) WriteProgramAudio(_ int64, _ []byte, g sourceRenderGuard) error {
	if !g.Valid() {
		return fmt.Errorf("fixture guard")
	}
	o.audio.Add(1)
	return nil
}
func (o *sourceGenerationTestOutput) WriteProgramVideo(_ int64, _ uint64, _ []byte, g sourceRenderGuard) error {
	if !g.Valid() {
		return fmt.Errorf("fixture guard")
	}
	o.video.Add(1)
	return nil
}
func (o *sourceGenerationTestOutput) Close() {
	o.once.Do(func() {
		o.closed.Store(true)
		if o.release == nil {
			close(o.finished)
		} else {
			go func() { <-o.release; close(o.finished) }()
		}
	})
}
func (o *sourceGenerationTestOutput) ReadySignal() <-chan struct{} { return o.ready }
func (o *sourceGenerationTestOutput) Finished() <-chan struct{}    { return o.finished }

func generationTestConfig(t *testing.T, lease trustedsframe.SourceLease) sourceProgramGenerationConfig {
	t.Helper()
	return sourceProgramGenerationConfig{scope: sourceProgramScope{tenantID: lease.Consent.TenantID, deviceRef: lease.Consent.GranteeDeviceRef,
		roomID: lease.Consent.RoomID, roomEpoch: lease.Consent.RoomEpoch, programID: lease.Consent.ProgramID, programEpoch: lease.Consent.ProgramEpoch,
		assignmentID: lease.AssignmentID, writerLeaseID: lease.WriterLeaseID, fencingRevision: lease.FencingRevision},
		encoder: sourceEncoderTestConfig(t.TempDir()), now: time.Now, maxPublishers: 20, maxSources: 80, maxDecoders: 4, maxDecodeBytes: 64 * 1024 * 1024,
		maxPCMBytes: 4 * 48000 * 4, maxRGBABytes: 16 * 1024 * 1024, sourceWidth: 64, sourceHeight: 36, delaySamples: 14400}
}
func generationTestOwner(t *testing.T, cfg sourceProgramGenerationConfig, release <-chan struct{}) (*sourceProgramGeneration, *sourceGenerationTestOutput) {
	t.Helper()
	o := &sourceGenerationTestOutput{ready: make(chan struct{}), finished: make(chan struct{}), release: release}
	close(o.ready)
	p, err := newSourceProgramGenerationWithOutput(cfg, func(c sourceProgramEncoderConfig) (sourceGenerationOutput, error) {
		if !c.authorized() {
			t.Fatal("generation started without policy")
		}
		return o, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { p.Close(); awaitSource(t, p.finished) })
	return p, o
}

func TestSourceProgramGenerationRejectsBeforeOutputAllocation(t *testing.T) {
	_, l, _ := trustedSourceFixture(t)
	base := generationTestConfig(t, l)
	for _, change := range []func(*sourceProgramGenerationConfig){
		func(c *sourceProgramGenerationConfig) { c.scope.tenantID = "unknown" }, func(c *sourceProgramGenerationConfig) { c.scope.deviceRef = "unknown" },
		func(c *sourceProgramGenerationConfig) { c.scope.roomEpoch = 0 }, func(c *sourceProgramGenerationConfig) { c.scope.fencingRevision = 0 },
		func(c *sourceProgramGenerationConfig) { c.scope.assignmentID = "unknown" }, func(c *sourceProgramGenerationConfig) { c.scope.writerLeaseID = "unknown" },
		func(c *sourceProgramGenerationConfig) { c.maxPublishers = 21 }, func(c *sourceProgramGenerationConfig) { c.maxSources = 81 },
		func(c *sourceProgramGenerationConfig) { c.maxDecoders = 0 }, func(c *sourceProgramGenerationConfig) { c.maxDecodeBytes = 0 },
		func(c *sourceProgramGenerationConfig) { c.maxPCMBytes = 0 }, func(c *sourceProgramGenerationConfig) { c.maxRGBABytes = 0 },
		func(c *sourceProgramGenerationConfig) { c.sourceWidth = 1922 }, func(c *sourceProgramGenerationConfig) { c.delaySamples = 48001 },
		func(c *sourceProgramGenerationConfig) { c.now = nil }, func(c *sourceProgramGenerationConfig) { c.encoder.startSample = 1 },
		func(c *sourceProgramGenerationConfig) { c.encoder.authorized = func() bool { return false } },
	} {
		c := base
		change(&c)
		called := false
		p, err := newSourceProgramGenerationWithOutput(c, func(sourceProgramEncoderConfig) (sourceGenerationOutput, error) { called = true; return nil, nil })
		if p != nil || err == nil || called {
			t.Fatal("invalid owner allocated output")
		}
	}
}

func TestSourceProgramGenerationClosesOnlyAfterOutputReaped(t *testing.T) {
	_, l, _ := trustedSourceFixture(t)
	release := make(chan struct{})
	p, o := generationTestOwner(t, generationTestConfig(t, l), release)
	if !p.Ready() {
		t.Fatal("output not ready")
	}
	p.Close()
	p.Close()
	if p.Ready() || !o.closed.Load() {
		t.Fatal("close did not fence output")
	}
	select {
	case <-p.finished:
		t.Fatal("owner released before process wait")
	default:
	}
	close(release)
	awaitSource(t, p.finished)
	if !p.budget.closed || p.budget.processes != 0 || p.budget.bytes != 0 || len(p.sources) != 0 || len(p.publishers) != 0 {
		t.Fatal("generation retained resources")
	}
	if _, err := p.SetScene(1, "waiting-slate", nil, ""); err == nil {
		t.Fatal("closed generation accepted scene")
	}
}

func TestSourceProgramGenerationBindsReceiverAndParentBeforeSource(t *testing.T) {
	c, l, now := trustedSourceFixture(t)
	r, err := c.prepareTrustedSource(sourceBytes(t, l), now)
	if err != nil {
		t.Fatal(err)
	}
	p, _ := generationTestOwner(t, generationTestConfig(t, l), nil)
	for _, change := range []func(*trustedsframe.SourceLease){
		func(l *trustedsframe.SourceLease) { l.Consent.TenantID = "tn_bbbbbbbbbbbbbbbb" },
		func(l *trustedsframe.SourceLease) { l.Consent.RoomEpoch++ }, func(l *trustedsframe.SourceLease) { l.Consent.ProgramEpoch++ },
		func(l *trustedsframe.SourceLease) { l.FencingRevision++ }, func(l *trustedsframe.SourceLease) { l.WriterLeaseID = "lea_bbbbbbbbbbbbbbbb" },
		func(l *trustedsframe.SourceLease) { l.SourceLeaseID = "sls_bbbbbbbbbbbbbbbb" }, func(l *trustedsframe.SourceLease) { l.PublicationEpoch++ },
		func(l *trustedsframe.SourceLease) { l.PublicationID = "other-source" }, func(l *trustedsframe.SourceLease) { l.PublisherPeerID = "bbbbbbbbbbbbbbbb" },
		func(l *trustedsframe.SourceLease) { l.PublisherDeviceRef = "dev_bbbbbbbbbbbbbbbb" },
	} {
		bad := l
		change(&bad)
		if s, err := p.AddSource(bad, r); s != nil || err == nil {
			t.Fatal("foreign source bound to allowed receiver")
		}
	}
	if len(p.sources) != 0 || len(p.publishers) != 0 {
		t.Fatal("denied source consumed slots")
	}
	s, err := p.AddSource(l, r)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = p.AddSource(l, r); err == nil {
		t.Fatal("duplicate source accepted")
	}
	if _, err = p.SetScene(1, "single", []string{l.SourceLeaseID}, ""); err != nil {
		t.Fatal(err)
	}
	if err = p.SetGain(l.SourceLeaseID, 32768, 32768); err == nil {
		t.Fatal("video accepted audio controls")
	}
	if _, err = p.SetScene(2, "single", []string{"foreign"}, ""); err == nil {
		t.Fatal("foreign scene source accepted")
	}
	s.Close()
	awaitSource(t, s.finished)
	if _, err = p.SetScene(2, "single", []string{l.SourceLeaseID}, ""); err == nil {
		t.Fatal("closed source reused")
	}
}

func TestSourceProgramGenerationSharesOnlyExactPublisherClock(t *testing.T) {
	c, base, now := trustedSourceFixture(t)
	cfg := generationTestConfig(t, base)
	cfg.maxPublishers = 2
	cfg.maxSources = 4
	p, _ := generationTestOwner(t, cfg, nil)
	var sources [3]*sourceGenerationSource
	for i := 0; i < 3; i++ {
		l := base
		suffix := fmt.Sprintf("%016x", i+1)
		l.SourceLeaseID = "sls_" + suffix
		l.Consent.ConsentID = "cns_" + suffix
		l.Consent.SourceID = "src_" + suffix
		l.PublicationID = "track-" + suffix
		if i == 1 {
			l.Codec = "audio/opus"
			l.Consent.SourceKind = "microphone"
		}
		if i == 2 {
			l.PublisherDeviceRef = "dev_bbbbbbbbbbbbbbbb"
		}
		r, err := c.prepareTrustedSource(sourceBytes(t, l), now)
		if err != nil {
			t.Fatal(err)
		}
		sources[i], err = p.AddSource(l, r)
		if err != nil {
			t.Fatal(err)
		}
		if i == 1 {
			if err := p.SetGain(l.SourceLeaseID, 16384, 0); err != nil {
				t.Fatal(err)
			}
		}
	}
	if sources[0].publisher != sources[1].publisher || sources[0].publisher == sources[2].publisher {
		t.Fatal("publisher clocks incorrectly grouped")
	}
	if p.budget.processes != 0 {
		t.Fatal("decoder spawned without media/report readiness")
	}
	other := base
	other.SourceLeaseID = "sls_dddddddddddddddd"
	other.Consent.ConsentID = "cns_dddddddddddddddd"
	other.Consent.SourceID = "src_dddddddddddddddd"
	other.PublisherPeerID = "dddddddddddddddd"
	r, err := c.prepareTrustedSource(sourceBytes(t, other), now)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = p.AddSource(other, r); err == nil {
		t.Fatal("publisher quota bypass")
	}
	p.Close()
	awaitSource(t, p.finished)
}

func TestSourceProgramGenerationPolicyLossAndConcurrentControls(t *testing.T) {
	_, l, _ := trustedSourceFixture(t)
	cfg := generationTestConfig(t, l)
	var allowed atomic.Bool
	allowed.Store(true)
	cfg.encoder.authorized = allowed.Load
	p, _ := generationTestOwner(t, cfg, nil)
	var wg sync.WaitGroup
	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := 0; j < 50; j++ {
				p.Ready()
				p.SetScene(1, "waiting-slate", nil, "")
				p.SetGain("missing", 0, 0)
			}
		}()
	}
	allowed.Store(false)
	wg.Wait()
	awaitSource(t, p.finished)
	if p.Ready() {
		t.Fatal("revoked owner revived")
	}
}
