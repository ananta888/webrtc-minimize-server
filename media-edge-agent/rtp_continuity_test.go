package main

import (
	"bytes"
	"testing"

	"github.com/pion/rtp"
)

func TestRTPContinuityRewriterBridgesIndependentSimulcastSequenceSpaces(t *testing.T) {
	rewriter := &rtpContinuityRewriter{}
	payload := []byte{0xde, 0xad, 0xbe, 0xef}
	inputs := []struct {
		layer     string
		sequence  uint16
		timestamp uint32
	}{
		{layer: "low", sequence: 65000, timestamp: 90_000},
		{layer: "low", sequence: 65001, timestamp: 90_000},
		{layer: "low", sequence: 65003, timestamp: 93_000},
		{layer: "high", sequence: 12, timestamp: 7_000},
		{layer: "high", sequence: 13, timestamp: 7_000},
		{layer: "low", sequence: 3, timestamp: 3_000},
	}
	wantSequences := []uint16{65000, 65001, 65002, 65003, 65004, 65005}
	wantTimestamps := []uint32{90_000, 90_000, 93_000, 96_000, 96_000, 99_000}

	for index, input := range inputs {
		packet := &rtp.Packet{Header: rtp.Header{
			Version: 2, SequenceNumber: input.sequence, Timestamp: input.timestamp, SSRC: 1234,
		}, Payload: payload}
		output := rewriter.rewrite(input.layer, packet)
		if output.SequenceNumber != wantSequences[index] || output.Timestamp != wantTimestamps[index] {
			t.Fatalf("packet %d lost RTP continuity: got seq=%d ts=%d", index, output.SequenceNumber, output.Timestamp)
		}
		if !bytes.Equal(output.Payload, payload) || !bytes.Equal(packet.Payload, payload) {
			t.Fatalf("packet %d modified opaque media payload", index)
		}
		if packet.SequenceNumber != input.sequence || packet.Timestamp != input.timestamp {
			t.Fatalf("packet %d mutated the ingress RTP header", index)
		}
	}
}

func TestRTPContinuityRewriterKeepsTimestampWrapDelta(t *testing.T) {
	rewriter := &rtpContinuityRewriter{}
	first := rewriter.rewrite("audio", &rtp.Packet{Header: rtp.Header{
		SequenceNumber: 65535, Timestamp: ^uint32(0) - 479,
	}})
	second := rewriter.rewrite("audio", &rtp.Packet{Header: rtp.Header{
		SequenceNumber: 0, Timestamp: 480,
	}})
	if second.SequenceNumber != 0 || second.Timestamp-first.Timestamp != 960 {
		t.Fatalf("RTP wrap was not retained: first=%+v second=%+v", first.Header, second.Header)
	}
}
