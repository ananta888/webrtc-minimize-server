package main

import (
	"errors"
	"sync"
	"time"

	"github.com/pion/rtcp"
)

// No peer/SSRC argument: only the transport can select its verified source.
// Binding and requests must be bounded and must not call back into the sink.
type trustedSourceFeedbackSink interface {
	BindSourceKeyframeRequester(func() bool) error
}

type sourceKeyframeRequests struct {
	mu     sync.Mutex
	queue  chan struct{}
	last   time.Time
	closed bool
}

func newSourceKeyframeRequests() *sourceKeyframeRequests {
	return &sourceKeyframeRequests{queue: make(chan struct{}, 1)}
}

func (r *sourceKeyframeRequests) request(now time.Time) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.closed || now.IsZero() || !r.last.IsZero() && now.Sub(r.last) < time.Second {
		return false
	}
	select {
	case r.queue <- struct{}{}:
		r.last = now
		return true
	default:
		return false
	}
}

func (r *sourceKeyframeRequests) Close() {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.closed = true
	select {
	case <-r.queue:
	default:
	}
}

func (t *trustedSourceTransport) startSourceFeedback(ssrc uint32) error {
	sink, ok := t.sink.(trustedSourceFeedbackSink)
	if !ok || t.lease.Codec != "video/vp8" {
		return nil
	}
	r := newSourceKeyframeRequests()
	if err := sink.BindSourceKeyframeRequester(func() bool {
		return !t.closed.Load() && t.receiver.AliveNow() && r.request(time.Now())
	}); err != nil {
		r.Close()
		return errors.New("source feedback binding")
	}
	t.frameMu.Lock()
	if t.closed.Load() {
		t.frameMu.Unlock()
		r.Close()
		return errors.New("source feedback closed")
	}
	t.readers.Add(1)
	t.frameMu.Unlock()
	go func() {
		defer t.readers.Done()
		defer r.Close()
		var lastSent time.Time
		for {
			select {
			case <-t.receiver.Done():
				return
			case <-r.queue:
				if delay := time.Until(lastSent.Add(time.Second)); delay > 0 {
					timer := time.NewTimer(delay)
					select {
					case <-t.receiver.Done():
						timer.Stop()
						return
					case <-timer.C:
					}
				}
				if t.closed.Load() || !t.receiver.AliveNow() {
					return
				}
				// The only target is the OnTrack-verified SSRC on this exact PC.
				if t.pc.WriteRTCP([]rtcp.Packet{&rtcp.PictureLossIndication{MediaSSRC: ssrc}}) != nil {
					t.closeWithFailure(8)
					return
				}
				lastSent = time.Now()
			}
		}
	}()
	return nil
}
