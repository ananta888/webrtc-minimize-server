package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/pion/rtcp"
	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"
)

type mediaAgent struct {
	cfg    config
	api    *webrtc.API
	mu     sync.RWMutex
	rooms  map[string]*mediaRoom
	signal controlSender
}

type controlSender interface{ send(any) error }

type mediaRoom struct {
	agent             *mediaAgent
	mu                sync.RWMutex
	id                string
	role              string
	membershipEpoch   int64
	routeEpoch        int64
	expiresAt         time.Time
	iceServers        []webrtc.ICEServer
	allowedPeers      map[string]bool
	allowedPublishers map[string]bool
	peers             map[string]*mediaPeer
	tracks            map[string]*forwardTrack
	budget            bitrateBudget
	closed            bool
}

type mediaPeer struct {
	room              *mediaRoom
	id                string
	pc                *webrtc.PeerConnection
	mu                sync.Mutex
	pendingCandidates []webrtc.ICECandidateInit
	ignoreOffer       bool
	closed            bool
}

type forwardTrack struct {
	room          *mediaRoom
	publisherID   string
	publicationID string
	remote        *webrtc.TrackRemote
	local         *webrtc.TrackLocalStaticRTP
	queue         chan *rtp.Packet
	done          chan struct{}
	mu            sync.Mutex
	senders       map[string]*webrtc.RTPSender
	closed        bool
}

type bitrateBudget struct {
	mu     sync.Mutex
	window time.Time
	bytes  int64
	limit  int64
}

func newMediaAgent(cfg config, api *webrtc.API) *mediaAgent {
	return &mediaAgent{cfg: cfg, api: api, rooms: map[string]*mediaRoom{}}
}

func (a *mediaAgent) setSignaling(signal controlSender) { a.signal = signal }

func (a *mediaAgent) applySync(leases []agentLease, now time.Time) error {
	if len(leases) > a.cfg.maxRooms {
		return fmt.Errorf("agent sync exceeds room limit")
	}
	validated := make(map[string]agentLease, len(leases))
	for _, lease := range leases {
		if err := validateLease(lease, now, a.cfg); err != nil {
			return err
		}
		if _, exists := validated[lease.RoomID]; exists {
			return fmt.Errorf("duplicate room lease")
		}
		validated[lease.RoomID] = lease
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	for roomID, room := range a.rooms {
		lease, exists := validated[roomID]
		if !exists || lease.RouteEpoch != room.routeEpoch || lease.MembershipEpoch != room.membershipEpoch {
			room.close()
			delete(a.rooms, roomID)
		}
	}
	for roomID, lease := range validated {
		room := a.rooms[roomID]
		if room == nil {
			room = &mediaRoom{
				agent:             a,
				id:                roomID,
				role:              lease.Role,
				membershipEpoch:   lease.MembershipEpoch,
				routeEpoch:        lease.RouteEpoch,
				expiresAt:         time.UnixMilli(lease.LeaseExpiresAt),
				iceServers:        append([]webrtc.ICEServer(nil), lease.ICEServers...),
				allowedPeers:      map[string]bool{},
				allowedPublishers: map[string]bool{},
				peers:             map[string]*mediaPeer{},
				tracks:            map[string]*forwardTrack{},
				budget:            bitrateBudget{limit: a.cfg.maxBitrate / 8},
			}
			a.rooms[roomID] = room
		}
		room.updateLease(lease)
	}
	return nil
}

func (a *mediaAgent) handleSignal(message serverMessage) error {
	if !roomIDPattern.MatchString(message.RoomID) || !peerIDPattern.MatchString(message.PeerID) ||
		message.RouteEpoch < 1 || (message.Description == nil) == (len(message.Candidate) == 0) {
		return fmt.Errorf("invalid peer signal")
	}
	a.mu.RLock()
	room := a.rooms[message.RoomID]
	a.mu.RUnlock()
	if room == nil {
		return fmt.Errorf("room lease unavailable")
	}
	return room.handleSignal(message)
}

func (a *mediaAgent) heartbeats() []roomHeartbeat {
	now := time.Now()
	a.mu.RLock()
	defer a.mu.RUnlock()
	result := make([]roomHeartbeat, 0, len(a.rooms))
	for _, room := range a.rooms {
		room.mu.RLock()
		if !room.closed && room.expiresAt.After(now) {
			result = append(result, roomHeartbeat{RoomID: room.id, RouteEpoch: room.routeEpoch})
		}
		room.mu.RUnlock()
	}
	return result
}

func (a *mediaAgent) loadPercent() int {
	a.mu.RLock()
	defer a.mu.RUnlock()
	load := a.cfg.load
	load = max(load, percent(len(a.rooms), a.cfg.maxRooms))
	for _, room := range a.rooms {
		room.mu.RLock()
		load = max(load, percent(len(room.peers), a.cfg.maxPeers))
		load = max(load, percent(len(room.tracks), a.cfg.maxTracks))
		room.mu.RUnlock()
	}
	return min(100, load)
}

func percent(value, maximum int) int {
	if value <= 0 || maximum <= 0 {
		return 0
	}
	return min(100, (value*100+maximum-1)/maximum)
}

func (a *mediaAgent) prune(ctx context.Context) {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case now := <-ticker.C:
			a.mu.Lock()
			for roomID, room := range a.rooms {
				room.mu.RLock()
				expired := !room.expiresAt.After(now)
				room.mu.RUnlock()
				if expired {
					room.close()
					delete(a.rooms, roomID)
				}
			}
			a.mu.Unlock()
		}
	}
}

func (a *mediaAgent) close() {
	a.mu.Lock()
	defer a.mu.Unlock()
	for roomID, room := range a.rooms {
		room.close()
		delete(a.rooms, roomID)
	}
}

func (r *mediaRoom) updateLease(lease agentLease) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.closed {
		return
	}
	r.role = lease.Role
	r.expiresAt = time.UnixMilli(lease.LeaseExpiresAt)
	r.iceServers = append(r.iceServers[:0], lease.ICEServers...)
	allowed := make(map[string]bool, len(lease.Peers))
	publishers := make(map[string]bool, len(lease.Peers))
	for _, peer := range lease.Peers {
		allowed[peer.ID] = true
		if peer.Publish || (lease.Version == 1 && lease.Role == "primary") {
			publishers[peer.ID] = true
		}
	}
	for peerID, peer := range r.peers {
		if !allowed[peerID] {
			peer.close()
			delete(r.peers, peerID)
		}
	}
	r.allowedPeers = allowed
	r.allowedPublishers = publishers
}

func (r *mediaRoom) handleSignal(message serverMessage) error {
	r.mu.Lock()
	if r.closed || r.routeEpoch != message.RouteEpoch || time.Now().After(r.expiresAt) ||
		!r.allowedPeers[message.PeerID] {
		r.mu.Unlock()
		return fmt.Errorf("stale room route")
	}
	peer := r.peers[message.PeerID]
	if peer == nil {
		var err error
		peer, err = r.newPeer(message.PeerID)
		if err != nil {
			r.mu.Unlock()
			return err
		}
		r.peers[message.PeerID] = peer
	}
	r.mu.Unlock()
	return peer.acceptSignal(message)
}

func (r *mediaRoom) newPeer(peerID string) (*mediaPeer, error) {
	pc, err := r.agent.api.NewPeerConnection(webrtc.Configuration{ICEServers: append([]webrtc.ICEServer(nil), r.iceServers...)})
	if err != nil {
		return nil, fmt.Errorf("create peer connection: %w", err)
	}
	peer := &mediaPeer{room: r, id: peerID, pc: pc}
	pc.OnICECandidate(func(candidate *webrtc.ICECandidate) {
		var value any = nil
		if candidate != nil {
			value = candidate.ToJSON()
		}
		_ = r.agent.signal.send(map[string]any{
			"type": "media-agent-signal", "roomId": r.id, "peerId": peerID,
			"routeEpoch": r.routeEpoch, "candidate": value,
		})
	})
	pc.OnConnectionStateChange(func(state webrtc.PeerConnectionState) {
		connected := state == webrtc.PeerConnectionStateConnected
		if connected || state == webrtc.PeerConnectionStateFailed || state == webrtc.PeerConnectionStateClosed {
			_ = r.agent.signal.send(map[string]any{
				"type": "peer-state", "roomId": r.id, "peerId": peerID,
				"routeEpoch": r.routeEpoch, "connected": connected,
			})
		}
		if state == webrtc.PeerConnectionStateFailed {
			peer.close()
		}
	})
	pc.OnTrack(func(track *webrtc.TrackRemote, _ *webrtc.RTPReceiver) { r.acceptTrack(peer, track) })
	return peer, nil
}

func (p *mediaPeer) acceptSignal(message serverMessage) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.closed {
		return fmt.Errorf("peer connection closed")
	}
	if len(message.Candidate) > 0 {
		if p.ignoreOffer {
			return nil
		}
		if bytes.Equal(bytes.TrimSpace(message.Candidate), []byte("null")) {
			return nil
		}
		var candidate webrtc.ICECandidateInit
		if err := json.Unmarshal(message.Candidate, &candidate); err != nil {
			return fmt.Errorf("invalid ICE candidate")
		}
		if p.pc.RemoteDescription() == nil {
			if len(p.pendingCandidates) >= 256 {
				return fmt.Errorf("candidate queue full")
			}
			p.pendingCandidates = append(p.pendingCandidates, candidate)
			return nil
		}
		return p.pc.AddICECandidate(candidate)
	}
	description := *message.Description
	if description.Type == webrtc.SDPTypeOffer && p.pc.SignalingState() != webrtc.SignalingStateStable {
		// The browser side is always polite. This native endpoint is therefore
		// the impolite Perfect-Negotiation peer and keeps its outstanding offer.
		p.ignoreOffer = true
		return nil
	}
	p.ignoreOffer = false
	if err := p.pc.SetRemoteDescription(description); err != nil {
		return fmt.Errorf("set remote description: %w", err)
	}
	for _, candidate := range p.pendingCandidates {
		if err := p.pc.AddICECandidate(candidate); err != nil {
			return fmt.Errorf("apply queued candidate: %w", err)
		}
	}
	p.pendingCandidates = nil
	if description.Type == webrtc.SDPTypeOffer {
		answer, err := p.pc.CreateAnswer(nil)
		if err != nil {
			return fmt.Errorf("create answer: %w", err)
		}
		if err = p.pc.SetLocalDescription(answer); err != nil {
			return fmt.Errorf("set local answer: %w", err)
		}
		if err = p.room.agent.signal.send(map[string]any{
			"type": "media-agent-signal", "roomId": p.room.id, "peerId": p.id,
			"routeEpoch": p.room.routeEpoch, "description": answer,
		}); err != nil {
			return err
		}
		go p.room.attachExistingTracks(p)
	}
	return nil
}

func (p *mediaPeer) negotiate() {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.closed || p.pc.SignalingState() != webrtc.SignalingStateStable {
		return
	}
	offer, err := p.pc.CreateOffer(nil)
	if err != nil {
		return
	}
	if err = p.pc.SetLocalDescription(offer); err != nil {
		return
	}
	_ = p.room.agent.signal.send(map[string]any{
		"type": "media-agent-signal", "roomId": p.room.id, "peerId": p.id,
		"routeEpoch": p.room.routeEpoch, "description": offer,
	})
}

func (p *mediaPeer) close() {
	p.mu.Lock()
	if p.closed {
		p.mu.Unlock()
		return
	}
	p.closed = true
	p.pendingCandidates = nil
	p.mu.Unlock()
	_ = p.pc.Close()
}

func (r *mediaRoom) acceptTrack(peer *mediaPeer, remote *webrtc.TrackRemote) {
	if !trackIDPattern.MatchString(remote.ID()) {
		return
	}
	r.mu.Lock()
	if r.closed || len(r.tracks) >= r.agent.cfg.maxTracks || !r.allowedPeers[peer.id] || !r.allowedPublishers[peer.id] {
		r.mu.Unlock()
		return
	}
	key := peer.id + "\x00" + remote.ID()
	if _, exists := r.tracks[key]; exists {
		r.mu.Unlock()
		return
	}
	local, err := webrtc.NewTrackLocalStaticRTP(remote.Codec().RTPCodecCapability, remote.ID(), peer.id)
	if err != nil {
		r.mu.Unlock()
		return
	}
	forward := &forwardTrack{
		room: r, publisherID: peer.id, publicationID: remote.ID(), remote: remote, local: local,
		queue: make(chan *rtp.Packet, r.agent.cfg.trackQueue), done: make(chan struct{}),
		senders: map[string]*webrtc.RTPSender{},
	}
	r.tracks[key] = forward
	peers := make([]*mediaPeer, 0, len(r.peers))
	for _, target := range r.peers {
		if target.id != peer.id {
			peers = append(peers, target)
		}
	}
	r.mu.Unlock()
	for _, target := range peers {
		forward.attach(target)
	}
	_ = r.agent.signal.send(map[string]any{
		"type": "track-state", "roomId": r.id, "peerId": peer.id,
		"routeEpoch": r.routeEpoch, "publicationId": remote.ID(), "active": true,
	})
	go forward.writeLoop()
	go forward.readLoop()
}

func (r *mediaRoom) attachExistingTracks(peer *mediaPeer) {
	r.mu.RLock()
	tracks := make([]*forwardTrack, 0, len(r.tracks))
	for _, track := range r.tracks {
		if track.publisherID != peer.id {
			tracks = append(tracks, track)
		}
	}
	r.mu.RUnlock()
	for _, track := range tracks {
		track.attach(peer)
	}
}

func (f *forwardTrack) attach(peer *mediaPeer) {
	f.mu.Lock()
	if f.closed || f.senders[peer.id] != nil {
		f.mu.Unlock()
		return
	}
	sender, err := peer.pc.AddTrack(f.local)
	if err != nil {
		f.mu.Unlock()
		return
	}
	f.senders[peer.id] = sender
	f.mu.Unlock()
	go f.readFeedback(peer, sender)
	go peer.negotiate()
}

func (f *forwardTrack) readFeedback(_ *mediaPeer, sender *webrtc.RTPSender) {
	for {
		packets, _, err := sender.ReadRTCP()
		if err != nil {
			return
		}
		requestKeyframe := false
		for _, packet := range packets {
			switch packet.(type) {
			case *rtcp.PictureLossIndication, *rtcp.FullIntraRequest:
				requestKeyframe = true
			}
		}
		if requestKeyframe {
			f.room.mu.RLock()
			publisher := f.room.peers[f.publisherID]
			f.room.mu.RUnlock()
			if publisher != nil {
				_ = publisher.pc.WriteRTCP([]rtcp.Packet{&rtcp.PictureLossIndication{MediaSSRC: uint32(f.remote.SSRC())}})
			}
		}
	}
}

func (f *forwardTrack) readLoop() {
	defer f.close()
	for {
		packet, _, err := f.remote.ReadRTP()
		if err != nil {
			return
		}
		cloned, err := cloneRTPPacket(packet, f.room.agent.cfg.maxPacketBytes)
		if err != nil || !f.room.budget.allow(len(cloned.Payload), time.Now()) {
			continue
		}
		select {
		case f.queue <- cloned:
		default:
			select {
			case <-f.queue:
			default:
			}
			select {
			case f.queue <- cloned:
			default:
			}
		}
	}
}

func (f *forwardTrack) writeLoop() {
	keyframe := time.NewTicker(3 * time.Second)
	defer keyframe.Stop()
	for {
		select {
		case <-f.done:
			return
		case packet := <-f.queue:
			if packet != nil {
				_ = f.local.WriteRTP(packet)
			}
		case <-keyframe.C:
			if f.remote.Kind() == webrtc.RTPCodecTypeVideo {
				f.room.mu.RLock()
				publisher := f.room.peers[f.publisherID]
				f.room.mu.RUnlock()
				if publisher != nil {
					_ = publisher.pc.WriteRTCP([]rtcp.Packet{&rtcp.PictureLossIndication{MediaSSRC: uint32(f.remote.SSRC())}})
				}
			}
		}
	}
}

func (f *forwardTrack) close() {
	f.mu.Lock()
	if f.closed {
		f.mu.Unlock()
		return
	}
	f.closed = true
	close(f.done)
	senders := make(map[string]*webrtc.RTPSender, len(f.senders))
	for id, sender := range f.senders {
		senders[id] = sender
	}
	f.senders = map[string]*webrtc.RTPSender{}
	f.mu.Unlock()
	f.room.mu.Lock()
	delete(f.room.tracks, f.publisherID+"\x00"+f.publicationID)
	peers := make(map[string]*mediaPeer, len(f.room.peers))
	for id, peer := range f.room.peers {
		peers[id] = peer
	}
	f.room.mu.Unlock()
	for peerID, sender := range senders {
		if peer := peers[peerID]; peer != nil {
			_ = peer.pc.RemoveTrack(sender)
			go peer.negotiate()
		}
	}
	_ = f.room.agent.signal.send(map[string]any{
		"type": "track-state", "roomId": f.room.id, "peerId": f.publisherID,
		"routeEpoch": f.room.routeEpoch, "publicationId": f.publicationID, "active": false,
	})
}

func (r *mediaRoom) close() {
	r.mu.Lock()
	if r.closed {
		r.mu.Unlock()
		return
	}
	r.closed = true
	tracks := make([]*forwardTrack, 0, len(r.tracks))
	for _, track := range r.tracks {
		tracks = append(tracks, track)
	}
	peers := make([]*mediaPeer, 0, len(r.peers))
	for _, peer := range r.peers {
		peers = append(peers, peer)
	}
	r.tracks = map[string]*forwardTrack{}
	r.peers = map[string]*mediaPeer{}
	r.allowedPeers = map[string]bool{}
	r.allowedPublishers = map[string]bool{}
	r.mu.Unlock()
	for _, track := range tracks {
		track.close()
	}
	for _, peer := range peers {
		peer.close()
	}
}

func cloneRTPPacket(packet *rtp.Packet, maximum int) (*rtp.Packet, error) {
	if packet == nil {
		return nil, errors.New("nil RTP packet")
	}
	raw, err := packet.Marshal()
	if err != nil {
		return nil, err
	}
	if len(raw) > maximum {
		return nil, errors.New("RTP packet exceeds limit")
	}
	clone := &rtp.Packet{}
	if err = clone.Unmarshal(raw); err != nil {
		return nil, err
	}
	return clone, nil
}

func (b *bitrateBudget) allow(bytes int, now time.Time) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.window.IsZero() || now.Sub(b.window) >= time.Second {
		b.window = now
		b.bytes = 0
	}
	if bytes < 0 || b.bytes+int64(bytes) > b.limit {
		return false
	}
	b.bytes += int64(bytes)
	return true
}
