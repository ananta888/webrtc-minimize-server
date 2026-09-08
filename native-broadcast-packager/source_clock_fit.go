package main

import "math"

type sourceClockPoint struct{ x, y float64 }

// Centered, bounded measurement model. Coordinates are relative RTP samples
// and local program samples, never raw absolute NTP values in floating point.
type sourceClockFit struct {
	points      [12]sourceClockPoint
	count       int
	x, y, slope float64
}

func (f *sourceClockFit) predict(x float64) float64 { return f.y + (x-f.x)*f.slope }

func (f *sourceClockFit) add(x, y float64) bool {
	if math.IsNaN(x) || math.IsNaN(y) || math.IsInf(x, 0) || math.IsInf(y, 0) || x < 0 || y < 0 {
		return false
	}
	if f.count > 0 && (x <= f.points[f.count-1].x || y <= f.points[f.count-1].y) {
		return false
	}
	if f.count >= 2 && math.Abs(f.predict(x)-y) > 4800 {
		return false
	}
	candidate := *f
	if candidate.count == len(candidate.points) {
		copy(candidate.points[:], candidate.points[1:])
		candidate.count--
	}
	candidate.points[candidate.count] = sourceClockPoint{x, y}
	candidate.count++
	if candidate.count == 1 {
		*f = candidate
		return true
	}
	var meanX, meanY float64
	for _, p := range candidate.points[:candidate.count] {
		meanX += p.x
		meanY += p.y
	}
	meanX /= float64(candidate.count)
	meanY /= float64(candidate.count)
	var variance, covariance float64
	for _, p := range candidate.points[:candidate.count] {
		dx := p.x - meanX
		variance += dx * dx
		covariance += dx * (p.y - meanY)
	}
	if variance < 1 {
		return false
	}
	candidate.x, candidate.y, candidate.slope = meanX, meanY, covariance/variance
	if candidate.slope < .95 || candidate.slope > 1.05 {
		return false
	}
	for _, p := range candidate.points[:candidate.count] {
		if math.Abs(candidate.predict(p.x)-p.y) > 4800 {
			return false
		}
	}
	*f = candidate
	return true
}

// A timing snapshot is consumed by sample conversion, not by relabeling the
// same PCM bytes with a different timestamp. One step is program/input sample.
type sourceAudioTiming struct{ sample, step float64 }

func (c *sourcePublisherClock) NewAdaptiveAudioSource() (*sourceMediaClock, error) {
	s, err := c.NewSource()
	if err == nil {
		s.adaptive = true
	}
	return s, err
}

func (c *sourceMediaClock) AudioTiming(timestamp uint32) (sourceAudioTiming, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if _, err := c.currentLocked(); err != nil || !c.adaptive || c.rate != 48000 || c.fit.count < 2 || c.uncertain {
		return sourceAudioTiming{}, false
	}
	distance := int64(int32(timestamp - c.last.rtp))
	if distance < -48000*12 || distance > 48000*12 {
		return sourceAudioTiming{}, false
	}
	at := c.fit.predict(float64(c.elapsedRTP + distance))
	return sourceAudioTiming{at, c.fit.slope}, at >= 0
}
