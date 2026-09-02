package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
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
	knownPeers        map[string]bool
	allowedPublishers map[string]bool
	peers             map[string]*mediaPeer
	tracks            map[string]*forwardPublication
	trackCount        int
	subscriptions     map[string]subscriptionPlan
	federationLinks   map[string]*federationPeer
	federationRoutes  map[string]federationRoute
	federationDemands map[string]federationDemand
	budget            bitrateBudget
	closed            bool
}

type mediaPeer struct {
	room              *mediaRoom
	id                string
	pc                *webrtc.PeerConnection
	mu                sync.Mutex
	pendingCandidates []webrtc.ICECandidateInit
	makingOffer       bool
	ignoreOffer       bool
	needsNegotiation  bool
	closed            bool
}

type forwardPublication struct {
	room          *mediaRoom
	publisherID   string
	publicationID string
	mu            sync.Mutex
	layers        map[string]*forwardLayer
	subscribers   map[string]*subscriberForward
	lastLayerAt   time.Time
	closed        bool
}

type forwardLayer struct {
	publication     *forwardPublication
	name            string
	rid             string
	remote          *webrtc.TrackRemote
	local           *webrtc.TrackLocalStaticRTP
	federationLocal *webrtc.TrackLocalStaticRTP
	feedbackPC      *webrtc.PeerConnection
	inputFederation *federationPeer
	federationPeers map[string]*federationPeer
	queue           chan *rtp.Packet
	done            chan struct{}
	closeOnce       sync.Once
	feedbackMu      sync.Mutex
	lastKeyframeAt  time.Time
	reported        bool
}

type subscriberForward struct {
	layer         string
	revision      int64
	readyRevision int64
	sender        *webrtc.RTPSender
	local         *webrtc.TrackLocalStaticRTP
	rewriter      rtpContinuityRewriter
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
				knownPeers:        map[string]bool{},
				allowedPublishers: map[string]bool{},
				peers:             map[string]*mediaPeer{},
				tracks:            map[string]*forwardPublication{},
				subscriptions:     map[string]subscriptionPlan{},
				federationLinks:   map[string]*federationPeer{},
				federationRoutes:  map[string]federationRoute{},
				federationDemands: map[string]federationDemand{},
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
		load = max(load, percent(room.trackCount, a.cfg.maxTracks))
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
	if r.closed {
		r.mu.Unlock()
		return
	}
	r.role = lease.Role
	r.expiresAt = time.UnixMilli(lease.LeaseExpiresAt)
	r.iceServers = append(r.iceServers[:0], lease.ICEServers...)
	allowed := make(map[string]bool, len(lease.Peers))
	known := make(map[string]bool, len(lease.Peers))
	publishers := make(map[string]bool, len(lease.Peers))
	subscribers := make(map[string]bool, len(lease.Peers))
	for _, peer := range lease.Peers {
		known[peer.ID] = true
		if lease.Version < 3 || peer.Connect {
			allowed[peer.ID] = true
		}
		if peer.Publish || (lease.Version == 1 && lease.Role == "primary") {
			publishers[peer.ID] = true
		}
		if lease.Version < 3 || peer.Subscribe {
			subscribers[peer.ID] = true
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
	plans := make(map[string]subscriptionPlan, len(lease.Subscriptions))
	for _, plan := range lease.Subscriptions {
		if subscribers[plan.SubscriberPeerID] && known[plan.PublisherPeerID] {
			plans[subscriptionKey(plan.SubscriberPeerID, plan.PublisherPeerID, plan.PublicationID)] = plan
		}
	}
	r.subscriptions = plans
	r.knownPeers = known
	routes := make(map[string]federationRoute, len(lease.FederationRoutes))
	for _, route := range lease.FederationRoutes {
		routes[route.PublisherPeerID] = route
	}
	demands := make(map[string]federationDemand, len(lease.FederationDemands))
	for _, demand := range lease.FederationDemands {
		demands[federationDemandKey(demand)] = demand
	}
	r.federationRoutes = routes
	r.federationDemands = demands
	publications := make([]*forwardPublication, 0, len(r.tracks))
	for _, publication := range r.tracks {
		publications = append(publications, publication)
	}
	r.mu.Unlock()
	r.syncFederation(lease.FederationLinks)
	for _, publication := range publications {
		publication.reconcileAll()
		publication.reconcileFederation()
	}
}

func subscriptionKey(subscriberPeerID, publisherPeerID, publicationID string) string {
	return subscriberPeerID + "\x00" + publisherPeerID + "\x00" + publicationID
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
	if p.needsNegotiation {
		p.needsNegotiation = false
		go p.negotiate()
	}
	return nil
}

func (p *mediaPeer) negotiate() {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.closed {
		return
	}
	if p.makingOffer || p.pc.SignalingState() != webrtc.SignalingStateStable {
		p.needsNegotiation = true
		return
	}
	p.makingOffer = true
	defer func() { p.makingOffer = false }()
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
	layerName, rid, valid := mediaLayer(remote)
	if !valid {
		return
	}
	r.mu.Lock()
	if r.closed || r.trackCount >= r.agent.cfg.maxTracks || !r.allowedPeers[peer.id] || !r.allowedPublishers[peer.id] {
		r.mu.Unlock()
		return
	}
	key := peer.id + "\x00" + remote.ID()
	publication := r.tracks[key]
	created := false
	if publication == nil {
		publication = &forwardPublication{
			room: r, publisherID: peer.id, publicationID: remote.ID(),
			layers: map[string]*forwardLayer{}, subscribers: map[string]*subscriberForward{},
		}
		r.tracks[key] = publication
		created = true
	}
	local, err := webrtc.NewTrackLocalStaticRTP(remote.Codec().RTPCodecCapability, remote.ID(), peer.id)
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
		federationStreamID(peer.id, layerName),
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
		publication: publication, name: layerName, rid: rid, remote: remote, local: local,
		federationLocal: federationLocal, feedbackPC: peer.pc,
		federationPeers: map[string]*federationPeer{}, reported: true,
		queue: make(chan *rtp.Packet, r.agent.cfg.trackQueue), done: make(chan struct{}),
	}
	publication.layers[layerName] = layer
	publication.lastLayerAt = time.Now()
	publication.mu.Unlock()
	r.trackCount++
	r.mu.Unlock()
	_ = r.agent.signal.send(map[string]any{
		"version": 2, "type": "track-state", "roomId": r.id, "peerId": peer.id,
		"routeEpoch": r.routeEpoch, "publicationId": remote.ID(),
		"layer": layerName, "rid": rid, "active": true,
	})
	publication.reconcileAll()
	publication.reconcileFederation()
	time.AfterFunc(300*time.Millisecond, publication.reconcileAll)
	go layer.writeLoop()
	go layer.readLoop()
}

func (r *mediaRoom) attachExistingTracks(peer *mediaPeer) {
	r.mu.RLock()
	publications := make([]*forwardPublication, 0, len(r.tracks))
	for _, publication := range r.tracks {
		if publication.publisherID != peer.id {
			publications = append(publications, publication)
		}
	}
	r.mu.RUnlock()
	for _, publication := range publications {
		publication.reconcileSubscriber(peer.id)
	}
}

func mediaLayer(remote *webrtc.TrackRemote) (string, string, bool) {
	if remote.Kind() == webrtc.RTPCodecTypeAudio {
		return "audio", "", remote.RID() == ""
	}
	return videoLayer(remote.RID())
}

func videoLayer(rid string) (string, string, bool) {
	switch rid {
	case "q":
		return "low", rid, true
	case "h":
		return "medium", rid, true
	case "f":
		return "high", rid, true
	case "s":
		// Chromium may omit an SSRC declaration for a newly negotiated
		// single-layer video m-section. The reserved transport-only RID lets
		// Pion bind that RTP stream while the public contract remains single/"".
		return "single", "", true
	case "":
		return "single", rid, true
	default:
		return "", "", false
	}
}

func (p *forwardPublication) reconcileAll() {
	p.room.mu.RLock()
	peerIDs := make(map[string]bool)
	for key, plan := range p.room.subscriptions {
		_ = key
		if plan.PublisherPeerID == p.publisherID && plan.PublicationID == p.publicationID {
			peerIDs[plan.SubscriberPeerID] = true
		}
	}
	p.room.mu.RUnlock()
	p.mu.Lock()
	for peerID := range p.subscribers {
		peerIDs[peerID] = true
	}
	p.mu.Unlock()
	for peerID := range peerIDs {
		p.reconcileSubscriber(peerID)
	}
}

func (p *forwardPublication) reconcileSubscriber(peerID string) {
	p.room.mu.RLock()
	peer := p.room.peers[peerID]
	plan, planned := p.room.subscriptions[subscriptionKey(peerID, p.publisherID, p.publicationID)]
	allowed := p.room.allowedPeers[peerID]
	p.room.mu.RUnlock()
	p.mu.Lock()
	if p.closed {
		p.mu.Unlock()
		return
	}
	target := ""
	if peer != nil && allowed && planned && plan.Enabled {
		target = p.selectLayer(plan)
	}
	current := p.subscribers[peerID]
	if current != nil && current.layer == target {
		if current.revision == plan.Revision {
			p.mu.Unlock()
			return
		}
		current.revision = plan.Revision
		current.readyRevision = 0
		p.mu.Unlock()
		return
	}
	if current != nil && target != "" {
		layer := p.layers[target]
		if layer != nil && sameCodec(current.local.Codec(), layer.local.Codec()) {
			current.layer = target
			current.revision = plan.Revision
			current.readyRevision = 0
			p.mu.Unlock()
			layer.requestKeyframe()
			return
		}
	}
	if current != nil {
		delete(p.subscribers, peerID)
		if peer != nil {
			_ = peer.pc.RemoveTrack(current.sender)
		}
	}
	if target == "" || peer == nil {
		p.mu.Unlock()
		if current != nil && planned {
			p.reportSubscription(peerID, plan.PreferredLayer, plan.Revision, false)
			if peer != nil {
				go peer.negotiate()
			}
		}
		return
	}
	layer := p.layers[target]
	if layer == nil {
		p.mu.Unlock()
		return
	}
	local, err := webrtc.NewTrackLocalStaticRTP(layer.local.Codec(), p.publicationID, p.publisherID)
	if err != nil {
		p.mu.Unlock()
		p.reportSubscription(peerID, plan.PreferredLayer, plan.Revision, false)
		return
	}
	sender, err := peer.pc.AddTrack(local)
	if err != nil {
		p.mu.Unlock()
		p.reportSubscription(peerID, plan.PreferredLayer, plan.Revision, false)
		return
	}
	p.subscribers[peerID] = &subscriberForward{
		layer: target, revision: plan.Revision, sender: sender, local: local,
	}
	p.mu.Unlock()
	layer.requestKeyframe()
	go p.readSubscriberFeedback(peerID, sender)
	go peer.negotiate()
}

func sameCodec(left, right webrtc.RTPCodecCapability) bool {
	return strings.EqualFold(left.MimeType, right.MimeType) && left.ClockRate == right.ClockRate &&
		left.Channels == right.Channels && left.SDPFmtpLine == right.SDPFmtpLine
}

func (p *forwardPublication) writeSubscribers(layerName string, packet *rtp.Packet) {
	type readyReport struct {
		peerID   string
		layer    string
		revision int64
	}
	reports := make([]readyReport, 0)
	p.mu.Lock()
	for peerID, forward := range p.subscribers {
		if forward.layer != layerName {
			continue
		}
		rewritten := forward.rewriter.rewrite(layerName, packet)
		if err := forward.local.WriteRTP(&rewritten); err == nil && forward.readyRevision != forward.revision {
			forward.readyRevision = forward.revision
			reports = append(reports, readyReport{peerID: peerID, layer: layerName, revision: forward.revision})
		}
	}
	p.mu.Unlock()
	for _, report := range reports {
		p.reportSubscription(report.peerID, report.layer, report.revision, true)
	}
}

func (p *forwardPublication) readSubscriberFeedback(peerID string, sender *webrtc.RTPSender) {
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
		if !requestKeyframe {
			continue
		}
		p.mu.Lock()
		forward := p.subscribers[peerID]
		var layer *forwardLayer
		if forward != nil && forward.sender == sender {
			layer = p.layers[forward.layer]
		}
		p.mu.Unlock()
		if layer != nil {
			layer.requestKeyframe()
		}
	}
}

func (p *forwardPublication) selectLayer(plan subscriptionPlan) string {
	if plan.PreferredLayer == "audio" || plan.PreferredLayer == "single" {
		if p.layers[plan.PreferredLayer] != nil {
			return plan.PreferredLayer
		}
		return ""
	}
	if p.layers["single"] != nil {
		return "single"
	}
	rank := map[string]int{"low": 0, "medium": 1, "high": 2}
	preferred := rank[plan.PreferredLayer]
	maximum := rank[plan.MaximumLayer]
	if preferred <= maximum && p.layers[plan.PreferredLayer] != nil {
		return plan.PreferredLayer
	}
	if time.Since(p.lastLayerAt) < 250*time.Millisecond {
		return ""
	}
	for _, layer := range []string{"high", "medium", "low"} {
		if rank[layer] <= preferred && rank[layer] <= maximum && p.layers[layer] != nil {
			return layer
		}
	}
	return ""
}

func (p *forwardPublication) reportSubscription(peerID, layer string, revision int64, ready bool) {
	_ = p.room.agent.signal.send(map[string]any{
		"version": 2, "type": "subscription-state", "roomId": p.room.id, "routeEpoch": p.room.routeEpoch,
		"publisherPeerId": p.publisherID, "publicationId": p.publicationID,
		"subscriberPeerId": peerID, "selectedLayer": layer, "revision": revision, "ready": ready,
	})
}

func (l *forwardLayer) readLoop() {
	defer l.close()
	for {
		packet, _, err := l.remote.ReadRTP()
		if err != nil {
			return
		}
		if l.inputFederation != nil {
			l.inputFederation.receivedPackets.Add(1)
		}
		cloned, err := cloneRTPPacket(packet, l.publication.room.agent.cfg.maxPacketBytes)
		if err != nil || !l.publication.room.budget.allow(len(cloned.Payload), time.Now()) {
			if l.inputFederation != nil {
				l.inputFederation.droppedPackets.Add(1)
			}
			continue
		}
		select {
		case l.queue <- cloned:
		default:
			if l.inputFederation != nil {
				l.inputFederation.droppedPackets.Add(1)
			}
			select {
			case <-l.queue:
			default:
			}
			select {
			case l.queue <- cloned:
			default:
			}
		}
	}
}

func (l *forwardLayer) writeLoop() {
	keyframe := time.NewTicker(3 * time.Second)
	defer keyframe.Stop()
	for {
		select {
		case <-l.done:
			return
		case packet := <-l.queue:
			if packet != nil {
				l.publication.writeSubscribers(l.name, packet)
				_ = l.federationLocal.WriteRTP(packet)
				l.publication.mu.Lock()
				federations := make([]*federationPeer, 0, len(l.federationPeers))
				for _, federation := range l.federationPeers {
					federations = append(federations, federation)
				}
				l.publication.mu.Unlock()
				for _, federation := range federations {
					federation.forwardedPackets.Add(1)
				}
			}
		case <-keyframe.C:
			if l.remote.Kind() == webrtc.RTPCodecTypeVideo {
				l.requestKeyframe()
			}
		}
	}
}

func (l *forwardLayer) requestKeyframe() {
	if l.feedbackPC != nil && l.allowKeyframeRequest(time.Now()) {
		_ = l.feedbackPC.WriteRTCP([]rtcp.Packet{
			&rtcp.PictureLossIndication{MediaSSRC: uint32(l.remote.SSRC())},
		})
	}
}

func (l *forwardLayer) allowKeyframeRequest(now time.Time) bool {
	l.feedbackMu.Lock()
	defer l.feedbackMu.Unlock()
	if !l.lastKeyframeAt.IsZero() && now.Sub(l.lastKeyframeAt) < 250*time.Millisecond {
		return false
	}
	l.lastKeyframeAt = now
	return true
}

func (l *forwardLayer) close() {
	l.closeOnce.Do(func() {
		close(l.done)
		l.publication.removeLayer(l)
	})
}

func (p *forwardPublication) removeLayer(layer *forwardLayer) {
	p.mu.Lock()
	if p.closed || p.layers[layer.name] != layer {
		p.mu.Unlock()
		return
	}
	delete(p.layers, layer.name)
	empty := len(p.layers) == 0
	p.mu.Unlock()
	p.room.mu.Lock()
	p.room.trackCount = max(0, p.room.trackCount-1)
	if empty {
		delete(p.room.tracks, p.publisherID+"\x00"+p.publicationID)
	}
	p.room.mu.Unlock()
	if layer.reported {
		_ = p.room.agent.signal.send(map[string]any{
			"version": 2, "type": "track-state", "roomId": p.room.id, "peerId": p.publisherID,
			"routeEpoch": p.room.routeEpoch, "publicationId": p.publicationID,
			"layer": layer.name, "rid": layer.rid, "active": false,
		})
	}
	p.reconcileAll()
	// Always detach the corresponding agent-agent sender. In particular, the
	// final layer of a publication must not leave a stale sender that could be
	// mistaken for a later publication reusing the same track id.
	p.reconcileFederation()
}

func (p *forwardPublication) close() {
	p.mu.Lock()
	if p.closed {
		p.mu.Unlock()
		return
	}
	p.closed = true
	layers := make([]*forwardLayer, 0, len(p.layers))
	for _, layer := range p.layers {
		layers = append(layers, layer)
	}
	subscribers := make(map[string]*subscriberForward, len(p.subscribers))
	for peerID, forward := range p.subscribers {
		subscribers[peerID] = forward
	}
	p.layers = map[string]*forwardLayer{}
	p.subscribers = map[string]*subscriberForward{}
	p.mu.Unlock()
	for _, layer := range layers {
		layer.closeOnce.Do(func() { close(layer.done) })
	}
	p.room.mu.RLock()
	peers := make(map[string]*mediaPeer, len(subscribers))
	for peerID := range subscribers {
		peers[peerID] = p.room.peers[peerID]
	}
	p.room.mu.RUnlock()
	for peerID, forward := range subscribers {
		if peer := peers[peerID]; peer != nil {
			_ = peer.pc.RemoveTrack(forward.sender)
		}
	}
}

func (r *mediaRoom) close() {
	r.mu.Lock()
	if r.closed {
		r.mu.Unlock()
		return
	}
	r.closed = true
	tracks := make([]*forwardPublication, 0, len(r.tracks))
	for _, track := range r.tracks {
		tracks = append(tracks, track)
	}
	peers := make([]*mediaPeer, 0, len(r.peers))
	for _, peer := range r.peers {
		peers = append(peers, peer)
	}
	federations := make([]*federationPeer, 0, len(r.federationLinks))
	for _, federation := range r.federationLinks {
		federations = append(federations, federation)
	}
	r.tracks = map[string]*forwardPublication{}
	r.trackCount = 0
	r.peers = map[string]*mediaPeer{}
	r.allowedPeers = map[string]bool{}
	r.knownPeers = map[string]bool{}
	r.allowedPublishers = map[string]bool{}
	r.subscriptions = map[string]subscriptionPlan{}
	r.federationRoutes = map[string]federationRoute{}
	r.federationDemands = map[string]federationDemand{}
	r.federationLinks = map[string]*federationPeer{}
	r.mu.Unlock()
	for _, track := range tracks {
		track.close()
	}
	for _, peer := range peers {
		peer.close()
	}
	for _, federation := range federations {
		federation.close(false, "room-closed")
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
