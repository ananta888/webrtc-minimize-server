package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"
)

type federationPeer struct {
	room              *mediaRoom
	link              federationLink
	remoteAgentID     string
	pc                *webrtc.PeerConnection
	mu                sync.Mutex
	pendingCandidates []webrtc.ICECandidateInit
	senders           map[string]*federationForward
	control           *webrtc.DataChannel
	makingOffer       bool
	ignoreOffer       bool
	needsNegotiation  bool
	remoteHello       bool
	remoteAck         bool
	ready             bool
	closed            bool
	done              chan struct{}
	closeOnce         sync.Once
	lastStatsSequence int64
	statsSequence     atomic.Int64
	receivedPackets   atomic.Int64
	forwardedPackets  atomic.Int64
	droppedPackets    atomic.Int64
}

type federationForward struct {
	sender *webrtc.RTPSender
	layer  *forwardLayer
}

func federationDemandKey(demand federationDemand) string {
	return demand.LinkID + "\x00" + demand.FromAgentID + "\x00" + demand.ToAgentID + "\x00" +
		demand.PublisherPeerID + "\x00" + demand.PublicationID + "\x00" + demand.Layer
}

func federationTrackKey(publisherPeerID, publicationID, layer string) string {
	return publisherPeerID + "\x00" + publicationID + "\x00" + layer
}

func federationStreamID(publisherPeerID, layer string) string {
	return "fed:" + publisherPeerID + ":" + layer
}

func parseFederationStreamID(value string) (string, string, bool) {
	parts := strings.Split(value, ":")
	if len(parts) != 3 || parts[0] != "fed" || !peerIDPattern.MatchString(parts[1]) ||
		!oneOf(parts[2], "audio", "single", "low", "medium", "high") {
		return "", "", false
	}
	return parts[1], parts[2], true
}

func (r *mediaRoom) syncFederation(links []federationLink) {
	desired := make(map[string]federationLink, len(links))
	for _, link := range links {
		desired[link.LinkID] = link
	}
	r.mu.Lock()
	stale := make([]*federationPeer, 0)
	for linkID, peer := range r.federationLinks {
		link, exists := desired[linkID]
		if !exists || peer.link != link {
			delete(r.federationLinks, linkID)
			stale = append(stale, peer)
		}
	}
	missing := make([]federationLink, 0)
	for linkID, link := range desired {
		if r.federationLinks[linkID] == nil {
			missing = append(missing, link)
		}
	}
	r.mu.Unlock()
	for _, peer := range stale {
		peer.close(true)
	}
	for _, link := range missing {
		peer, err := r.newFederationPeer(link)
		if err != nil {
			continue
		}
		r.mu.Lock()
		if r.closed || r.federationLinks[link.LinkID] != nil {
			r.mu.Unlock()
			peer.close(false)
			continue
		}
		r.federationLinks[link.LinkID] = peer
		r.mu.Unlock()
	}
}

func (r *mediaRoom) newFederationPeer(link federationLink) (*federationPeer, error) {
	remoteAgentID := link.LeftAgentID
	if remoteAgentID == r.agent.cfg.agentID {
		remoteAgentID = link.RightAgentID
	}
	if remoteAgentID == r.agent.cfg.agentID {
		return nil, fmt.Errorf("invalid federation self link")
	}
	r.mu.RLock()
	iceServers := append([]webrtc.ICEServer(nil), r.iceServers...)
	r.mu.RUnlock()
	pc, err := r.agent.api.NewPeerConnection(webrtc.Configuration{ICEServers: iceServers})
	if err != nil {
		return nil, fmt.Errorf("create federation peer connection: %w", err)
	}
	peer := &federationPeer{
		room: r, link: link, remoteAgentID: remoteAgentID, pc: pc,
		senders: map[string]*federationForward{}, done: make(chan struct{}),
	}
	pc.OnICECandidate(func(candidate *webrtc.ICECandidate) {
		var value any = nil
		if candidate != nil {
			value = candidate.ToJSON()
		}
		_ = r.agent.signal.send(map[string]any{
			"version": 1, "type": "federation-signal", "recipientAgentId": remoteAgentID,
			"roomId": r.id, "routeEpoch": r.routeEpoch, "linkId": link.LinkID,
			"candidate": value,
		})
	})
	pc.OnConnectionStateChange(func(state webrtc.PeerConnectionState) {
		if state == webrtc.PeerConnectionStateFailed || state == webrtc.PeerConnectionStateClosed {
			peer.close(true)
		}
	})
	pc.OnDataChannel(func(channel *webrtc.DataChannel) {
		if channel.Label() != "federation-control" {
			_ = channel.Close()
			return
		}
		peer.attachControl(channel)
	})
	pc.OnTrack(func(track *webrtc.TrackRemote, _ *webrtc.RTPReceiver) {
		go peer.acceptTrack(track)
	})
	pc.OnNegotiationNeeded(func() { go peer.negotiate() })
	if link.InitiatorAgentID == r.agent.cfg.agentID {
		control, createErr := pc.CreateDataChannel("federation-control", &webrtc.DataChannelInit{Ordered: boolPointer(true)})
		if createErr != nil {
			_ = pc.Close()
			return nil, createErr
		}
		peer.attachControl(control)
	}
	return peer, nil
}

func boolPointer(value bool) *bool { return &value }

func (a *mediaAgent) handleFederationSignal(message serverMessage) error {
	if !roomIDPattern.MatchString(message.RoomID) || !linkIDPattern.MatchString(message.LinkID) ||
		!agentIDPattern.MatchString(message.FromAgentID) || message.RouteEpoch < 1 ||
		(message.Description == nil) == (len(message.Candidate) == 0) {
		return fmt.Errorf("invalid federation signal")
	}
	a.mu.RLock()
	room := a.rooms[message.RoomID]
	a.mu.RUnlock()
	if room == nil {
		return fmt.Errorf("federation room lease unavailable")
	}
	room.mu.RLock()
	peer := room.federationLinks[message.LinkID]
	valid := peer != nil && peer.remoteAgentID == message.FromAgentID && room.routeEpoch == message.RouteEpoch
	room.mu.RUnlock()
	if !valid {
		return fmt.Errorf("stale federation link")
	}
	return peer.acceptSignal(message)
}

func (f *federationPeer) acceptSignal(message serverMessage) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.closed {
		return fmt.Errorf("federation peer closed")
	}
	if len(message.Candidate) > 0 {
		if f.ignoreOffer || bytes.Equal(bytes.TrimSpace(message.Candidate), []byte("null")) {
			return nil
		}
		var candidate webrtc.ICECandidateInit
		if err := json.Unmarshal(message.Candidate, &candidate); err != nil {
			return fmt.Errorf("invalid federation ICE candidate")
		}
		if f.pc.RemoteDescription() == nil {
			if len(f.pendingCandidates) >= 256 {
				return fmt.Errorf("federation candidate queue full")
			}
			f.pendingCandidates = append(f.pendingCandidates, candidate)
			return nil
		}
		return f.pc.AddICECandidate(candidate)
	}
	description := *message.Description
	offerCollision := description.Type == webrtc.SDPTypeOffer &&
		(f.makingOffer || f.pc.SignalingState() != webrtc.SignalingStateStable)
	polite := f.room.agent.cfg.agentID > f.remoteAgentID
	f.ignoreOffer = !polite && offerCollision
	if f.ignoreOffer {
		return nil
	}
	if offerCollision {
		if err := f.pc.SetLocalDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeRollback}); err != nil {
			return fmt.Errorf("rollback federation offer: %w", err)
		}
	}
	if err := f.pc.SetRemoteDescription(description); err != nil {
		return fmt.Errorf("set federation remote description: %w", err)
	}
	for _, candidate := range f.pendingCandidates {
		if err := f.pc.AddICECandidate(candidate); err != nil {
			return err
		}
	}
	f.pendingCandidates = nil
	if description.Type == webrtc.SDPTypeOffer {
		answer, err := f.pc.CreateAnswer(nil)
		if err != nil {
			return err
		}
		if err = f.pc.SetLocalDescription(answer); err != nil {
			return err
		}
		return f.sendSignal(map[string]any{"description": answer})
	}
	if f.needsNegotiation {
		f.needsNegotiation = false
		go f.negotiate()
	}
	return nil
}

func (f *federationPeer) negotiate() {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.closed {
		return
	}
	if f.makingOffer || f.pc.SignalingState() != webrtc.SignalingStateStable {
		f.needsNegotiation = true
		return
	}
	f.makingOffer = true
	defer func() { f.makingOffer = false }()
	offer, err := f.pc.CreateOffer(nil)
	if err != nil || f.pc.SetLocalDescription(offer) != nil {
		return
	}
	_ = f.sendSignal(map[string]any{"description": offer})
}

func (f *federationPeer) sendSignal(payload map[string]any) error {
	message := map[string]any{
		"version": 1, "type": "federation-signal", "recipientAgentId": f.remoteAgentID,
		"roomId": f.room.id, "routeEpoch": f.room.routeEpoch, "linkId": f.link.LinkID,
	}
	for key, value := range payload {
		message[key] = value
	}
	return f.room.agent.signal.send(message)
}

func (f *federationPeer) attachControl(channel *webrtc.DataChannel) {
	f.mu.Lock()
	if f.closed || f.control != nil && f.control != channel {
		f.mu.Unlock()
		_ = channel.Close()
		return
	}
	f.control = channel
	f.mu.Unlock()
	channel.OnOpen(func() {
		f.sendHello()
		go f.sendStats()
	})
	channel.OnMessage(func(message webrtc.DataChannelMessage) {
		if !message.IsString {
			f.close(true)
			return
		}
		f.acceptControl(message.Data)
	})
	channel.OnClose(func() { f.close(true) })
}

func (f *federationPeer) sendHello() {
	f.room.mu.RLock()
	expiresAt := f.room.expiresAt.UnixMilli()
	f.room.mu.RUnlock()
	_ = f.sendControl(map[string]any{
		"version": 1, "type": "federation-hello", "roomId": f.room.id,
		"routeEpoch": f.room.routeEpoch, "linkId": f.link.LinkID,
		"agentId": f.room.agent.cfg.agentID, "leaseExpiresAt": expiresAt,
	})
}

func (f *federationPeer) acceptControl(raw []byte) {
	message, err := decodeFederationControl(raw)
	if err != nil || message.RoomID != f.room.id || message.RouteEpoch != f.room.routeEpoch ||
		message.LinkID != f.link.LinkID || message.AgentID != f.remoteAgentID {
		f.close(true)
		return
	}
	f.mu.Lock()
	if f.closed {
		f.mu.Unlock()
		return
	}
	switch message.Type {
	case "federation-hello":
		f.room.mu.RLock()
		localLeaseActive := f.room.expiresAt.After(time.Now())
		f.room.mu.RUnlock()
		validRemoteLease := message.LeaseExpiresAt > time.Now().UnixMilli() &&
			message.LeaseExpiresAt <= time.Now().Add(120*time.Second).UnixMilli()
		if !localLeaseActive || !validRemoteLease {
			f.mu.Unlock()
			f.close(true)
			return
		}
		f.remoteHello = true
		f.mu.Unlock()
		_ = f.sendControl(map[string]any{
			"version": 1, "type": "federation-ack", "roomId": f.room.id,
			"routeEpoch": f.room.routeEpoch, "linkId": f.link.LinkID,
			"agentId": f.room.agent.cfg.agentID, "accepted": true,
		})
		f.markReady()
		return
	case "federation-ack":
		if !message.Accepted {
			f.mu.Unlock()
			f.close(true)
			return
		}
		f.remoteAck = true
	case "federation-stats":
		if message.Sequence <= f.lastStatsSequence {
			f.mu.Unlock()
			f.close(true)
			return
		}
		f.lastStatsSequence = message.Sequence
	}
	f.mu.Unlock()
	f.markReady()
}

func (f *federationPeer) markReady() {
	f.mu.Lock()
	becameReady := !f.closed && !f.ready && f.remoteHello && f.remoteAck
	if becameReady {
		f.ready = true
	}
	f.mu.Unlock()
	if !becameReady {
		return
	}
	_ = f.room.agent.signal.send(map[string]any{
		"version": 1, "type": "federation-state", "roomId": f.room.id, "routeEpoch": f.room.routeEpoch,
		"linkId": f.link.LinkID, "remoteAgentId": f.remoteAgentID, "connected": true,
	})
	f.room.mu.RLock()
	publications := make([]*forwardPublication, 0, len(f.room.tracks))
	for _, publication := range f.room.tracks {
		publications = append(publications, publication)
	}
	f.room.mu.RUnlock()
	for _, publication := range publications {
		publication.reconcileFederation()
	}
}

func (f *federationPeer) sendControl(value any) error {
	raw, err := json.Marshal(value)
	if err != nil || len(raw) > maximumFederationControlBytes {
		return fmt.Errorf("invalid federation control output")
	}
	f.mu.Lock()
	channel := f.control
	closed := f.closed
	f.mu.Unlock()
	if closed || channel == nil || channel.ReadyState() != webrtc.DataChannelStateOpen {
		return fmt.Errorf("federation control unavailable")
	}
	return channel.SendText(string(raw))
}

func (f *federationPeer) sendStats() {
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-f.done:
			return
		case <-ticker.C:
			_ = f.sendControl(map[string]any{
				"version": 1, "type": "federation-stats", "roomId": f.room.id,
				"routeEpoch": f.room.routeEpoch, "linkId": f.link.LinkID,
				"agentId": f.room.agent.cfg.agentID, "sequence": f.statsSequence.Add(1),
				"receivedPackets":  f.receivedPackets.Load(),
				"forwardedPackets": f.forwardedPackets.Load(),
				"droppedPackets":   f.droppedPackets.Load(),
			})
		}
	}
}

func (f *federationPeer) acceptTrack(remote *webrtc.TrackRemote) {
	publisherPeerID, layer, valid := parseFederationStreamID(remote.StreamID())
	if !valid || !trackIDPattern.MatchString(remote.ID()) {
		return
	}
	demand := federationDemand{
		LinkID: f.link.LinkID, FromAgentID: f.remoteAgentID, ToAgentID: f.room.agent.cfg.agentID,
		PublisherPeerID: publisherPeerID, PublicationID: remote.ID(), Layer: layer,
	}
	for {
		f.mu.Lock()
		ready, closed := f.ready, f.closed
		f.mu.Unlock()
		f.room.mu.RLock()
		_, authorized := f.room.federationDemands[federationDemandKey(demand)]
		leaseActive := f.room.expiresAt.After(time.Now()) && !f.room.closed
		f.room.mu.RUnlock()
		if ready && authorized {
			break
		}
		if closed || !leaseActive {
			return
		}
		select {
		case <-f.done:
			return
		case <-time.After(25 * time.Millisecond):
		}
	}
	f.room.acceptFederatedLayer(f, remote, publisherPeerID, layer)
}

func (r *mediaRoom) acceptFederatedLayer(
	input *federationPeer,
	remote *webrtc.TrackRemote,
	publisherPeerID string,
	layerName string,
) {
	r.mu.Lock()
	if r.closed || r.trackCount >= r.agent.cfg.maxTracks || !r.knownPeers[publisherPeerID] {
		r.mu.Unlock()
		return
	}
	key := publisherPeerID + "\x00" + remote.ID()
	publication := r.tracks[key]
	created := false
	if publication == nil {
		publication = &forwardPublication{
			room: r, publisherID: publisherPeerID, publicationID: remote.ID(),
			layers: map[string]*forwardLayer{}, subscribers: map[string]*subscriberForward{},
		}
		r.tracks[key] = publication
		created = true
	}
	local, err := webrtc.NewTrackLocalStaticRTP(
		remote.Codec().RTPCodecCapability,
		remote.ID(),
		publisherPeerID,
	)
	if err != nil {
		if created {
			delete(r.tracks, key)
		}
		r.mu.Unlock()
		return
	}
	federationLocal, err := webrtc.NewTrackLocalStaticRTP(
		remote.Codec().RTPCodecCapability,
		remote.ID(),
		federationStreamID(publisherPeerID, layerName),
	)
	if err != nil {
		if created {
			delete(r.tracks, key)
		}
		r.mu.Unlock()
		return
	}
	publication.mu.Lock()
	if publication.closed || publication.layers[layerName] != nil {
		publication.mu.Unlock()
		r.mu.Unlock()
		return
	}
	layer := &forwardLayer{
		publication: publication, name: layerName, rid: ridForLayer(layerName), remote: remote,
		local: local, federationLocal: federationLocal, feedbackPC: input.pc, inputFederation: input,
		federationPeers: map[string]*federationPeer{}, reported: false,
		queue: make(chan *rtp.Packet, r.agent.cfg.trackQueue), done: make(chan struct{}),
	}
	publication.layers[layerName] = layer
	publication.lastLayerAt = time.Now()
	publication.mu.Unlock()
	r.trackCount++
	r.mu.Unlock()
	publication.reconcileAll()
	publication.reconcileFederation()
	time.AfterFunc(300*time.Millisecond, publication.reconcileAll)
	go layer.writeLoop()
	go layer.readLoop()
}

func ridForLayer(layer string) string {
	return map[string]string{"low": "q", "medium": "h", "high": "f"}[layer]
}

func (p *forwardPublication) reconcileFederation() {
	p.room.mu.RLock()
	links := make([]*federationPeer, 0, len(p.room.federationLinks))
	for _, link := range p.room.federationLinks {
		links = append(links, link)
	}
	demands := make(map[string]federationDemand)
	for key, demand := range p.room.federationDemands {
		if demand.FromAgentID == p.room.agent.cfg.agentID && demand.PublisherPeerID == p.publisherID &&
			demand.PublicationID == p.publicationID {
			demands[key] = demand
		}
	}
	p.room.mu.RUnlock()
	for _, link := range links {
		for _, layerName := range []string{"audio", "single", "low", "medium", "high"} {
			demand := federationDemand{
				LinkID: link.link.LinkID, FromAgentID: p.room.agent.cfg.agentID,
				ToAgentID: link.remoteAgentID, PublisherPeerID: p.publisherID,
				PublicationID: p.publicationID, Layer: layerName,
			}
			_, needed := demands[federationDemandKey(demand)]
			link.setForward(p, layerName, needed)
		}
	}
}

func (f *federationPeer) setForward(publication *forwardPublication, layerName string, needed bool) {
	key := federationTrackKey(publication.publisherID, publication.publicationID, layerName)
	publication.mu.Lock()
	layer := publication.layers[layerName]
	publication.mu.Unlock()
	f.mu.Lock()
	current := f.senders[key]
	active := !f.closed && f.ready && needed && layer != nil
	if current != nil && active && current.layer == layer {
		f.mu.Unlock()
		return
	}
	if current != nil {
		delete(f.senders, key)
		_ = f.pc.RemoveTrack(current.sender)
		current.layer.publication.mu.Lock()
		delete(current.layer.federationPeers, f.link.LinkID)
		current.layer.publication.mu.Unlock()
	}
	if !active {
		f.mu.Unlock()
		return
	}
	sender, err := f.pc.AddTrack(layer.federationLocal)
	if err != nil {
		f.mu.Unlock()
		return
	}
	f.senders[key] = &federationForward{sender: sender, layer: layer}
	f.mu.Unlock()
	publication.mu.Lock()
	layer.federationPeers[f.link.LinkID] = f
	publication.mu.Unlock()
	go layer.readFeedback(sender)
}

func (f *federationPeer) close(announce bool) {
	f.closeOnce.Do(func() {
		f.mu.Lock()
		f.closed = true
		wasReady := f.ready
		f.ready = false
		forwards := make([]*federationForward, 0, len(f.senders))
		for _, forward := range f.senders {
			forwards = append(forwards, forward)
		}
		f.senders = map[string]*federationForward{}
		close(f.done)
		f.mu.Unlock()
		for _, forward := range forwards {
			forward.layer.publication.mu.Lock()
			delete(forward.layer.federationPeers, f.link.LinkID)
			forward.layer.publication.mu.Unlock()
		}
		_ = f.pc.Close()
		f.room.mu.Lock()
		if f.room.federationLinks[f.link.LinkID] == f {
			delete(f.room.federationLinks, f.link.LinkID)
		}
		publications := make([]*forwardPublication, 0, len(f.room.tracks))
		for _, publication := range f.room.tracks {
			publications = append(publications, publication)
		}
		f.room.mu.Unlock()
		for _, publication := range publications {
			publication.reconcileFederation()
		}
		if announce && wasReady {
			_ = f.room.agent.signal.send(map[string]any{
				"version": 1, "type": "federation-state", "roomId": f.room.id, "routeEpoch": f.room.routeEpoch,
				"linkId": f.link.LinkID, "remoteAgentId": f.remoteAgentID, "connected": false,
			})
		}
	})
}
