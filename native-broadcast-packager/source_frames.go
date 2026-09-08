package main

import (
	"bytes"
	"time"

	"github.com/pion/rtp"
	"github.com/pion/rtp/codecs"
)

const sourceFrameLimit = 4 * 1024 * 1024

// A single bounded VP8 assembly, owned by source transport's frame mutex.
// Ciphertext only. Missing/inconsistent fragments never produce partial frames.
type sourceFrameAssembly struct {
	active, started, ended bool
	timestamp              uint32
	first, last            uint16
	deadline               time.Time
	fragments              map[uint16][]byte
	bytes                  int
}

func (a *sourceFrameAssembly) clear() {
	for _, part := range a.fragments {
		clear(part)
	}
	*a = sourceFrameAssembly{}
}
func (a *sourceFrameAssembly) expire(now time.Time) {
	if a.active && !now.Before(a.deadline) {
		a.clear()
	}
}
func (a *sourceFrameAssembly) push(packet *rtp.Packet, now time.Time) []byte {
	a.expire(now)
	if packet == nil || len(packet.Payload) == 0 || len(packet.Payload) > 65535 {
		return nil
	}
	var depay codecs.VP8Packet
	payload, err := depay.Unmarshal(packet.Payload)
	if err != nil || len(payload) == 0 {
		return nil
	}
	if a.active && packet.Timestamp != a.timestamp {
		if int32(packet.Timestamp-a.timestamp) <= 0 {
			return nil
		}
		a.clear()
	}
	if !a.active {
		a.active = true
		a.timestamp = packet.Timestamp
		a.deadline = now.Add(250 * time.Millisecond)
		a.fragments = make(map[uint16][]byte)
	}
	if old, found := a.fragments[packet.SequenceNumber]; found {
		if !bytes.Equal(old, payload) {
			a.clear()
		}
		return nil
	}
	start := depay.IsPartitionHead(packet.Payload)
	if start {
		if a.started && a.first != packet.SequenceNumber {
			a.clear()
			return nil
		}
		a.started = true
		a.first = packet.SequenceNumber
	}
	if packet.Marker {
		if a.ended && a.last != packet.SequenceNumber {
			a.clear()
			return nil
		}
		a.ended = true
		a.last = packet.SequenceNumber
	}
	if a.bytes+len(payload) > sourceFrameLimit || len(a.fragments) >= 4096 || !a.started && len(a.fragments) >= 64 {
		a.clear()
		return nil
	}
	if a.started && uint16(packet.SequenceNumber-a.first) >= 4096 {
		a.clear()
		return nil
	}
	a.fragments[packet.SequenceNumber] = append([]byte(nil), payload...)
	a.bytes += len(payload)
	if !a.started || !a.ended {
		return nil
	}
	count := int(uint16(a.last-a.first)) + 1
	if count > 4096 {
		a.clear()
		return nil
	}
	if len(a.fragments) != count {
		return nil
	}
	for i := 0; i < count; i++ {
		if _, found := a.fragments[a.first+uint16(i)]; !found {
			return nil
		}
	}
	frame := make([]byte, 0, a.bytes)
	for i := 0; i < count; i++ {
		frame = append(frame, a.fragments[a.first+uint16(i)]...)
	}
	a.clear()
	return frame
}
