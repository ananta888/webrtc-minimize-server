package main

import (
	"sync"
	"testing"
	"time"

	"github.com/pion/rtcp"
)

func clockFixture(t *testing.T) (*sourcePublisherClock, *time.Time) {
	t.Helper()
	now := time.Unix(1700000000, 0)
	group, err := newSourcePublisherClock(now, func() time.Time { return now }, 14400)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(group.Close)
	return group, &now
}

func mediaClockFixture(t *testing.T, group *sourcePublisherClock, ssrc, rate uint32) *sourceMediaClock {
	t.Helper()
	c, err := group.NewSource()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(c.Close)
	if err := c.BindSourceClock(ssrc, rate); err != nil {
		t.Fatal(err)
	}
	return c
}

func TestSourceClockCrossMediaAndWrap(t *testing.T) {
	g, now := clockFixture(t)
	a, v := mediaClockFixture(t, g, 1, 48000), mediaClockFixture(t, g, 2, 90000)
	antp := uint64(0xffffffff) << 32 // Intentionally cross the 2036 NTP era boundary.
	aRTP, vRTP := uint32(0xffff0000), uint32(0xffff8000)
	if err := a.SourceSenderReport(sourceSenderReport{1, antp, aRTP}); err != nil {
		t.Fatal(err)
	}
	if err := v.SourceSenderReport(sourceSenderReport{2, antp, vRTP}); err != nil {
		t.Fatal(err)
	}
	if _, ok := a.Map(aRTP); ok {
		t.Fatal("single report claims stable clock")
	}
	*now = now.Add(time.Second)
	for _, input := range []struct {
		clock  *sourceMediaClock
		report sourceSenderReport
	}{
		{a, sourceSenderReport{1, antp + (1 << 32), aRTP + 48000}},
		{v, sourceSenderReport{2, antp + (1 << 32), vRTP + 90000}},
	} {
		// Exact NTP zero is permitted by RFC but intentionally unavailable for
		// this profile. Add the same nonzero fraction to the boundary report.
		input.report.ntp += 1 << 31
		input.report.rtp += input.clock.rate / 2
		*now = time.Unix(1700000001, 500000000)
		if err := input.clock.SourceSenderReport(input.report); err != nil {
			t.Fatal(err)
		}
	}
	for step := uint32(0); step < 40; step++ {
		audio, okA := a.Map(aRTP + step*480)
		video, okV := v.Map(vRTP + step*900)
		if !okA || !okV || audio != video || audio != 14400+int64(step)*480 {
			t.Fatal("cross-codec program time mismatch")
		}
	}
	before, _ := a.Map(aRTP + 10000)
	*now = now.Add(time.Second)
	if err := a.SourceSenderReport(sourceSenderReport{1, antp + (2 << 32) + (1 << 31), aRTP + 120000}); err != nil {
		t.Fatal(err)
	}
	after, ok := a.Map(aRTP + 10000)
	if !ok || before != after {
		t.Fatal("renewed report moved PCM time")
	}
}

func TestSourceClockInvalidReportsAndLifecycle(t *testing.T) {
	for _, mode := range []string{"unbound", "scope", "zero", "conflict", "rate", "domain", "rollback", "timeout", "publisher-close", "rebind"} {
		t.Run(mode, func(t *testing.T) {
			g, now := clockFixture(t)
			c := mediaClockFixture(t, g, 7, 48000)
			first := sourceSenderReport{7, 1000 << 32, 50000}
			if err := c.SourceSenderReport(first); err != nil {
				t.Fatal(err)
			}
			*now = now.Add(time.Second)
			second := sourceSenderReport{7, 1001 << 32, 98000}
			switch mode {
			case "unbound":
				c.bound = false
			case "scope":
				second.ssrc++
			case "zero":
				second.ntp = 0
			case "conflict":
				second.ntp = first.ntp
			case "rate":
				second.rtp += 10000
			case "domain":
				second.ntp += 100 << 32
			case "rollback":
				*now = now.Add(-2 * time.Second)
			case "timeout":
				*now = now.Add(12 * time.Second)
			case "publisher-close":
				g.Close()
			case "rebind":
				_ = c.BindSourceClock(8, 48000)
			}
			if err := c.SourceSenderReport(second); err == nil || !c.closed {
				t.Fatal("invalid clock survived")
			}
			expected := map[string]uint8{"unbound": 4, "scope": 4, "zero": 4, "conflict": 5, "rate": 5,
				"domain": 5, "rollback": 2, "timeout": 3, "publisher-close": 2, "rebind": 1}[mode]
			if _, ok := c.Map(98000); ok {
				t.Fatal("closed clock mapped media")
			}
			c.Close()
			if g.sources != 0 || c.first.ntp != 0 || c.last.ntp != 0 || c.failure != expected {
				t.Fatal("clock references not released")
			}
		})
	}
}

func TestSourceClockReplayDoesNotExtendFreshness(t *testing.T) {
	g, now := clockFixture(t)
	c := mediaClockFixture(t, g, 7, 90000)
	first := sourceSenderReport{7, 1000 << 32, 50000}
	if err := c.SourceSenderReport(first); err != nil {
		t.Fatal(err)
	}
	*now = now.Add(time.Second)
	second := sourceSenderReport{7, 1001 << 32, 140000}
	if err := c.SourceSenderReport(second); err != nil {
		t.Fatal(err)
	}
	*now = now.Add(11 * time.Second)
	for _, report := range []sourceSenderReport{first, second} {
		if err := c.SourceSenderReport(report); err != nil || c.reports != 2 {
			t.Fatal("duplicate report altered clock")
		}
	}
	*now = now.Add(time.Second)
	if err := c.SourceClockTick(); err == nil || !c.closed {
		t.Fatal("report replay extended freshness")
	}
}

func TestSourceClockAdmissionAndConcurrentClose(t *testing.T) {
	g, _ := clockFixture(t)
	var clocks []*sourceMediaClock
	for i := 0; i < 4; i++ {
		clocks = append(clocks, mediaClockFixture(t, g, uint32(i), 48000))
	}
	if c, err := g.NewSource(); c != nil || err == nil {
		t.Fatal("unbounded publisher clocks")
	}
	var workers sync.WaitGroup
	for _, c := range clocks {
		workers.Add(1)
		go func() { defer workers.Done(); _ = c.SourceClockTick(); c.Close(); c.Close() }()
	}
	workers.Wait()
	if g.sources != 0 {
		t.Fatal("clock slots retained")
	}
	mediaClockFixture(t, g, 9, 90000)
}

func TestSourceRTCPBoundedDispatch(t *testing.T) {
	g, now := clockFixture(t)
	c := mediaClockFixture(t, g, 7, 48000)
	encode := func(packet rtcp.Packet) []byte {
		t.Helper()
		raw, err := packet.Marshal()
		if err != nil {
			t.Fatal(err)
		}
		return raw
	}
	for i := uint64(0); i < 2; i++ {
		raw := encode(&rtcp.SenderReport{SSRC: 7, NTPTime: (1000 + i) << 32, RTPTime: 50000 + uint32(i)*48000})
		if ended, err := dispatchSourceRTCP(raw, 7, c); ended || err != nil {
			t.Fatal("valid SR not delivered")
		}
		*now = now.Add(time.Second)
	}
	if _, ok := c.Map(98000); !ok {
		t.Fatal("RTCP did not establish clock")
	}
	if _, err := dispatchSourceRTCP(encode(&rtcp.SenderReport{SSRC: 8, NTPTime: 1002 << 32, RTPTime: 146000}), 7, c); err == nil || c.reports != 2 {
		t.Fatal("foreign SSRC updated clock")
	}
	for _, raw := range [][]byte{nil, {0}, make([]byte, sourceRTCPBytes+1), bytesForManyReports(t)} {
		if _, err := dispatchSourceRTCP(raw, 7, c); err == nil {
			t.Fatal("invalid RTCP budget accepted")
		}
	}
	for _, id := range []uint32{7, 8} {
		ended, err := dispatchSourceRTCP(encode(&rtcp.Goodbye{Sources: []uint32{id}}), 7, c)
		if err != nil || ended != (id == 7) {
			t.Fatal("BYE scope differs")
		}
	}
	var budget sourceRTCPBudget
	for i := 0; i < 64; i++ {
		if !budget.accept(*now, 100) {
			t.Fatal("bounded reports denied")
		}
	}
	if budget.accept(*now, 1) || budget.accept(now.Add(-time.Second), 1) {
		t.Fatal("rate or clock rollback accepted")
	}
	if !budget.accept(now.Add(time.Second), sourceRTCPBytes) {
		t.Fatal("rate window did not reset")
	}
}

func bytesForManyReports(t *testing.T) []byte {
	t.Helper()
	packets := make([]rtcp.Packet, 17)
	for i := range packets {
		packets[i] = &rtcp.ReceiverReport{SSRC: 7}
	}
	raw, err := rtcp.Marshal(packets)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func TestSourceClockMultipleDayWraps(t *testing.T) {
	for _, rate := range []uint32{48000, 90000} {
		g, now := clockFixture(t)
		c := mediaClockFixture(t, g, 7, rate)
		start := *now
		firstRTP := uint32(0xffff0000)
		firstNTP := uint64(0xffff0000) << 32
		// Three simulated days cover multiple RTP wraps and NTP era rollover.
		// Every report stays within the real bounded freshness window.
		for second := int64(0); second <= 3*24*3600; second += 5 {
			*now = start.Add(time.Duration(second) * time.Second)
			rtp := firstRTP + uint32(second*int64(rate))
			if err := c.SourceSenderReport(sourceSenderReport{7, firstNTP + uint64(second)<<32, rtp}); err != nil {
				t.Fatalf("rate %d, second %d: %v", rate, second, err)
			}
			if second == 0 {
				continue
			}
			for _, offset := range []int64{-int64(rate) / 2, 0, int64(rate) / 2} {
				sample, ok := c.Map(rtp + uint32(offset))
				if !ok || sample != 14400+second*48000+offset*48000/int64(rate) {
					t.Fatalf("rate %d, second %d: extended timestamp mapping failed", rate, second)
				}
			}
		}
		c.Close()
		if c.elapsedRTP != 0 {
			t.Fatal("extended time retained after close")
		}
	}
}

func TestSourceClockStartupAndConfigBoundaries(t *testing.T) {
	now := time.Unix(1700000000, 0)
	for _, cfg := range []struct {
		start time.Time
		now   func() time.Time
		delay int64
	}{
		{time.Time{}, func() time.Time { return now }, 0},
		{now, nil, 0},
		{now, func() time.Time { return now }, -1},
		{now, func() time.Time { return now }, 48001},
		{now.Add(time.Second), func() time.Time { return now }, 0},
	} {
		if c, err := newSourcePublisherClock(cfg.start, cfg.now, cfg.delay); c != nil || err == nil {
			t.Fatal("invalid clock config admitted")
		}
	}
	g, clockNow := clockFixture(t)
	c := mediaClockFixture(t, g, 7, 48000)
	*clockNow = clockNow.Add(sourceClockTimeout - time.Nanosecond)
	if err := c.SourceClockTick(); err != nil {
		t.Fatal(err)
	}
	if _, ok := c.Map(0); ok {
		t.Fatal("startup without reports mapped media")
	}
	*clockNow = clockNow.Add(time.Nanosecond)
	if err := c.SourceClockTick(); err == nil || !c.closed || g.sources != 0 {
		t.Fatal("missing first report retained source clock")
	}
	invalid, err := g.NewSource()
	if err != nil {
		t.Fatal(err)
	}
	if err := invalid.BindSourceClock(8, 44100); err == nil || !invalid.closed || g.sources != 0 {
		t.Fatal("unsupported rate retained source clock")
	}
	g.Close()
	if c, err := g.NewSource(); c != nil || err == nil {
		t.Fatal("closed publisher admitted clock")
	}
}

func TestSourceClockCumulativeDriftAndReferenceDomain(t *testing.T) {
	g, now := clockFixture(t)
	c := mediaClockFixture(t, g, 7, 48000)
	start := *now
	for second := int64(0); second <= 101; second++ {
		*now = start.Add(time.Duration(second) * time.Second)
		// 1000 ppm passes each interval check but exceeds the explicitly
		// unsupported cumulative resampling requirement after 100 seconds.
		err := c.SourceSenderReport(sourceSenderReport{7, uint64(1000+second) << 32, uint32(second * 48048)})
		if second <= 100 && err != nil {
			t.Fatal("valid interval denied before drift limit", err)
		}
		if second == 101 && (err == nil || !c.closed || c.failure != 7) {
			t.Fatal("unresampled drift silently accepted")
		}
	}
	other := mediaClockFixture(t, g, 8, 90000)
	if err := other.SourceSenderReport(sourceSenderReport{8, 1200 << 32, 90000}); err == nil || !other.closed || other.failure != 6 {
		t.Fatal("incompatible reference domain admitted")
	}
	if g.closed {
		t.Fatal("one source closed unrelated publisher clocks")
	}
}

func TestSourceRTCPByteBudgetAndInWindowRollback(t *testing.T) {
	now := time.Unix(1700000000, 0)
	var budget sourceRTCPBudget
	for i := 0; i < 16; i++ {
		if !budget.accept(now, sourceRTCPBytes) {
			t.Fatal("legal byte budget rejected")
		}
	}
	if budget.accept(now, 1) {
		t.Fatal("byte budget exceeded below packet limit")
	}
	if !budget.accept(now.Add(time.Second), 1) {
		t.Fatal("byte budget did not reset")
	}
	if !budget.accept(now.Add(1500*time.Millisecond), 1) {
		t.Fatal("advancing in-window time rejected")
	}
	if budget.accept(now.Add(1400*time.Millisecond), 1) {
		t.Fatal("in-window clock rollback accepted")
	}
	for _, size := range []int{0, -1, sourceRTCPBytes + 1} {
		if budget.accept(now.Add(2*time.Second), size) {
			t.Fatal("invalid RTCP read size admitted")
		}
	}
}

func TestSourceClockQuarantinesRateOutlierWithoutUsingIt(t *testing.T) {
	for _, mode := range []string{"recover", "negative", "repeated", "timeout", "replay", "alternating"} {
		t.Run(mode, func(t *testing.T) {
			g, now := clockFixture(t)
			c := mediaClockFixture(t, g, 7, 48000)
			start := *now
			report := func(second int, skew int32) error {
				*now = start.Add(time.Duration(second) * time.Second)
				return c.SourceSenderReport(sourceSenderReport{7, uint64(1000+second) << 32, uint32(50000+second*48000) + uint32(skew)})
			}
			if report(0, 0) != nil || report(1, 0) != nil {
				t.Fatal("initial clock failed")
			}
			first, last, anchor, fresh, elapsed := c.first, c.last, c.anchor, c.lastReportAt, c.elapsedRTP
			skew := int32(2000)
			if mode == "negative" {
				skew = -2000
			}
			if err := report(2, skew); err != nil || !c.uncertain || c.closed {
				t.Fatal("moderate outlier did not suspend", err)
			}
			if c.first != first || c.last != last || c.anchor != anchor || c.lastReportAt != fresh || c.elapsedRTP != elapsed || c.reports != 2 {
				t.Fatal("rejected report changed mapping or freshness")
			}
			if _, ok := c.Map(146000); ok {
				t.Fatal("uncertain clock emitted program time")
			}
			switch mode {
			case "recover", "negative":
				if report(3, 0) != nil {
					t.Fatal("first recovery report failed")
				}
				if _, ok := c.Map(194000); ok {
					t.Fatal("one report restored uncertain clock")
				}
				if report(4, 0) != nil {
					t.Fatal("second recovery report failed")
				}
				if at, ok := c.Map(242000); !ok || at != 14400+4*48000 || c.uncertain || !c.uncertainAt.IsZero() {
					t.Fatal("recovery moved the fixed map or did not restore readiness")
				}
			case "repeated":
				if report(3, 2000) != nil || report(4, 2000) == nil || c.failure != 5 {
					t.Fatal("unbounded consecutive outliers")
				}
			case "timeout", "replay":
				*now = start.Add(12 * time.Second)
				if mode == "replay" {
					if c.SourceSenderReport(last) != nil || c.SourceSenderReport(first) != nil || c.recovery != 0 {
						t.Fatal("replay changed recovery")
					}
				}
				*now = start.Add(13 * time.Second)
				if c.SourceClockTick() == nil || c.failure != 3 {
					t.Fatal("outlier or replay extended clock freshness")
				}
			case "alternating":
				for second := 3; second < 14; second++ {
					skew := int32(0)
					if second%2 == 0 {
						skew = 2000
					}
					if report(second, skew) != nil {
						t.Fatal("early recovery deadline")
					}
					if _, ok := c.Map(uint32(50000 + second*48000)); ok {
						t.Fatal("alternating reports restored output")
					}
				}
				if report(14, 2000) == nil || c.failure != 3 {
					t.Fatal("alternating outliers kept undecided clock forever")
				}
			}
		})
	}
}

func TestSourceClockMeasuredAudioResidualsWithinExplicitProfile(t *testing.T) {
	for _, sample := range []struct{ interval, skew int64 }{{161914, -1210}, {232654, -1534}, {153321, 1047}} {
		g, now := clockFixture(t)
		c := mediaClockFixture(t, g, 7, 48000)
		if err := c.SourceSenderReport(sourceSenderReport{7, 1000 << 32, 50000}); err != nil {
			t.Fatal(err)
		}
		*now = now.Add(time.Duration(sample.interval) * time.Second / 48000)
		ntpDelta := (uint64(sample.interval)*(1<<32) + 47999) / 48000
		rtp := uint32(50000 + sample.interval + sample.skew)
		if err := c.SourceSenderReport(sourceSenderReport{7, (1000 << 32) + ntpDelta, rtp}); err != nil || c.uncertain || c.reports != 2 {
			t.Fatal("measured bounded audio residual prevented readiness", err)
		}
		if at, ok := c.Map(rtp); !ok || at != 14400+sample.interval+sample.skew {
			t.Fatal("measurement allowance changed the fixed RTP map")
		}
	}
}
