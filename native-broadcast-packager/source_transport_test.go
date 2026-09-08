package main

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdh"
	"crypto/hkdf"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"sync/atomic"
	"testing"
	"time"

	"github.com/ananta/webrtc-minimize-server/native-broadcast-packager/internal/trustedsframe"
	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"
)

type sourceTestSink struct {
	frames chan []byte
	closed atomic.Int32
}

func (s *sourceTestSink) WriteEncoded(_ string, _ uint32, frame []byte) error {
	if s.closed.Load() != 0 {
		return errors.New("closed test sink")
	}
	select {
	case s.frames <- bytes.Clone(frame):
		return nil
	default:
		return errors.New("full test sink")
	}
}
func (s *sourceTestSink) Close() {
	s.closed.Add(1)
	for {
		select {
		case frame := <-s.frames:
			clear(frame)
		default:
			return
		}
	}
}
func awaitSource[T any](t *testing.T, ch <-chan T) T {
	t.Helper()
	select {
	case value := <-ch:
		return value
	case <-time.After(3 * time.Second):
		t.Fatal("bounded source observation expired")
		var zero T
		return zero
	}
}
func sourcePeerMessage(lease trustedsframe.SourceLease, sdp string) *trustedsframe.SourcePeerSignal {
	return &trustedsframe.SourcePeerSignal{Version: 1, Type: "trusted-source-peer-signal", SourceLeaseID: lease.SourceLeaseID,
		ConsentID: lease.Consent.ConsentID, AssignmentID: lease.AssignmentID, FencingRevision: lease.FencingRevision, PublisherPeerID: lease.PublisherPeerID,
		NegotiationRevision: 1, Sequence: 1, Description: &trustedsframe.SourceDescription{Type: "offer", SDP: sdp}}
}

// Synthetic test keys, never a production key export API.
var sourceTestBase = []byte{0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15}

func sourceTestEnvelope(t *testing.T, lease trustedsframe.SourceLease, raw []byte) []byte {
	t.Helper()
	var announcement struct {
		AgreementKeyID string                `json:"agreementKeyId"`
		PublicKey      struct{ X, Y string } `json:"publicKey"`
	}
	if json.Unmarshal(raw, &announcement) != nil || announcement.AgreementKeyID == "" {
		t.Fatal("missing real native announcement")
	}
	x, _ := base64.RawURLEncoding.DecodeString(announcement.PublicKey.X)
	y, _ := base64.RawURLEncoding.DecodeString(announcement.PublicKey.Y)
	public, err := ecdh.P256().NewPublicKey(append(append([]byte{4}, x...), y...))
	if err != nil {
		t.Fatal(err)
	}
	private, err := ecdh.P256().GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	shared, err := private.ECDH(public)
	if err != nil {
		t.Fatal(err)
	}
	defer clear(shared)
	blk, _ := aes.NewCipher(shared)
	wrap, _ := cipher.NewGCM(blk)
	c := lease.Consent
	now := time.Now().UnixMilli()
	expires := min(now+30000, c.ExpiresAt)
	e := map[string]any{"version": 1, "type": "trusted-decrypt-key", "envelopeId": "aaaaaaaaaaaaaaaaaaaaaaaa", "consentId": c.ConsentID, "tenantId": c.TenantID,
		"roomId": c.RoomID, "roomEpoch": c.RoomEpoch, "programId": c.ProgramID, "programEpoch": c.ProgramEpoch, "grantorSubjectRef": c.GrantorSubjectRef,
		"granteePackagerRef": c.GranteePackagerRef, "granteeDeviceRef": c.GranteeDeviceRef, "sourceId": c.SourceID, "sourceKind": c.SourceKind,
		"purpose": c.Purpose, "keyId": "0000000000000123", "frameEnvelope": trustedsframe.Envelope, "agreementKeyId": announcement.AgreementKeyID, "createdAt": now, "expiresAt": expires}
	order := []string{"version", "type", "envelopeId", "consentId", "tenantId", "roomId", "roomEpoch", "programId", "programEpoch", "grantorSubjectRef", "granteePackagerRef", "granteeDeviceRef", "sourceId", "sourceKind", "purpose", "keyId", "frameEnvelope", "agreementKeyId", "createdAt", "expiresAt"}
	values := make([]any, len(order))
	for i, key := range order {
		values[i] = e[key]
	}
	aad, _ := json.Marshal(values)
	nonce := make([]byte, 12)
	rand.Read(nonce)
	key := private.PublicKey().Bytes()
	e["senderPublicKey"] = map[string]any{"kty": "EC", "crv": "P-256", "x": base64.RawURLEncoding.EncodeToString(key[1:33]), "y": base64.RawURLEncoding.EncodeToString(key[33:]), "ext": true, "key_ops": []string{}}
	e["nonce"] = base64.RawURLEncoding.EncodeToString(nonce)
	e["ciphertext"] = base64.RawURLEncoding.EncodeToString(wrap.Seal(nil, nonce, sourceTestBase, aad))
	result, _ := json.Marshal(e)
	return result
}
func sourceTestFrame(t *testing.T, codec string, counter uint64) ([]byte, []byte) {
	t.Helper()
	var suffix [10]byte
	binary.BigEndian.PutUint64(suffix[:8], 291)
	binary.BigEndian.PutUint16(suffix[8:], 4)
	key, err := hkdf.Key(sha256.New, sourceTestBase, nil, "SFrame 1.0 Secret key "+string(suffix[:]), 16)
	if err != nil {
		t.Fatal(err)
	}
	salt, _ := hkdf.Key(sha256.New, sourceTestBase, nil, "SFrame 1.0 Secret salt "+string(suffix[:]), 12)
	blk, _ := aes.NewCipher(key)
	aead, _ := cipher.NewGCM(blk)
	clear(key)
	header := []byte{0x90, 1, 0x23}
	if counter <= 7 {
		header[0] |= byte(counter)
	} else if counter <= 255 {
		header[0] |= 8
		header = append(header, byte(counter))
	} else {
		header[0] |= 9
		header = append(header, byte(counter>>8), byte(counter))
	}
	prefix, metadata := []byte{1, 0, 0}, []byte{0x53, 0x46, 1, 1}
	if codec == "audio/opus" {
		prefix = []byte{0x78}
		metadata[3] = 2
	}
	repetitions := 500 // VP8 deliberately exercises fragmentation.
	if codec == "audio/opus" {
		repetitions = 80 // Opus is one RTP packet, including the SFrame overhead.
	}
	payload := bytes.Repeat([]byte{byte(counter), 42, 43}, repetitions)
	aad := append(append(bytes.Clone(header), metadata...), prefix...)
	for i, v := 11, counter; v > 0; i, v = i-1, v>>8 {
		salt[i] ^= byte(v)
	}
	wire := append(append(append(bytes.Clone(prefix), metadata...), header...), aead.Seal(nil, salt, payload, aad)...)
	return wire, append(bytes.Clone(prefix), payload...)
}

func TestTrustedSourceRealKeyChannelAndRTP(t *testing.T) {
	for _, codec := range []string{"video/vp8", "audio/opus"} {
		t.Run(codec, func(t *testing.T) {
			c, lease, now := trustedSourceFixture(t)
			lease.ExpiresAt = now.Add(4 * time.Second).UnixMilli()
			lease.Codec = codec
			if codec == "audio/opus" {
				lease.Consent.SourceKind = "microphone"
			}
			api, err := createWebRTCAPI()
			if err != nil {
				t.Fatal(err)
			}
			c.api = api
			sink := &sourceTestSink{frames: make(chan []byte, 8)}
			c.trustedSourceSinkFactory = func(trustedsframe.SourceLease, *trustedsframe.SourceReceiver) (trustedSourceSink, error) {
				return sink, nil
			}
			receiver, err := c.prepareTrustedSource(sourceBytes(t, lease), now)
			if err != nil {
				t.Fatal(err)
			}
			peer, err := api.NewPeerConnection(webrtc.Configuration{})
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { peer.Close() })
			protocol := sourceKeyChannel
			channel, err := peer.CreateDataChannel(sourceKeyChannel, &webrtc.DataChannelInit{Protocol: &protocol})
			if err != nil {
				t.Fatal(err)
			}
			keyMessages := make(chan []byte, 8)
			channel.OnMessage(func(message webrtc.DataChannelMessage) { keyMessages <- bytes.Clone(message.Data) })
			cap := webrtc.RTPCodecCapability{MimeType: codec, ClockRate: 90000}
			if codec == "audio/opus" {
				cap.ClockRate = 48000
				cap.Channels = 2
			}
			track, err := webrtc.NewTrackLocalStaticRTP(cap, lease.PublicationID, "synthetic-source")
			if err != nil {
				t.Fatal(err)
			}
			sender, err := peer.AddTrack(track)
			if err != nil {
				t.Fatal(err)
			}
			go func() {
				for {
					if _, _, err := sender.ReadRTCP(); err != nil {
						return
					}
				}
			}()
			messages := make(chan map[string]any, 256)
			stop := make(chan struct{})
			t.Cleanup(func() { close(stop) })
			c.sendOverride = func(value any) error {
				select {
				case messages <- value.(map[string]any):
					return nil
				case <-stop:
					return nil
				}
			}
			controlErrors := make(chan error, 1)
			go func() {
				for {
					select {
					case <-stop:
						return
					case message := <-messages:
						if message["type"] != "trusted-source-packager-signal" {
							continue
						}
						if value, ok := message["description"]; ok {
							raw, _ := json.Marshal(value)
							var desc webrtc.SessionDescription
							json.Unmarshal(raw, &desc)
							if err := peer.SetRemoteDescription(desc); err != nil {
								controlErrors <- err
								return
							}
						}
						if value, ok := message["candidate"]; ok {
							raw, _ := json.Marshal(value)
							candidate, err := decodeNativeCandidate(raw)
							if err == nil {
								err = peer.AddICECandidate(candidate)
							}
							if err != nil {
								controlErrors <- err
								return
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
			announcement := awaitSource(t, keyMessages)
			if err = channel.SendText(string(sourceTestEnvelope(t, lease, announcement))); err != nil {
				t.Fatal(err)
			}
			ack := awaitSource(t, keyMessages)
			var fields map[string]any
			json.Unmarshal(ack, &fields)
			if fields["type"] != "trusted-source-key-ack" || fields["state"] != "key-installed" || fields["sourceLeaseId"] != lease.SourceLeaseID {
				t.Fatal("missing bound key ACK")
			}
			lease.Revision++
			lease.IssuedAt = time.Now().UnixMilli()
			lease.ExpiresAt = lease.IssuedAt + 5000
			command := &trustedsframe.SourceCommand{Version: 1, Type: "trusted-source-prepare", Lease: sourceBytes(t, lease)}
			// Dispatch began before the key channel advanced the crypto clock.
			if err = c.handleTrustedSourceControl(command, now); err != nil || !receiver.AliveNow() {
				t.Fatal(err)
			}
			var sequence uint16
			write := func(wire []byte, counter uint64) {
				t.Helper()
				packets := sourcePackets(wire, uint32(counter*3000))
				if codec == "audio/opus" {
					packets = []*rtp.Packet{{Header: rtp.Header{Version: 2, Timestamp: uint32(counter * 960), Marker: true}, Payload: wire}}
				}
				for _, packet := range packets {
					packet.SequenceNumber = sequence
					sequence++
					if err := track.WriteRTP(packet); err != nil {
						t.Fatal(err)
					}
				}
			}
			for counter := uint64(0); counter <= 400; counter++ {
				if counter == 200 {
					// Low-FPS screens and Opus DTX may legitimately pause longer
					// than the assembly read deadline without losing source consent.
					time.Sleep(350 * time.Millisecond)
				}
				wire, plain := sourceTestFrame(t, codec, counter)
				if counter == 350 {
					replay, _ := sourceTestFrame(t, codec, counter-1)
					write(replay, counter) // Fresh RTP sequence cannot bypass SFrame replay.
					corrupt := bytes.Clone(wire)
					corrupt[len(corrupt)-1] ^= 1
					write(corrupt, counter)
				}
				write(wire, counter)
				if !bytes.Equal(awaitSource(t, sink.frames), plain) {
					t.Fatal("authenticated RTP frame mismatch")
				}
			}
			select {
			case err := <-controlErrors:
				t.Fatal(err)
			default:
			}
			c.sourcesMu.Lock()
			transport := c.trustedSources[lease.SourceLeaseID].transport
			c.sourcesMu.Unlock()
			c.closeTrustedSources()
			awaitSource(t, transport.done)
			if sink.closed.Load() != 1 || receiver.AliveNow() || c.assignment.State != "running" {
				t.Fatal("source cleanup disturbed parent or retained media")
			}
		})
	}
}
