package main

import (
	"encoding/json"
	"errors"
	"net"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/ananta/webrtc-minimize-server/native-broadcast-packager/internal/trustedsframe"
	"github.com/pion/webrtc/v4"
)

const sourceKeyChannel = "trusted-source-keys-v1"

// A separately admitted compositor input. WriteEncoded borrows the frame only
// for this bounded nonblocking call. Close must erase held frames/queues and
// must not reenter source/client methods. No sink means no media admission.
type trustedSourceSink interface {
	WriteEncoded(codec string, timestamp uint32, frame []byte) error
	Close()
}

type trustedSourceTransport struct {
	c        *client
	lease    trustedsframe.SourceLease
	receiver *trustedsframe.SourceReceiver
	pc       *webrtc.PeerConnection
	sink     trustedSourceSink
	closed   atomic.Bool
	// Closed diagnostic enum: 1 track count, 2 track binding, 3 codec,
	// 4 RTP read, 5 source policy, 6 input budget, 7 sink. Never content/IDs.
	failure                              atomic.Int32
	done                                 chan struct{}
	signalMu                             sync.Mutex
	frameMu                              sync.Mutex
	outMu                                sync.Mutex
	negotiation, inSequence, outSequence int64
	answerSent                           bool
	pending                              []webrtc.ICECandidateInit
	endPending                           bool
	assembly                             sourceFrameAssembly
	channelSet                           atomic.Bool
	trackSet                             atomic.Bool
	trackID                              atomic.Pointer[string]
	keyMu                                sync.Mutex
	keyWindow                            time.Time
	keyCount                             int
}

func newTrustedSourceTransport(c *client, lease trustedsframe.SourceLease, receiver *trustedsframe.SourceReceiver, sink trustedSourceSink, configuration webrtc.Configuration) (*trustedSourceTransport, error) {
	if c == nil || c.api == nil || receiver == nil || sink == nil || !receiver.AliveNow() {
		return nil, errors.New("trusted source unavailable")
	}
	pc, err := c.api.NewPeerConnection(configuration)
	if err != nil {
		return nil, errors.New("source connection creation failed")
	}
	t := &trustedSourceTransport{c: c, lease: lease, receiver: receiver, pc: pc, sink: sink, done: make(chan struct{})}
	pc.OnICECandidate(t.localCandidate)
	pc.OnDataChannel(t.attachKeys)
	pc.OnTrack(func(track *webrtc.TrackRemote, _ *webrtc.RTPReceiver) {
		if t.trackSet.Swap(true) {
			t.closeWithFailure(1)
			return
		}
		if expected := t.trackID.Load(); expected == nil || track.ID() != *expected {
			t.closeWithFailure(2)
			return
		}
		if !strings.EqualFold(track.Codec().MimeType, lease.Codec) ||
			(lease.Codec == "audio/opus" && track.Codec().ClockRate != 48000) || (lease.Codec == "video/vp8" && track.Codec().ClockRate != 90000) {
			t.closeWithFailure(3)
			return
		}
		go t.readTrack(track)
	})
	pc.OnConnectionStateChange(func(state webrtc.PeerConnectionState) {
		if state == webrtc.PeerConnectionStateFailed || state == webrtc.PeerConnectionStateClosed {
			t.close()
		}
	})
	go func() { <-receiver.Done(); t.close() }()
	return t, nil
}

func (t *trustedSourceTransport) close() {
	t.closeWithFailure(0)
}

func (t *trustedSourceTransport) closeWithFailure(reason int32) {
	if t.closed.Swap(true) {
		return
	}
	t.failure.Store(reason)
	t.receiver.Destroy()
	t.frameMu.Lock()
	t.assembly.clear()
	t.sink.Close()
	t.frameMu.Unlock()
	// Pion callbacks may initiate shutdown; never wait for their own completion.
	go func() { _ = t.pc.Close(); close(t.done) }()
}

func (t *trustedSourceTransport) sendSignal(kind string, payload any) error {
	t.outSequence++
	if t.outSequence > 129 {
		return errors.New("source signal budget")
	}
	message := map[string]any{"version": 1, "type": "trusted-source-packager-signal", "sourceLeaseId": t.lease.SourceLeaseID,
		"consentId": t.lease.Consent.ConsentID, "assignmentId": t.lease.AssignmentID, "fencingRevision": t.lease.FencingRevision,
		"negotiationRevision": t.negotiation, "sequence": t.outSequence, kind: payload}
	raw, err := json.Marshal(message)
	if err != nil || len(raw) > 31*1024 {
		return errors.New("source signal size")
	}
	return t.c.send(message)
}

func (t *trustedSourceTransport) localCandidate(candidate *webrtc.ICECandidate) {
	t.outMu.Lock()
	defer t.outMu.Unlock()
	if t.closed.Load() {
		return
	}
	if !t.answerSent {
		if candidate == nil {
			t.endPending = true
			return
		}
		if len(t.pending) >= 128 {
			go t.close()
			return
		}
		t.pending = append(t.pending, candidate.ToJSON())
		return
	}
	var value any
	if candidate != nil {
		value = candidate.ToJSON()
	}
	if t.sendSignal("candidate", value) != nil {
		go t.close()
	}
}

func (t *trustedSourceTransport) handle(message *trustedsframe.SourcePeerSignal) error {
	t.signalMu.Lock()
	defer t.signalMu.Unlock()
	if t.closed.Load() || !t.receiver.AliveNow() || message.SourceLeaseID != t.lease.SourceLeaseID ||
		message.ConsentID != t.lease.Consent.ConsentID || message.AssignmentID != t.lease.AssignmentID || message.FencingRevision != t.lease.FencingRevision || message.PublisherPeerID != t.lease.PublisherPeerID {
		return errors.New("stale source signal")
	}
	t.outMu.Lock()
	if message.Description == nil {
		valid := message.NegotiationRevision == t.negotiation && message.Sequence == t.inSequence+1 && t.answerSent
		if valid {
			t.inSequence = message.Sequence
		}
		t.outMu.Unlock()
		if !valid {
			return errors.New("source candidate sequence")
		}
		candidate, err := decodeNativeCandidate(message.Candidate)
		if err != nil {
			return err
		}
		return t.pc.AddICECandidate(candidate)
	}
	trackID, trackErr := sourceOfferTrack(message.Description.SDP, t.lease.Codec)
	if trackErr != nil {
		t.outMu.Unlock()
		return errors.New("source offer scope")
	}
	if current := t.trackID.Load(); current != nil && *current != trackID {
		t.outMu.Unlock()
		return errors.New("source transport track changed")
	}
	if message.NegotiationRevision != t.negotiation+1 || message.Sequence != 1 || t.negotiation > 0 && !t.answerSent {
		t.outMu.Unlock()
		return errors.New("source offer sequence")
	}
	t.negotiation = message.NegotiationRevision
	t.inSequence = 1
	t.outSequence = 0
	t.answerSent = false
	t.pending = nil
	t.endPending = false
	if trackID != "" {
		t.trackID.Store(&trackID)
	}
	t.outMu.Unlock()
	if err := t.pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: message.Description.SDP}); err != nil {
		return errors.New("source offer rejected")
	}
	answer, err := t.pc.CreateAnswer(nil)
	if err != nil || len(answer.SDP) > 16384 {
		return errors.New("source answer failed")
	}
	if err = t.pc.SetLocalDescription(answer); err != nil {
		return errors.New("source local description failed")
	}
	t.outMu.Lock()
	defer t.outMu.Unlock()
	if err = t.sendSignal("description", answer); err != nil {
		return err
	}
	t.answerSent = true
	for _, candidate := range t.pending {
		if err = t.sendSignal("candidate", candidate); err != nil {
			return err
		}
	}
	t.pending = nil
	if t.endPending {
		t.endPending = false
		return t.sendSignal("candidate", nil)
	}
	return nil
}

func sourceOfferShape(sdp, codec string) bool {
	media, application := 0, 0
	expected := "video"
	if codec == "audio/opus" {
		expected = "audio"
	}
	for _, line := range strings.Split(sdp, "\n") {
		fields := strings.Fields(line)
		if len(fields) == 0 || !strings.HasPrefix(fields[0], "m=") {
			continue
		}
		switch strings.TrimPrefix(fields[0], "m=") {
		case "application":
			application++
		case expected:
			media++
		default:
			return false
		}
	}
	return application == 1 && media <= 1
}

func (t *trustedSourceTransport) attachKeys(channel *webrtc.DataChannel) {
	if channel.Label() != sourceKeyChannel || channel.Protocol() != sourceKeyChannel || !channel.Ordered() || channel.Negotiated() ||
		channel.MaxRetransmits() != nil || channel.MaxPacketLifeTime() != nil || t.channelSet.Swap(true) || t.closed.Load() {
		_ = channel.Close()
		t.close()
		return
	}
	channel.OnOpen(func() {
		announcement, err := t.receiver.AnnouncementNow()
		if err != nil || channel.BufferedAmount() > 16384 || channel.SendText(string(announcement)) != nil {
			t.close()
		}
	})
	channel.OnMessage(func(message webrtc.DataChannelMessage) {
		t.keyMu.Lock()
		defer t.keyMu.Unlock()
		now := time.Now()
		if now.Sub(t.keyWindow) >= time.Minute {
			t.keyWindow = now
			t.keyCount = 0
		}
		t.keyCount++
		if t.closed.Load() || !message.IsString || len(message.Data) > 8192 || t.keyCount > 120 || channel.BufferedAmount() > 16384 {
			t.close()
			return
		}
		ack, err := t.receiver.AcceptKeyNow(message.Data)
		if err != nil || channel.SendText(string(ack)) != nil {
			t.close()
		}
	})
	channel.OnClose(t.close)
	channel.OnError(func(error) { t.close() })
}

func (t *trustedSourceTransport) readTrack(track *webrtc.TrackRemote) {
	window, received, packets := time.Now(), 0, 0
	for !t.closed.Load() {
		_ = track.SetReadDeadline(time.Now().Add(250 * time.Millisecond))
		packet, _, err := track.ReadRTP()
		if err != nil {
			var timeout net.Error
			if errors.As(err, &timeout) && timeout.Timeout() && t.receiver.AliveNow() {
				t.frameMu.Lock()
				t.assembly.expire(time.Now())
				t.frameMu.Unlock()
				continue
			}
			t.closeWithFailure(4)
			return
		}
		if time.Since(window) >= time.Second {
			window, received, packets = time.Now(), 0, 0
		}
		received += len(packet.Payload)
		packets++
		if received > 8*1024*1024 || packets > 8192 {
			t.closeWithFailure(6)
			return
		}
		t.frameMu.Lock()
		if t.closed.Load() || !t.receiver.AliveNow() {
			t.frameMu.Unlock()
			t.closeWithFailure(5)
			return
		}
		var frame []byte
		if t.lease.Codec == "video/vp8" {
			frame = t.assembly.push(packet, time.Now())
		} else if len(packet.Payload) <= 65535 {
			frame = append([]byte(nil), packet.Payload...)
		}
		if len(frame) > 0 {
			plain, decryptErr := t.receiver.DecryptNow(frame)
			clear(frame)
			if decryptErr == nil && t.receiver.AliveNow() {
				err = t.sink.WriteEncoded(t.lease.Codec, packet.Timestamp, plain)
			}
			clear(plain)
		}
		t.frameMu.Unlock()
		if err != nil {
			t.closeWithFailure(7)
			return
		}
	}
}

// Key material is transported exclusively over the above DTLS/SCTP channel.
// This helper returns metadata only and is useful for exact dispatch validation.
func sourceSignalBytes(message *trustedsframe.SourcePeerSignal) []byte {
	raw, _ := json.Marshal(message)
	return raw
}
