package main

import "github.com/pion/rtp"

const defaultVideoTimestampStep = uint32(3000)

// rtpContinuityRewriter keeps one subscriber-facing RTP sequence space stable
// while the selected simulcast source changes. It never reads or modifies the
// opaque media payload.
type rtpContinuityRewriter struct {
	initialized        bool
	layer              string
	nextSequence       uint16
	lastInputTimestamp uint32
	outputTimestamp    uint32
	timestampStep      uint32
}

func (r *rtpContinuityRewriter) rewrite(layer string, packet *rtp.Packet) rtp.Packet {
	output := *packet
	if !r.initialized {
		r.initialized = true
		r.layer = layer
		r.nextSequence = packet.SequenceNumber
		r.lastInputTimestamp = packet.Timestamp
		r.outputTimestamp = packet.Timestamp
		r.timestampStep = defaultVideoTimestampStep
		return output
	}

	r.nextSequence++
	output.SequenceNumber = r.nextSequence
	if layer != r.layer {
		r.layer = layer
		r.lastInputTimestamp = packet.Timestamp
		r.outputTimestamp += r.timestampStep
	} else if packet.Timestamp != r.lastInputTimestamp {
		delta := packet.Timestamp - r.lastInputTimestamp
		if delta == 0 || delta > 90_000 {
			delta = r.timestampStep
		} else {
			r.timestampStep = delta
		}
		r.lastInputTimestamp = packet.Timestamp
		r.outputTimestamp += delta
	}
	output.Timestamp = r.outputTimestamp
	return output
}
