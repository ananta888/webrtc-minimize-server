package main

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/ananta/webrtc-minimize-server/native-broadcast-packager/internal/trustedsframe"
	"github.com/pion/webrtc/v4"
)

// A real key-only connection is sufficient for channel/permission lifecycle
// tests; it deliberately makes no successful RTP or decoded-media claim.
func sourceKeyPair(t *testing.T, init *webrtc.DataChannelInit) (*client, *trustedSourceTransport, *webrtc.DataChannel, <-chan []byte, *sourceTestSink) {
	t.Helper()
	c, lease, now := trustedSourceFixture(t)
	c.api, _ = createWebRTCAPI()
	sink := &sourceTestSink{frames: make(chan []byte, 8)}
	c.trustedSourceSinkFactory = func(trustedsframe.SourceLease, *trustedsframe.SourceReceiver) (trustedSourceSink, error) {
		return sink, nil
	}
	if _, err := c.prepareTrustedSource(sourceBytes(t, lease), now); err != nil {
		t.Fatal(err)
	}
	peer, err := c.api.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { peer.Close() })
	channel, err := peer.CreateDataChannel(sourceKeyChannel, init)
	if err != nil {
		t.Fatal(err)
	}
	keys := make(chan []byte, 8)
	channel.OnMessage(func(message webrtc.DataChannelMessage) {
		select {
		case keys <- append([]byte(nil), message.Data...):
		default:
		}
	})
	messages := make(chan map[string]any, 256)
	stop := make(chan struct{})
	t.Cleanup(func() { close(stop) })
	c.sendOverride = func(value any) error {
		select {
		case messages <- value.(map[string]any):
		case <-stop:
		}
		return nil
	}
	go func() {
		for {
			select {
			case <-stop:
				return
			case message := <-messages:
				if value, ok := message["description"]; ok {
					raw, _ := json.Marshal(value)
					var description webrtc.SessionDescription
					if json.Unmarshal(raw, &description) == nil {
						_ = peer.SetRemoteDescription(description)
					}
				}
				if value, ok := message["candidate"]; ok {
					raw, _ := json.Marshal(value)
					if candidate, err := decodeNativeCandidate(raw); err == nil {
						_ = peer.AddICECandidate(candidate)
					}
				}
			}
		}
	}()
	offer, err := peer.CreateOffer(nil)
	if err != nil {
		t.Fatal(err)
	}
	gathered := webrtc.GatheringCompletePromise(peer)
	if err = peer.SetLocalDescription(offer); err != nil {
		t.Fatal(err)
	}
	awaitSource(t, gathered)
	if err = c.handleTrustedSourceSignal(sourcePeerMessage(lease, peer.LocalDescription().SDP)); err != nil {
		t.Fatal(err)
	}
	c.sourcesMu.Lock()
	transport := c.trustedSources[lease.SourceLeaseID].transport
	c.sourcesMu.Unlock()
	if transport == nil {
		t.Fatal("source connection was not created")
	}
	return c, transport, channel, keys, sink
}

func TestTrustedSourceChannelAndAuthorityBoundaries(t *testing.T) {
	for _, mode := range []string{"binary", "oversize", "unknown", "wrong-binding", "key-replay", "unordered", "partial-reliable", "protocol", "close", "control-loss", "room-revoke", "expiry"} {
		t.Run(mode, func(t *testing.T) {
			protocol, ordered, retransmits := sourceKeyChannel, false, uint16(1)
			init := &webrtc.DataChannelInit{Protocol: &protocol}
			switch mode {
			case "unordered":
				init.Ordered = &ordered
			case "partial-reliable":
				init.MaxRetransmits = &retransmits
			case "protocol":
				protocol = "unknown"
			}
			c, transport, channel, keys, sink := sourceKeyPair(t, init)
			if mode != "unordered" && mode != "partial-reliable" && mode != "protocol" {
				announcement := awaitSource(t, keys)
				switch mode {
				case "binary":
					_ = channel.Send([]byte("{}"))
				case "oversize":
					_ = channel.SendText(string(make([]byte, 8193)))
				case "unknown":
					_ = channel.SendText(`{"version":1,"privateKey":"forbidden"}`)
				case "wrong-binding":
					lease := transport.lease
					lease.Consent.SourceID = "src_bbbbbbbbbbbbbbbb"
					_ = channel.SendText(string(sourceTestEnvelope(t, lease, announcement)))
				case "key-replay":
					envelope := sourceTestEnvelope(t, transport.lease, announcement)
					if err := channel.SendText(string(envelope)); err != nil {
						t.Fatal(err)
					}
					awaitSource(t, keys)
					_ = channel.SendText(string(envelope))
				case "close":
					_ = channel.Close()
				case "control-loss":
					c.sessionAuthenticated.Store(false)
					c.pruneTrustedSources(time.Now())
				case "room-revoke":
					c.roomsMu.Lock()
					c.rooms = nil
					c.roomsMu.Unlock()
					c.pruneTrustedSources(time.Now())
				case "expiry":
					// Exercise the receiver's own timer, without another RTP/key
					// packet or a maintenance call. The first lease lasts 5 s.
					select {
					case <-transport.done:
					case <-time.After(6 * time.Second):
						t.Fatal("idle source expiry did not close transport")
					}
				}
			}
			awaitSource(t, transport.done)
			if sink.closed.Load() != 1 || transport.receiver.AliveNow() || c.assignment.State != "running" {
				t.Fatal("source permission loss retained resources or stopped parent")
			}
			if len(sink.frames) != 0 {
				t.Fatal("unauthorized source emitted media")
			}
		})
	}
}

func TestTrustedSourceSignalScopeAndSinkRequired(t *testing.T) {
	c, lease, now := trustedSourceFixture(t)
	receiver, err := c.prepareTrustedSource(sourceBytes(t, lease), now)
	if err != nil {
		t.Fatal(err)
	}
	for _, alter := range []func(*trustedsframe.SourcePeerSignal){
		func(m *trustedsframe.SourcePeerSignal) { m.SourceLeaseID = "sls_bbbbbbbbbbbbbbbb" },
		func(m *trustedsframe.SourcePeerSignal) { m.ConsentID = "cns_bbbbbbbbbbbbbbbb" },
		func(m *trustedsframe.SourcePeerSignal) { m.AssignmentID = "asn_bbbbbbbbbbbbbbbb" },
		func(m *trustedsframe.SourcePeerSignal) { m.FencingRevision++ },
		func(m *trustedsframe.SourcePeerSignal) { m.PublisherPeerID = "fedcba9876543210" },
	} {
		message := sourcePeerMessage(lease, "v=0\r\n")
		alter(message)
		if err := c.handleTrustedSourceSignal(message); err != nil || !receiver.AliveNow() {
			t.Fatal("unrelated source signal disturbed receiver", err)
		}
	}
	var status map[string]any
	c.sendOverride = func(value any) error { status = value.(map[string]any); return nil }
	if err := c.handleTrustedSourceSignal(sourcePeerMessage(lease, "v=0\r\n")); err != nil {
		t.Fatal(err)
	}
	if status["state"] != "failed" || receiver.AliveNow() || c.trustedSources[lease.SourceLeaseID].transport != nil || c.assignment.State != "running" {
		t.Fatal("missing sink admitted ingress or stopped parent")
	}
}

func TestTrustedSourceSequenceAndMediaShape(t *testing.T) {
	for _, mode := range []string{"old-negotiation", "skipped-sequence", "replayed-offer", "other-codec-kind", "multiple-tracks"} {
		t.Run(mode, func(t *testing.T) {
			protocol := sourceKeyChannel
			c, transport, _, keys, _ := sourceKeyPair(t, &webrtc.DataChannelInit{Protocol: &protocol})
			awaitSource(t, keys)
			message := sourcePeerMessage(transport.lease, "v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n")
			switch mode {
			case "old-negotiation", "skipped-sequence":
				message.Description = nil
				message.Candidate = json.RawMessage("null")
				message.Sequence = 2
				if mode == "old-negotiation" {
					message.NegotiationRevision = 2
				} else {
					message.Sequence = 3
				}
			case "other-codec-kind":
				message.NegotiationRevision = 2
				message.Description.SDP += "m=audio 9 UDP/TLS/RTP/SAVPF 111\r\n"
			case "multiple-tracks":
				message.NegotiationRevision = 2
				message.Description.SDP += "m=video 9 UDP/TLS/RTP/SAVPF 96\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\n"
			}
			if err := c.handleTrustedSourceSignal(message); err != nil {
				t.Fatal(err)
			}
			awaitSource(t, transport.done)
		})
	}
}

func TestTrustedSourceOfferShapeAndControlDispatch(t *testing.T) {
	application := "m=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n"
	video := "m=video 9 UDP/TLS/RTP/SAVPF 96\r\n"
	audio := "m=audio 9 UDP/TLS/RTP/SAVPF 111\r\n"
	for _, test := range []struct {
		sdp, codec string
		allowed    bool
	}{
		{application, "video/vp8", true}, {application + video, "video/vp8", true},
		{application + audio, "audio/opus", true}, {video, "video/vp8", false},
		{application + audio, "video/vp8", false}, {application + video, "audio/opus", false},
		{application + video + video, "video/vp8", false}, {application + application, "video/vp8", false},
		{application + "m=unknown 9 RTP/SAVPF 96\r\n", "video/vp8", false},
	} {
		if sourceOfferShape(test.sdp, test.codec) != test.allowed {
			t.Fatal("incorrect SDP media scope")
		}
	}
	_, lease, _ := trustedSourceFixture(t)
	input := sourcePeerMessage(lease, "v=0\r\n"+application+video)
	decoded, err := decodeServerMessage(sourceSignalBytes(input))
	if err != nil || decoded.SourceSignal == nil || decoded.SourceControl != nil || decoded.Type != input.Type || *decoded.SourceSignal.Description != *input.Description {
		t.Fatal("source signal was not dispatched to its dedicated parser", err)
	}
}
