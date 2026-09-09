package main

import (
	"errors"
	"sync"
	"time"
)

const maximumQueuedSourcePrepares = 8

// One constructor/retry worker per control connection, at most eight pending
// bounded wire messages. The socket reader remains free to process revocation.
type sourceControlQueue struct {
	client         *client
	pending        chan serverMessage
	done, finished chan struct{}
	once           sync.Once
}

func newSourceControlQueue(c *client, prepare func(serverMessage, time.Time) error, failed func()) *sourceControlQueue {
	q := &sourceControlQueue{client: c, pending: make(chan serverMessage, maximumQueuedSourcePrepares), done: make(chan struct{}), finished: make(chan struct{})}
	go func() {
		defer close(q.finished)
		for {
			select {
			case <-q.done:
				return
			case message := <-q.pending:
				select {
				case <-q.done:
					clear(message.SourceProgram)
					return
				default:
				}
				err := prepare(message, time.Now())
				clear(message.SourceProgram)
				if err != nil {
					c.revokeControlSession()
					failed() // Close the connection, never wait on this worker itself.
					return
				}
			}
		}
	}()
	return q
}

// Ownership of SourceProgram transfers only on success. Caller is the single
// socket reader; Close is its deferred finalizer, after no further Enqueue.
func (q *sourceControlQueue) Enqueue(m serverMessage) error {
	if !q.client.cfg.sourcePrograms || !q.client.sessionAuthenticated.Load() || m.Version != 4 || m.Type != "assignment-prepare" ||
		len(m.SourceProgram) == 0 || len(m.SourceProgram) > maximumSourceProgramAssignmentBytes {
		return errors.New("source control queue admission denied")
	}
	select {
	case <-q.done:
		return errors.New("source control queue closed")
	case <-q.finished:
		return errors.New("source control worker stopped")
	default:
	}
	select {
	case q.pending <- m:
		return nil
	default:
		return errors.New("source control queue full")
	}
}

func (q *sourceControlQueue) Close() {
	q.client.revokeControlSession()
	q.once.Do(func() { close(q.done) })
	<-q.finished
	for {
		select {
		case m := <-q.pending:
			clear(m.SourceProgram)
		default:
			return
		}
	}
}
