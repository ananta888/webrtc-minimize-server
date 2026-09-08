package main

import (
	"math"
	"testing"
	"time"
)

func TestSourceAdaptiveClockTracksMeasuredRateWithoutRTPRelabeling(t *testing.T) {
	g, now := clockFixture(t)
	c, err := g.NewAdaptiveAudioSource()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(c.Close)
	if err := c.BindSourceClock(7, 48000); err != nil {
		t.Fatal(err)
	}
	start := *now
	firstRTP := uint32(0xffff0000)
	for second := 0; second <= 180; second += 2 {
		*now = start.Add(time.Duration(second) * time.Second)
		rtp := firstRTP + uint32(second*47040)
		if err := c.SourceSenderReport(sourceSenderReport{7, uint64(1000+second) << 32, rtp}); err != nil {
			t.Fatal(err)
		}
		if _, ok := c.Map(rtp); ok {
			t.Fatal("adaptive PCM exposed unchanged-RTP mapping")
		}
		timing, ready := c.AudioTiming(rtp)
		if second == 0 {
			if ready {
				t.Fatal("one report established adaptive timing")
			}
			continue
		}
		if !ready || math.Abs(timing.sample-float64(14400+second*48000)) > .01 || math.Abs(timing.step-48000.0/47040) > 1e-8 || c.fit.count > 12 {
			t.Fatal("measured source drift was not modeled")
		}
	}
	c.Close()
	if c.fit != (sourceClockFit{}) || g.sources != 0 {
		t.Fatal("adaptive measurement state survived close")
	}
	if _, ready := c.AudioTiming(firstRTP); ready {
		t.Fatal("closed adaptive source revived")
	}
}

func TestSourceClockFitRejectsInnovationAndInvalidRatesAtomically(t *testing.T) {
	var fit sourceClockFit
	for i := 0; i < 30; i++ {
		if !fit.add(float64(i)*48000, float64(i)*49000+14400) {
			t.Fatal("valid model denied")
		}
	}
	if fit.count != 12 {
		t.Fatal("fit window not bounded")
	}
	before := fit
	for _, point := range []sourceClockPoint{{math.NaN(), 1}, {1, math.Inf(1)}, {0, 0}, {30 * 48000, 30*49000 + 20000}} {
		if fit.add(point.x, point.y) || fit != before {
			t.Fatal("rejected measurement mutated fit")
		}
	}
	for _, step := range []float64{.94, 1.06} {
		var denied sourceClockFit
		if !denied.add(0, 14400) || denied.add(48000, 14400+48000*step) || denied.count != 1 {
			t.Fatal("unsupported rate accepted")
		}
	}
}

func TestSourceAdaptiveClockQuarantinesOutlierAndRetainsFreshness(t *testing.T) {
	g, now := clockFixture(t)
	c, _ := g.NewAdaptiveAudioSource()
	t.Cleanup(c.Close)
	if err := c.BindSourceClock(7, 48000); err != nil {
		t.Fatal(err)
	}
	start := *now
	report := func(second int, skew int) error {
		*now = start.Add(time.Duration(second) * time.Second)
		return c.SourceSenderReport(sourceSenderReport{7, uint64(1000+second) << 32, uint32(50000 + second*48000 + skew)})
	}
	if report(0, 0) != nil || report(1, 0) != nil {
		t.Fatal("initial reports")
	}
	before, fresh := c.fit, c.lastReportAt
	if report(2, 8000) != nil || !c.uncertain || c.fit != before || c.lastReportAt != fresh {
		t.Fatal("outlier used or extended freshness")
	}
	if _, ok := c.AudioTiming(146000); ok {
		t.Fatal("uncertain adaptive timing exposed")
	}
	if report(3, 0) != nil {
		t.Fatal("recovery report")
	}
	if _, ok := c.AudioTiming(194000); ok {
		t.Fatal("single report ended quarantine")
	}
	if report(4, 0) != nil {
		t.Fatal("second recovery report")
	}
	if at, ok := c.AudioTiming(242000); !ok || math.Abs(at.sample-206400) > .01 {
		t.Fatal("adaptive recovery failed")
	}
	*now = start.Add(16 * time.Second)
	if c.SourceClockTick() == nil {
		t.Fatal("adaptive clock exceeded report deadline")
	}
}
