package main

import (
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type sourceFeedbackFixture struct {
	*sourceTestSink
	bound chan func() bool
}

func (s *sourceFeedbackFixture) BindSourceKeyframeRequester(f func() bool) error {
	s.bound <- f
	return nil
}

func TestSourceFeedbackQueueRateAndClose(t *testing.T) {
	r := newSourceKeyframeRequests()
	now := time.Unix(1000, 0)
	if r.request(time.Time{}) || !r.request(now) || r.request(now.Add(2*time.Second)) {
		t.Fatal("queue budget")
	}
	<-r.queue
	if r.request(now.Add(-time.Second)) || r.request(now.Add(time.Second-time.Nanosecond)) {
		t.Fatal("rate/rollback budget")
	}
	if !r.request(now.Add(time.Second)) {
		t.Fatal("rate recovery")
	}
	r.Close()
	r.Close()
	if r.request(now.Add(10*time.Second)) || len(r.queue) != 0 {
		t.Fatal("closed feedback revived")
	}
}

func TestSourceFeedbackConcurrentCoalescing(t *testing.T) {
	r := newSourceKeyframeRequests()
	var accepted atomic.Int32
	var wg sync.WaitGroup
	now := time.Now()
	for i := 0; i < 100; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if r.request(now) {
				accepted.Add(1)
			}
		}()
	}
	wg.Wait()
	if accepted.Load() != 1 || len(r.queue) != 1 {
		t.Fatal("parallel feedback flood")
	}
	r.Close()
}
