package main

import (
	"net"
	"sync"
	"time"

	"github.com/pion/turn/v5"
)

const quotaReservationTTL = 5 * time.Second

type quotaTracker struct {
	mu            sync.Mutex
	maxTotal      int
	maxPerUser    int
	now           clock
	activeTotal   int
	activeByUser  map[string]int
	pendingByUser map[string][]time.Time
}

func newQuotaTracker(maxTotal, maxPerUser int, now clock) *quotaTracker {
	return &quotaTracker{
		maxTotal:      maxTotal,
		maxPerUser:    maxPerUser,
		now:           now,
		activeByUser:  make(map[string]int),
		pendingByUser: make(map[string][]time.Time),
	}
}

func (q *quotaTracker) handler(username, _ string, _ net.Addr) bool {
	q.mu.Lock()
	defer q.mu.Unlock()
	q.prunePendingLocked()
	pendingTotal := 0
	for _, reservations := range q.pendingByUser {
		pendingTotal += len(reservations)
	}
	if q.activeTotal+pendingTotal >= q.maxTotal ||
		q.activeByUser[username]+len(q.pendingByUser[username]) >= q.maxPerUser {
		return false
	}
	q.pendingByUser[username] = append(q.pendingByUser[username], q.now().Add(quotaReservationTTL))
	return true
}

func (q *quotaTracker) eventHandler() turn.EventHandler {
	return turn.EventHandler{
		OnAllocationCreated: func(_, _ net.Addr, _, userID, _ string, _ net.Addr, _ int) {
			q.mu.Lock()
			defer q.mu.Unlock()
			q.consumePendingLocked(userID)
			q.activeTotal++
			q.activeByUser[userID]++
		},
		OnAllocationDeleted: func(_, _ net.Addr, _, userID, _ string) {
			q.mu.Lock()
			defer q.mu.Unlock()
			if q.activeByUser[userID] <= 0 {
				return
			}
			q.activeByUser[userID]--
			q.activeTotal--
			if q.activeByUser[userID] == 0 {
				delete(q.activeByUser, userID)
			}
		},
	}
}

func (q *quotaTracker) consumePendingLocked(userID string) {
	reservations := q.pendingByUser[userID]
	if len(reservations) <= 1 {
		delete(q.pendingByUser, userID)
		return
	}
	q.pendingByUser[userID] = reservations[1:]
}

func (q *quotaTracker) prunePendingLocked() {
	now := q.now()
	for userID, reservations := range q.pendingByUser {
		kept := reservations[:0]
		for _, expiry := range reservations {
			if expiry.After(now) {
				kept = append(kept, expiry)
			}
		}
		if len(kept) == 0 {
			delete(q.pendingByUser, userID)
		} else {
			q.pendingByUser[userID] = kept
		}
	}
}
