package main

import (
	"bytes"
	"testing"
	"time"

	"github.com/pion/rtp"
	"github.com/pion/rtp/codecs"
)

func sourcePackets(frame []byte, stamp uint32) []*rtp.Packet {
	payloads := (&codecs.VP8Payloader{}).Payload(1200, frame)
	packets := make([]*rtp.Packet, len(payloads))
	for i, payload := range payloads {
		packets[i] = &rtp.Packet{Header: rtp.Header{Version: 2, SequenceNumber: 65534 + uint16(i), Timestamp: stamp, Marker: i == len(payloads)-1}, Payload: payload}
	}
	return packets
}
func TestSourceFrameAssemblyReorderWrapAndBoundaries(t *testing.T) {
	frame := append([]byte{1, 0, 0}, bytes.Repeat([]byte{42}, 4000)...)
	packets := sourcePackets(frame, 9)
	now := time.Now()
	var assembly sourceFrameAssembly
	for _, i := range []int{2, 3, 0} {
		if result := assembly.push(packets[i], now); result != nil {
			t.Fatal("partial frame emitted")
		}
	}
	if !bytes.Equal(assembly.push(packets[1], now), frame) {
		t.Fatal("reordered/wrapped frame lost")
	}
	if assembly.active || assembly.bytes != 0 || assembly.fragments != nil {
		t.Fatal("assembly retained cipher fragments")
	}
	assembly.push(packets[0], now)
	if assembly.push(packets[0], now) != nil || len(assembly.fragments) != 1 {
		t.Fatal("duplicate grew state")
	}
	assembly.expire(now.Add(251 * time.Millisecond))
	if assembly.active || assembly.bytes != 0 {
		t.Fatal("idle assembly not erased")
	}
}
func TestSourceFrameAssemblyNeverEmitsMissingConflictingOrOversizedFrames(t *testing.T) {
	now := time.Now()
	frame := append([]byte{1, 0, 0}, bytes.Repeat([]byte{42}, 4000)...)
	packets := sourcePackets(frame, 9)
	var assembly sourceFrameAssembly
	for _, i := range []int{0, 2, 3} {
		if assembly.push(packets[i], now) != nil {
			t.Fatal("gap emitted")
		}
	}
	bad := *packets[2]
	bad.Payload = bytes.Clone(bad.Payload)
	bad.Payload[len(bad.Payload)-1] ^= 1
	assembly.push(&bad, now)
	if assembly.active {
		t.Fatal("conflicting duplicate retained")
	}
	for i := range 65 {
		packet := &rtp.Packet{Header: rtp.Header{SequenceNumber: uint16(i), Timestamp: 5}, Payload: []byte{0, 1}}
		if assembly.push(packet, now) != nil {
			t.Fatal("startless frame emitted")
		}
	}
	if assembly.active {
		t.Fatal("startless queue unbounded")
	}
	large := append([]byte{1, 0, 0}, make([]byte, sourceFrameLimit)...)
	for _, packet := range sourcePackets(large, 10) {
		if assembly.push(packet, now) != nil {
			t.Fatal("oversized frame emitted")
		}
	}
	assembly.clear()
	if assembly.bytes != 0 {
		t.Fatal("large queue retained")
	}
}
