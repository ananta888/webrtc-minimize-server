package main

import (
	"testing"
	"time"
)

func TestSourceVideoClockQuarantineKeepsInputRecoverable(t *testing.T) {
	g, now := clockFixture(t)
	c := mediaClockFixture(t, g, 7, 90000)
	start := *now
	report := func(second int, skew uint32) {
		*now = start.Add(time.Duration(second) * time.Second)
		if err := c.SourceSenderReport(sourceSenderReport{7, uint64(1000+second) << 32, 50000 + uint32(second)*90000 + skew}); err != nil {
			t.Fatal(err)
		}
	}
	report(0, 0)
	report(1, 0)
	m := videoMixFixture(t, 1)
	s := videoMixInputFixture(t, m, "screen")
	s.cfg.mapTimestamp, s.cfg.timeline = nil, c
	setVideoMixScene(t, m, "single", []*sourceVideoMixInput{s}, s)
	renderVideoMix(t, m, 48000, func([]byte) {})
	pixels := solidVideoMix(64, 36, 255, 0, 0)
	if err := s.WriteRGBA(64, 36, 140000, pixels); err != nil {
		t.Fatal(err)
	}
	var oldGuard sourceRenderGuard
	if err := m.RenderGuarded(62400, func(_ int64, _ uint64, p []byte, guard sourceRenderGuard) error {
		if videoMixColor(p, 64, 32, 18)[0] != 255 {
			t.Fatal("initial frame absent")
		}
		oldGuard = guard
		return nil
	}); err != nil || !oldGuard.Valid() {
		t.Fatal("initial render failed", err)
	}
	retained := s.frames[s.current].pixels
	allocated := m.usedBytes
	report(2, 2000)
	if !c.uncertain || c.closed {
		t.Fatal("test did not enter temporary clock quarantine")
	}
	if err := s.WriteRGBA(64, 36, 230000, pixels); err != nil || s.closed {
		t.Fatal("temporary clock quarantine irreversibly closed active video input", err)
	}
	if oldGuard.Valid() || s.current >= 0 || len(s.pending) != 0 {
		t.Fatal("quarantined pixels retained")
	}
	for _, b := range retained {
		if b != 0 {
			t.Fatal("old frame not wiped")
		}
	}
	slate := func(p []byte) {
		if videoMixColor(p, 64, 32, 18) != [4]byte{9, 19, 31, 255} {
			t.Fatal("expected slate")
		}
	}
	renderVideoMix(t, m, 110400, slate)
	report(3, 0)
	if err := s.WriteRGBA(64, 36, 320000, pixels); err != nil || s.current >= 0 {
		t.Fatal("first recovery report restored output", err)
	}
	renderVideoMix(t, m, 158400, slate)
	report(4, 0)
	if at, ok := c.Map(410000); !ok || at != 206400 {
		t.Fatal("recovery re-anchored source time")
	}
	if oldGuard.Valid() {
		t.Fatal("recovery resurrected borrowed old output")
	}
	renderVideoMix(t, m, 192000, slate)
	if err := s.WriteRGBA(64, 36, 410000, solidVideoMix(64, 36, 0, 255, 0)); err != nil {
		t.Fatal(err)
	}
	renderVideoMix(t, m, 206400, func(p []byte) {
		if videoMixColor(p, 64, 32, 18)[1] != 255 {
			t.Fatal("recovered frame absent")
		}
	})
	if s.closed || m.usedBytes != allocated {
		t.Fatal("recovery replaced input or grew frame pool")
	}
}

func TestSourceVideoClockQuarantineNeverWeakensTerminalChecks(t *testing.T) {
	for _, mode := range []string{"expired", "revoked", "owner-closed", "bad-timestamp", "bad-timestamp-suspended", "backward-frame"} {
		t.Run(mode, func(t *testing.T) {
			g, now := clockFixture(t)
			c := mediaClockFixture(t, g, 7, 90000)
			start := *now
			for second := 0; second < 2; second++ {
				*now = start.Add(time.Duration(second) * time.Second)
				if err := c.SourceSenderReport(sourceSenderReport{7, uint64(1000+second) << 32, 50000 + uint32(second)*90000}); err != nil {
					t.Fatal(err)
				}
			}
			m := videoMixFixture(t, 1)
			s := videoMixInputFixture(t, m, "camera")
			s.cfg.mapTimestamp, s.cfg.timeline = nil, c
			renderVideoMix(t, m, 48000, func([]byte) {})
			pixels := solidVideoMix(64, 36, 255, 0, 0)
			if err := s.WriteRGBA(64, 36, 140000, pixels); err != nil {
				t.Fatal(err)
			}
			ts := uint32(149000)
			switch mode {
			case "expired":
				*now = start.Add(13 * time.Second)
			case "revoked":
				s.cfg.authorized = func() bool { return false }
			case "owner-closed":
				g.Close()
			case "bad-timestamp", "bad-timestamp-suspended":
				ts = 140000 + 13*90000
				if mode == "bad-timestamp-suspended" {
					*now = start.Add(2 * time.Second)
					if err := c.SourceSenderReport(sourceSenderReport{7, 1002 << 32, 232000}); err != nil {
						t.Fatal(err)
					}
				}
			case "backward-frame":
				ts = 139999
			}
			if err := s.WriteRGBA(64, 36, ts, pixels); err == nil || !s.closed || s.cfg.timeline != nil {
				t.Fatal("terminal clock/policy error retained input")
			}
			if m.usedBytes != len(m.output) {
				t.Fatal("terminal input kept its frame allocation")
			}
		})
	}
}

func TestSourceVideoClockRecoveryBetweenRendersDiscardsOldQueue(t *testing.T) {
	g, now := clockFixture(t)
	c := mediaClockFixture(t, g, 7, 90000)
	start := *now
	m := videoMixFixture(t, 1)
	s := videoMixInputFixture(t, m, "screen")
	s.cfg.mapTimestamp, s.cfg.timeline = nil, c
	setVideoMixScene(t, m, "single", []*sourceVideoMixInput{s}, s)
	for second := 0; second <= 4; second++ {
		*now = start.Add(time.Duration(second) * time.Second)
		skew := uint32(0)
		if second == 2 {
			skew = 2000
		}
		if err := c.SourceSenderReport(sourceSenderReport{7, uint64(1000+second) << 32, 50000 + uint32(second)*90000 + skew}); err != nil {
			t.Fatal(err)
		}
		if second == 1 {
			renderVideoMix(t, m, 48000, func([]byte) {})
			if err := s.WriteRGBA(64, 36, 140000, solidVideoMix(64, 36, 255, 0, 0)); err != nil {
				t.Fatal(err)
			}
		}
	}
	// Deliberately render the old deadline: epoch fencing, not stale-frame age,
	// must remove this queued frame even though no callback saw suspension.
	renderVideoMix(t, m, 62400, func(p []byte) {
		if videoMixColor(p, 64, 32, 18) != [4]byte{9, 19, 31, 255} {
			t.Fatal("old queue resurrected after unseen quarantine")
		}
	})
	if s.closed || s.current >= 0 || len(s.pending) != 0 {
		t.Fatal("recovery did not discard queue without closing input")
	}
}

func TestSourceVideoTimelineWaitsForBindingAndTwoReports(t *testing.T) {
	g, now := clockFixture(t)
	c, err := g.NewSource()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(c.Close)
	m := videoMixFixture(t, 1)
	s, err := m.Add(sourceVideoMixInputConfig{width: 64, height: 36, kind: "screen", fit: "contain", maxFrameAgeSamples: 24000,
		timeline: c, authorized: func() bool { return true }})
	if err != nil {
		t.Fatal(err)
	}
	renderVideoMix(t, m, 0, func([]byte) {})
	if s.closed || c.VideoTime().state != sourceVideoTimeWaiting {
		t.Fatal("render before ontrack closed waiting source")
	}
	if err := c.BindSourceClock(7, 90000); err != nil {
		t.Fatal(err)
	}
	if err := c.SourceSenderReport(sourceSenderReport{7, 1000 << 32, 50000}); err != nil {
		t.Fatal(err)
	}
	if c.VideoTime().state != sourceVideoTimeWaiting {
		t.Fatal("one report activated clock")
	}
	if err := s.WriteRGBA(64, 36, 50000, solidVideoMix(64, 36, 255, 0, 0)); err != nil || len(s.pending) != 0 {
		t.Fatal("waiting clock did not drop frame")
	}
	*now = now.Add(time.Second)
	if err := c.SourceSenderReport(sourceSenderReport{7, 1001 << 32, 140000}); err != nil {
		t.Fatal(err)
	}
	renderVideoMix(t, m, 48000, func([]byte) {})
	if err := s.WriteRGBA(64, 36, 140000, solidVideoMix(64, 36, 255, 0, 0)); err != nil || len(s.pending) != 1 {
		t.Fatal("bound clock failed to activate")
	}
}
