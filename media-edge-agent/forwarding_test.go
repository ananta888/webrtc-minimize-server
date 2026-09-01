package main

import (
	"bytes"
	"fmt"
	"testing"
	"time"

	"github.com/pion/rtp"
)

func TestAgentLoadUsesBoundedRoomPeerAndTrackUtilization(t *testing.T) {
	agent := newMediaAgent(config{load: 5, maxRooms: 2, maxPeers: 20, maxTracks: 80}, nil)
	peers := make(map[string]*mediaPeer, 10)
	for index := 0; index < 10; index++ {
		peers[fmt.Sprintf("peer-%d", index)] = nil
	}
	tracks := make(map[string]*forwardTrack, 40)
	for index := 0; index < 40; index++ {
		tracks[fmt.Sprintf("track-%d", index)] = nil
	}
	agent.rooms["room-123456"] = &mediaRoom{peers: peers, tracks: tracks}
	if load := agent.loadPercent(); load != 50 {
		t.Fatalf("expected 50 percent load, got %d", load)
	}
	agent.cfg.load = 90
	if load := agent.loadPercent(); load != 90 {
		t.Fatalf("configured floor must remain visible, got %d", load)
	}
}

func TestCloneRTPPacketPreservesOpaqueCiphertextAndOwnsItsBuffer(t *testing.T) {
	payload := []byte{0x88, 0x00, 0x01, 0x02, 0x03, 0xfa, 0xfb, 0xfc}
	original := &rtp.Packet{
		Header:  rtp.Header{Version: 2, PayloadType: 96, SequenceNumber: 77, Timestamp: 1234, SSRC: 42},
		Payload: append([]byte(nil), payload...),
	}
	clone, err := cloneRTPPacket(original, 2048)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(clone.Payload, payload) {
		t.Fatal("opaque RTP payload changed")
	}
	original.Payload[0] ^= 0xff
	if !bytes.Equal(clone.Payload, payload) {
		t.Fatal("forwarded payload aliases the inbound buffer")
	}
	if _, err = cloneRTPPacket(original, 8); err == nil {
		t.Fatal("oversize RTP packet accepted")
	}
}

func TestBitrateBudgetDropsBeyondBoundAndRenewsPerWindow(t *testing.T) {
	budget := bitrateBudget{limit: 100}
	now := time.Unix(100, 0)
	if !budget.allow(60, now) || budget.allow(41, now) {
		t.Fatal("byte budget was not enforced")
	}
	if !budget.allow(100, now.Add(time.Second)) {
		t.Fatal("byte budget did not renew")
	}
}
