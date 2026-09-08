package main

import (
	"errors"
	"sync"
	"time"
)

const sourceClockTimeout = 12 * time.Second

// The program owner supplies one reference handle per authorized publisher
// generation. Handles are not wire identities or permission grants. Separate
// publishers must not be grouped merely because their NTP values look similar.
type sourcePublisherClock struct {
	mu                       sync.Mutex
	now                      func() time.Time
	start, last, referenceAt time.Time
	delay, referenceSample   int64
	referenceNTP             uint64
	anchored, closed         bool
	sources                  int
}

type sourceSenderReport struct {
	ssrc uint32
	ntp  uint64
	rtp  uint32
}

// Implemented only by sinks which explicitly request report-based clocking.
// Methods must be bounded, thread-safe and must not reenter the transport.
type trustedSourceClockSink interface {
	BindSourceClock(ssrc, rate uint32) error
	SourceSenderReport(sourceSenderReport) error
	SourceClockTick() error
	CloseSourceClock()
}

type sourceMediaClock struct {
	mu                    sync.Mutex
	publisher             *sourcePublisherClock
	ssrc, rate            uint32
	boundAt, lastReportAt time.Time
	first, last           sourceSenderReport
	anchor                int64
	elapsedRTP            int64
	reports               uint32
	bound, closed         bool
	// Closed local enum, never timestamps, SSRCs, content or identifiers:
	// 1 binding, 2 owner/closed, 3 expiry, 4 report scope, 5 discontinuity,
	// 6 reference domain, 7 unsupported cumulative drift.
	failure uint8
	// Bounded relative error only, for content-free fixture diagnostics.
	failureInterval, failureSkew int32
	uncertain                    bool
	outliers, recovery           uint8
	uncertainAt                  time.Time
}

func sourceDurationSamples(d time.Duration) int64 {
	return int64(d/time.Second)*48000 + int64(d%time.Second)*48000/int64(time.Second)
}

// Signed modular NTP difference also covers the 2036 seconds-field wrap.
// Split arithmetic avoids overflowing int64 when multiplying the fraction.
func sourceNTPSamples(ntp, reference uint64) int64 {
	delta := int64(ntp - reference)
	return (delta/(1<<32))*48000 + (delta%(1<<32))*48000/(1<<32)
}

func newSourcePublisherClock(start time.Time, now func() time.Time, delaySamples int64) (*sourcePublisherClock, error) {
	if start.IsZero() || now == nil || delaySamples < 0 || delaySamples > 48000 {
		return nil, errors.New("source publisher clock config")
	}
	c := &sourcePublisherClock{start: start, now: now, delay: delaySamples}
	if _, err := c.timeLocked(); err != nil {
		return nil, err
	}
	return c, nil
}

// Called with the publisher lock held. Sampling after acquiring that lock
// avoids treating concurrent readers' scheduling order as wallclock rollback.
func (c *sourcePublisherClock) timeLocked() (time.Time, error) {
	if c.closed {
		return time.Time{}, errors.New("source publisher clock closed")
	}
	now := c.now()
	if now.Before(c.start) || now.Before(c.last) {
		c.closed = true
		return time.Time{}, errors.New("source publisher clock rollback")
	}
	c.last = now
	return now, nil
}

func (c *sourcePublisherClock) timeNow() (time.Time, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.timeLocked()
}

func (c *sourcePublisherClock) reference(ntp uint64) (int64, time.Time, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	now, err := c.timeLocked()
	if err != nil || ntp == 0 {
		return 0, now, errors.New("source reference clock unavailable")
	}
	if !c.anchored {
		c.anchored, c.referenceNTP, c.referenceAt = true, ntp, now
		c.referenceSample = sourceDurationSamples(now.Sub(c.start)) + c.delay
	}
	delta := sourceNTPSamples(ntp, c.referenceNTP)
	// Arrival anchors program placement, never the relative A/V timestamps.
	// Reject incompatible sender clock domains; no global UTC assumption.
	errorSamples := delta - sourceDurationSamples(now.Sub(c.referenceAt))
	if errorSamples < -96000 || errorSamples > 96000 || c.referenceSample+delta < 0 {
		return 0, now, errors.New("source reference domain mismatch")
	}
	return c.referenceSample + delta, now, nil
}

func (c *sourcePublisherClock) NewSource() (*sourceMediaClock, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if _, err := c.timeLocked(); err != nil || c.sources >= 4 {
		return nil, errors.New("source clock admission denied")
	}
	c.sources++
	return &sourceMediaClock{publisher: c}, nil
}

func (c *sourcePublisherClock) Close() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.closed = true
	c.referenceNTP, c.referenceSample = 0, 0
	// Children check the terminal owner state on every observation/map/tick.
}

func (c *sourceMediaClock) BindSourceClock(ssrc, rate uint32) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	now, err := c.publisher.timeNow()
	if c.closed || err != nil || (rate != 48000 && rate != 90000) || (c.bound && (c.ssrc != ssrc || c.rate != rate)) {
		c.failLocked(1)
		return errors.New("source clock binding denied")
	}
	if !c.bound {
		c.bound, c.ssrc, c.rate, c.boundAt = true, ssrc, rate, now
	}
	return nil
}

func (c *sourceMediaClock) currentLocked() (time.Time, error) {
	now, err := c.publisher.timeNow()
	if c.closed || err != nil {
		c.failLocked(2)
		return now, errors.New("source clock closed")
	}
	deadline := c.boundAt
	if c.reports > 0 {
		deadline = c.lastReportAt
	}
	if (c.bound && now.Sub(deadline) >= sourceClockTimeout) || (c.uncertain && now.Sub(c.uncertainAt) >= sourceClockTimeout) {
		c.failLocked(3)
		return now, errors.New("source clock expired")
	}
	return now, nil
}

func (c *sourceMediaClock) SourceClockTick() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	_, err := c.currentLocked()
	return err
}

func (c *sourceMediaClock) SourceSenderReport(report sourceSenderReport) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	observedAt, err := c.currentLocked()
	if err != nil || !c.bound || report.ssrc != c.ssrc || report.ntp == 0 {
		c.failLocked(4)
		return errors.New("source sender report denied")
	}
	elapsedRTP := c.elapsedRTP
	if c.reports > 0 {
		delta := int64(report.ntp - c.last.ntp)
		if delta < 0 || (delta == 0 && report.rtp == c.last.rtp) {
			return nil
		} // No freshness extension.
		ntpSamples := sourceNTPSamples(report.ntp, c.last.ntp)
		rtpDelta := int64(int32(report.rtp - c.last.rtp))
		rtpSamples := rtpDelta * 48000 / int64(c.rate)
		// Explicit measurement allowance, not a claim about clock precision:
		// one 20-ms program block for audio, 2 ms for video, plus 0.5% slope.
		// Browser audio reports showed 25-32 ms residuals across 3-5 seconds;
		// a fixed 2-ms allowance rejected otherwise usable paired timing.
		jitter := int64(96)
		if c.rate == 48000 {
			jitter = sourceAudioMixSamples
		}
		tolerance := jitter + ntpSamples/200
		skew := rtpSamples - ntpSamples
		invalidShape := delta == 0 || rtpDelta <= 0 || ntpSamples <= 0 || ntpSamples > 12*48000
		if invalidShape || skew > tolerance || skew < -tolerance {
			c.failureInterval = int32(max(-576000, min(576000, ntpSamples)))
			c.failureSkew = int32(max(-48000, min(48000, skew)))
			// A moderate rate outlier is not a new clock anchor. Suspend output
			// and require two consistent reports before restoring the fixed map.
			// Rejected measurements never extend freshness or advance RTP state.
			if !invalidShape && skew >= -4800 && skew <= 4800 && c.outliers < 2 {
				if !c.uncertain {
					c.uncertainAt = observedAt
				}
				c.uncertain, c.recovery = true, 0
				c.outliers++
				return nil
			}
			c.failLocked(5)
			return errors.New("source sender clock discontinuity")
		}
		// Extend only validated, short report intervals, never the difference
		// from the first 32-bit timestamp (which becomes ambiguous after hours).
		elapsedRTP += rtpDelta
	}
	programSample, now, err := c.publisher.reference(report.ntp)
	if err != nil {
		c.failLocked(6)
		return err
	}
	if c.reports == 0 {
		c.first, c.anchor = report, programSample
	} else {
		predicted := c.anchor + elapsedRTP*48000/int64(c.rate)
		if predicted-programSample > 4800 || programSample-predicted > 4800 {
			c.failLocked(7)
			return errors.New("source clock requires resampling")
		}
	}
	c.last, c.lastReportAt, c.elapsedRTP = report, now, elapsedRTP
	c.outliers = 0
	if c.uncertain {
		c.recovery++
		if c.recovery == 2 {
			c.uncertain, c.recovery = false, 0
			c.uncertainAt = time.Time{}
		}
	}
	if c.reports < 65535 {
		c.reports++
	}
	return nil
}

// Two advancing reports establish readiness. The affine map stays fixed for
// this generation: report jitter must not introduce overlapping PCM spans.
// This is not a resampler or a guarantee of globally synchronized publishers.
func (c *sourceMediaClock) Map(timestamp uint32) (int64, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if _, err := c.currentLocked(); err != nil || c.reports < 2 || c.uncertain {
		return 0, false
	}
	distance := int64(int32(timestamp - c.last.rtp))
	if distance < -int64(c.rate)*12 || distance > int64(c.rate)*12 {
		return 0, false
	}
	sample := c.anchor + (c.elapsedRTP+distance)*48000/int64(c.rate)
	return sample, sample >= 0
}

func (c *sourceMediaClock) closeLocked() {
	if c.closed {
		return
	}
	c.closed = true
	c.first, c.last, c.anchor, c.reports = sourceSenderReport{}, sourceSenderReport{}, 0, 0
	c.elapsedRTP = 0
	c.uncertain, c.outliers, c.recovery = false, 0, 0
	c.uncertainAt = time.Time{}
	c.publisher.mu.Lock()
	c.publisher.sources--
	c.publisher.mu.Unlock()
}

func (c *sourceMediaClock) failLocked(reason uint8) {
	if !c.closed {
		c.failure = reason
	}
	c.closeLocked()
}

func (c *sourceMediaClock) Close() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.closeLocked()
}

func (c *sourceMediaClock) CloseSourceClock() { c.Close() }
