package main

import "time"

// Fixed bounded local admission cadence. No operator policy or source lease.
type sourceRolloverBudget struct {
	starts [8]time.Time
	count  int
	last   time.Time
}

func (b *sourceRolloverBudget) reserve(now time.Time) (time.Duration, bool) {
	if now.IsZero() || !b.last.IsZero() && now.Before(b.last) {
		return 0, false
	}
	at := now
	if !b.last.IsZero() && at.Before(b.last.Add(time.Second)) {
		at = b.last.Add(time.Second)
	}
	count := 0
	for i := 0; i < b.count; i++ {
		if b.starts[i].After(at.Add(-time.Minute)) {
			b.starts[count] = b.starts[i]
			count++
		}
	}
	b.count = count
	if count == len(b.starts) {
		return 0, false
	}
	b.starts[count], b.last, b.count = at, at, count+1
	return at.Sub(now), true
}
