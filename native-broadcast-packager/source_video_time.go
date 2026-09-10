package main

// A local timing port, not authority. A snapshot and map are read under the
// clock mutex. Callbacks never reenter the mixer or decoder.
type sourceVideoTimeState uint8

const (
	sourceVideoTimeDenied sourceVideoTimeState = iota
	sourceVideoTimeWaiting
	sourceVideoTimeSuspended
	sourceVideoTimeReady
)

type sourceVideoTime struct {
	state sourceVideoTimeState
	epoch uint64
}

type sourceVideoTimeline interface {
	VideoTime() sourceVideoTime
	MapVideo(uint32) (int64, sourceVideoTime)
}

func (c *sourceMediaClock) videoTimeLocked() sourceVideoTime {
	snapshot := sourceVideoTime{epoch: c.videoEpoch}
	if _, err := c.currentLocked(); err != nil || (c.bound && c.rate != 90000) || c.adaptive {
		return snapshot
	}
	switch {
	case c.uncertain:
		snapshot.state = sourceVideoTimeSuspended
	case !c.bound || c.reports < 2:
		snapshot.state = sourceVideoTimeWaiting
	default:
		snapshot.state = sourceVideoTimeReady
	}
	return snapshot
}

func (c *sourceMediaClock) VideoTime() sourceVideoTime {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.videoTimeLocked()
}

func (c *sourceMediaClock) MapVideo(timestamp uint32) (int64, sourceVideoTime) {
	c.mu.Lock()
	defer c.mu.Unlock()
	snapshot := c.videoTimeLocked()
	if snapshot.state == sourceVideoTimeDenied || c.reports == 0 {
		return 0, snapshot
	}
	distance := int64(int32(timestamp - c.last.rtp))
	sample := c.anchor + (c.elapsedRTP+distance)*48000/int64(c.rate)
	// Invalid media timestamps are not recoverable report uncertainty.
	if distance < -int64(c.rate)*12 || distance > int64(c.rate)*12 || sample < 0 {
		snapshot.state = sourceVideoTimeDenied
	}
	return sample, snapshot
}

// Called only under the mixer mutex. Advancing the local epoch invalidates
// already borrowed output even when no render happened during quarantine.
func (s *sourceVideoMixInput) acceptVideoTime(snapshot sourceVideoTime) bool {
	if snapshot.state < sourceVideoTimeWaiting || snapshot.state > sourceVideoTimeReady ||
		(s.timeBound && snapshot.epoch < s.timeEpoch) {
		s.closeLocked()
		return false
	}
	if !s.timeBound || snapshot.epoch != s.timeEpoch {
		s.discardVideoFrames()
		s.fence.closed.Store(true)
		timeline, allowed, epoch := s.cfg.timeline, s.cfg.authorized, snapshot.epoch
		s.fence = &sourceRenderFence{allowed: func() bool {
			current := timeline.VideoTime()
			return current.state == sourceVideoTimeReady && current.epoch == epoch && allowed()
		}}
		s.timeEpoch, s.timeBound = epoch, true
	}
	if snapshot.state != sourceVideoTimeReady {
		s.discardVideoFrames()
		return false
	}
	return true
}

func (s *sourceVideoMixInput) discardVideoFrames() {
	for i := range s.frames {
		s.clearFrame(i)
	}
	clear(s.pending)
	s.pending, s.current = s.pending[:0], -1
	// Keep last/started: recovering time never permits replay or re-anchoring.
}
