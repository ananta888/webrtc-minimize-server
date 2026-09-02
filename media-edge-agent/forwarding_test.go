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
	tracks := make(map[string]*forwardPublication, 40)
	for index := 0; index < 40; index++ {
		tracks[fmt.Sprintf("track-%d", index)] = nil
	}
	agent.rooms["room-123456"] = &mediaRoom{peers: peers, tracks: tracks, trackCount: 40}
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

func TestPublicationSelectsOneBoundedLayerPerSubscriber(t *testing.T) {
	publication := &forwardPublication{layers: map[string]*forwardLayer{
		"low": {}, "medium": {}, "high": {},
	}}
	if selected := publication.selectLayer(subscriptionPlan{
		PreferredLayer: "medium", MaximumLayer: "high",
	}); selected != "medium" {
		t.Fatalf("expected individual medium layer, got %q", selected)
	}
	delete(publication.layers, "medium")
	if selected := publication.selectLayer(subscriptionPlan{
		PreferredLayer: "medium", MaximumLayer: "high",
	}); selected != "low" {
		t.Fatalf("expected bounded lower fallback, got %q", selected)
	}
	publication.layers = map[string]*forwardLayer{"single": {}}
	if selected := publication.selectLayer(subscriptionPlan{
		PreferredLayer: "high", MaximumLayer: "high",
	}); selected != "single" {
		t.Fatalf("expected portable non-simulcast fallback, got %q", selected)
	}
}

func TestVideoLayerMapsReservedSingleTransportRIDToClosedContract(t *testing.T) {
	tests := []struct {
		rid, layer, contractRID string
		valid                   bool
	}{
		{rid: "q", layer: "low", contractRID: "q", valid: true},
		{rid: "h", layer: "medium", contractRID: "h", valid: true},
		{rid: "f", layer: "high", contractRID: "f", valid: true},
		{rid: "s", layer: "single", contractRID: "", valid: true},
		{rid: "", layer: "single", contractRID: "", valid: true},
		{rid: "unknown", valid: false},
	}
	for _, test := range tests {
		layer, contractRID, valid := videoLayer(test.rid)
		if layer != test.layer || contractRID != test.contractRID || valid != test.valid {
			t.Fatalf("RID %q mapped to (%q, %q, %t)", test.rid, layer, contractRID, valid)
		}
	}
}

func TestLayerAggregatesBurstKeyframeFeedback(t *testing.T) {
	layer := &forwardLayer{}
	now := time.Unix(100, 0)
	if !layer.allowKeyframeRequest(now) || layer.allowKeyframeRequest(now.Add(249*time.Millisecond)) {
		t.Fatal("keyframe feedback burst was not aggregated")
	}
	if !layer.allowKeyframeRequest(now.Add(250 * time.Millisecond)) {
		t.Fatal("bounded keyframe feedback window did not reopen")
	}
}
