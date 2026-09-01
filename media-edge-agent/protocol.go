package main

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"regexp"
	"time"

	"github.com/pion/webrtc/v4"
)

const maximumServerControlBytes = 32 * 1024 * 1024

var (
	peerIDPattern          = regexp.MustCompile(`^[a-f0-9]{16}$`)
	roomIDPattern          = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{5,47}$`)
	trackIDPattern         = regexp.MustCompile(`^[A-Za-z0-9_={}:-]{1,128}$`)
	linkIDPattern          = regexp.MustCompile(`^[A-Za-z0-9_-]{22}$`)
	noncePattern           = regexp.MustCompile(`^[A-Za-z0-9_-]{32}$`)
	enrollmentTokenPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{43}$`)
	codePattern            = regexp.MustCompile(`^[a-z0-9_]{1,64}$`)
)

type serverMessage struct {
	Version        int                        `json:"version"`
	Type           string                     `json:"type"`
	Nonce          string                     `json:"nonce"`
	ExpiresAt      int64                      `json:"expiresAt"`
	AgentID        string                     `json:"agentId"`
	KeyFingerprint string                     `json:"keyFingerprint"`
	Code           string                     `json:"code"`
	Leases         []agentLease               `json:"leases"`
	RoomID         string                     `json:"roomId"`
	PeerID         string                     `json:"peerId"`
	RouteEpoch     int64                      `json:"routeEpoch"`
	LinkID         string                     `json:"linkId"`
	FromAgentID    string                     `json:"fromAgentId"`
	Description    *webrtc.SessionDescription `json:"description"`
	Candidate      json.RawMessage            `json:"candidate"`
}

type agentLease struct {
	Version           int                `json:"version"`
	Type              string             `json:"type"`
	RoomID            string             `json:"roomId"`
	Role              string             `json:"role"`
	MembershipEpoch   int64              `json:"membershipEpoch"`
	RouteEpoch        int64              `json:"routeEpoch"`
	LeaseExpiresAt    int64              `json:"leaseExpiresAt"`
	Peers             []leasePeer        `json:"peers"`
	Subscriptions     []subscriptionPlan `json:"subscriptions"`
	FederationLinks   []federationLink   `json:"federationLinks"`
	FederationRoutes  []federationRoute  `json:"federationRoutes"`
	FederationDemands []federationDemand `json:"federationDemands"`
	ICEServers        []webrtc.ICEServer `json:"iceServers"`
}

type leasePeer struct {
	ID        string `json:"id"`
	Connect   bool   `json:"connect"`
	Publish   bool   `json:"publish"`
	Subscribe bool   `json:"subscribe"`
}

type subscriptionPlan struct {
	SubscriberPeerID string `json:"subscriberPeerId"`
	PublisherPeerID  string `json:"publisherPeerId"`
	PublicationID    string `json:"publicationId"`
	Source           string `json:"source"`
	Enabled          bool   `json:"enabled"`
	PreferredLayer   string `json:"preferredLayer"`
	MaximumLayer     string `json:"maximumLayer"`
	Revision         int64  `json:"revision"`
}

type federationLink struct {
	LinkID           string `json:"linkId"`
	LeftAgentID      string `json:"leftAgentId"`
	RightAgentID     string `json:"rightAgentId"`
	InitiatorAgentID string `json:"initiatorAgentId"`
}

type federationEdge struct {
	LinkID      string `json:"linkId"`
	FromAgentID string `json:"fromAgentId"`
	ToAgentID   string `json:"toAgentId"`
}

type federationRoute struct {
	PublisherPeerID string           `json:"publisherPeerId"`
	SourceAgentID   string           `json:"sourceAgentId"`
	MaximumHops     int              `json:"maximumHops"`
	Edges           []federationEdge `json:"edges"`
}

type federationDemand struct {
	LinkID          string `json:"linkId"`
	FromAgentID     string `json:"fromAgentId"`
	ToAgentID       string `json:"toAgentId"`
	PublisherPeerID string `json:"publisherPeerId"`
	PublicationID   string `json:"publicationId"`
	Layer           string `json:"layer"`
}

type roomHeartbeat struct {
	RoomID     string `json:"roomId"`
	RouteEpoch int64  `json:"routeEpoch"`
}

func authProof(secret, agentID, nonce string, timestamp int64) string {
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = fmt.Fprintf(mac, "v1\n%s\n%s\n%d", agentID, nonce, timestamp)
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

func exactRawFields(raw []byte, fields ...string) (map[string]json.RawMessage, error) {
	var value map[string]json.RawMessage
	if err := json.Unmarshal(raw, &value); err != nil || value == nil {
		return nil, fmt.Errorf("invalid control message")
	}
	allowed := make(map[string]bool, len(fields))
	for _, field := range fields {
		allowed[field] = true
	}
	if len(value) != len(allowed) {
		return nil, fmt.Errorf("invalid control message fields")
	}
	for field := range value {
		if !allowed[field] {
			return nil, fmt.Errorf("unknown control message field")
		}
	}
	return value, nil
}

func decodeServerMessage(raw []byte) (serverMessage, error) {
	if len(raw) == 0 || len(raw) > maximumServerControlBytes {
		return serverMessage{}, fmt.Errorf("invalid control message size")
	}
	var header struct {
		Version int    `json:"version"`
		Type    string `json:"type"`
	}
	if json.Unmarshal(raw, &header) != nil || header.Version != 1 {
		return serverMessage{}, fmt.Errorf("invalid control message version")
	}
	var fields []string
	switch header.Type {
	case "agent-challenge":
		fields = []string{"version", "type", "nonce", "expiresAt"}
	case "agent-authenticated":
		fields = []string{"version", "type", "agentId"}
	case "agent-enrolled":
		fields = []string{"version", "type", "agentId", "keyFingerprint"}
	case "agent-sync":
		fields = []string{"version", "type", "leases"}
	case "peer-signal":
		var value map[string]json.RawMessage
		if json.Unmarshal(raw, &value) != nil {
			return serverMessage{}, fmt.Errorf("invalid peer signal")
		}
		_, hasDescription := value["description"]
		_, hasCandidate := value["candidate"]
		if hasDescription == hasCandidate {
			return serverMessage{}, fmt.Errorf("invalid peer signal payload")
		}
		fields = []string{"version", "type", "roomId", "peerId", "routeEpoch"}
		if hasDescription {
			fields = append(fields, "description")
		} else {
			fields = append(fields, "candidate")
		}
	case "federation-peer-signal":
		var value map[string]json.RawMessage
		if json.Unmarshal(raw, &value) != nil {
			return serverMessage{}, fmt.Errorf("invalid federation peer signal")
		}
		_, hasDescription := value["description"]
		_, hasCandidate := value["candidate"]
		if hasDescription == hasCandidate {
			return serverMessage{}, fmt.Errorf("invalid federation signal payload")
		}
		fields = []string{"version", "type", "roomId", "routeEpoch", "linkId", "fromAgentId"}
		if hasDescription {
			fields = append(fields, "description")
		} else {
			fields = append(fields, "candidate")
		}
	case "agent-error":
		fields = []string{"version", "type", "code"}
	default:
		return serverMessage{}, fmt.Errorf("unknown control message type")
	}
	if _, err := exactRawFields(raw, fields...); err != nil {
		return serverMessage{}, err
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	var message serverMessage
	if err := decoder.Decode(&message); err != nil {
		return serverMessage{}, fmt.Errorf("invalid control message: %w", err)
	}
	if message.Type == "agent-challenge" && !noncePattern.MatchString(message.Nonce) {
		return serverMessage{}, fmt.Errorf("invalid authentication challenge")
	}
	if (message.Type == "agent-authenticated" || message.Type == "agent-enrolled") && !agentIDPattern.MatchString(message.AgentID) {
		return serverMessage{}, fmt.Errorf("invalid authenticated agent")
	}
	if message.Type == "agent-enrolled" && !enrollmentTokenPattern.MatchString(message.KeyFingerprint) {
		return serverMessage{}, fmt.Errorf("invalid enrolled agent fingerprint")
	}
	if message.Type == "agent-error" && !codePattern.MatchString(message.Code) {
		return serverMessage{}, fmt.Errorf("invalid agent error")
	}
	if message.Type == "peer-signal" || message.Type == "federation-peer-signal" {
		validRecipient := message.Type == "peer-signal" && peerIDPattern.MatchString(message.PeerID)
		if message.Type == "federation-peer-signal" {
			validRecipient = linkIDPattern.MatchString(message.LinkID) && agentIDPattern.MatchString(message.FromAgentID)
		}
		if !roomIDPattern.MatchString(message.RoomID) || !validRecipient || message.RouteEpoch < 1 {
			return serverMessage{}, fmt.Errorf("invalid peer signal route")
		}
		if message.Description != nil {
			if !oneOf(message.Description.Type.String(), "offer", "answer") || len(message.Description.SDP) > 80_000 {
				return serverMessage{}, fmt.Errorf("invalid peer description")
			}
		} else if err := validateCandidate(message.Candidate); err != nil {
			return serverMessage{}, err
		}
	}
	return message, nil
}

func validateCandidate(raw json.RawMessage) error {
	if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return nil
	}
	if len(raw) == 0 || len(raw) > 4_096 {
		return fmt.Errorf("invalid ICE candidate")
	}
	fields, err := exactRawFields(raw, "candidate", "sdpMid", "sdpMLineIndex", "usernameFragment")
	if err != nil {
		// Browser implementations omit optional candidate fields.
		var value map[string]json.RawMessage
		if json.Unmarshal(raw, &value) != nil || len(value) == 0 {
			return fmt.Errorf("invalid ICE candidate")
		}
		allowed := map[string]bool{"candidate": true, "sdpMid": true, "sdpMLineIndex": true, "usernameFragment": true}
		for field := range value {
			if !allowed[field] {
				return fmt.Errorf("unknown ICE candidate field")
			}
		}
		fields = value
	}
	var candidate string
	if candidateRaw, exists := fields["candidate"]; !exists || json.Unmarshal(candidateRaw, &candidate) != nil || len(candidate) > 4_096 {
		return fmt.Errorf("invalid ICE candidate value")
	}
	return nil
}

func validateLease(lease agentLease, now time.Time, limits config) error {
	if (lease.Version != 1 && lease.Version != 2 && lease.Version != 3) || lease.Type != "agent-lease" || !roomIDPattern.MatchString(lease.RoomID) ||
		!oneOf(lease.Role, "primary", "standby") || lease.MembershipEpoch < 1 || lease.RouteEpoch < 1 ||
		lease.LeaseExpiresAt <= now.UnixMilli() || lease.LeaseExpiresAt > now.Add(120*time.Second).UnixMilli() ||
		len(lease.Peers) > limits.maxPeers ||
		len(lease.ICEServers) > 24 {
		return fmt.Errorf("invalid agent lease")
	}
	seen := map[string]bool{}
	peerPolicies := map[string]leasePeer{}
	for _, peer := range lease.Peers {
		if !peerIDPattern.MatchString(peer.ID) || seen[peer.ID] {
			return fmt.Errorf("invalid agent lease peer")
		}
		seen[peer.ID] = true
		if lease.Version == 3 && (peer.Publish || peer.Subscribe) && !peer.Connect {
			return fmt.Errorf("invalid disconnected peer authority")
		}
		peerPolicies[peer.ID] = peer
	}
	if lease.Version == 3 {
		if lease.Peers == nil || lease.Subscriptions == nil || lease.FederationLinks == nil ||
			lease.FederationRoutes == nil || lease.FederationDemands == nil || lease.ICEServers == nil ||
			len(lease.Subscriptions) > 1_520 || len(lease.FederationLinks) > 2 ||
			len(lease.FederationRoutes) > limits.maxPeers || len(lease.FederationDemands) > 3_040 {
			return fmt.Errorf("invalid agent lease extensions")
		}
		subscriptions := map[string]bool{}
		federatedPublishers := map[string]bool{}
		for _, route := range lease.FederationRoutes {
			federatedPublishers[route.PublisherPeerID] = true
		}
		for _, plan := range lease.Subscriptions {
			key := plan.SubscriberPeerID + "\x00" + plan.PublisherPeerID + "\x00" + plan.PublicationID
			if subscriptions[key] || !seen[plan.SubscriberPeerID] || !seen[plan.PublisherPeerID] ||
				!peerPolicies[plan.SubscriberPeerID].Subscribe ||
				(!peerPolicies[plan.PublisherPeerID].Publish && !federatedPublishers[plan.PublisherPeerID]) ||
				plan.SubscriberPeerID == plan.PublisherPeerID || !trackIDPattern.MatchString(plan.PublicationID) ||
				plan.Revision < 1 || !validSubscriptionPlanLayers(plan) {
				return fmt.Errorf("invalid subscription plan")
			}
			subscriptions[key] = true
		}
		links := map[string]federationLink{}
		for _, link := range lease.FederationLinks {
			if !linkIDPattern.MatchString(link.LinkID) || links[link.LinkID].LinkID != "" ||
				!agentIDPattern.MatchString(link.LeftAgentID) || !agentIDPattern.MatchString(link.RightAgentID) ||
				link.LeftAgentID == link.RightAgentID ||
				(link.LeftAgentID != limits.agentID && link.RightAgentID != limits.agentID) ||
				(link.InitiatorAgentID != link.LeftAgentID && link.InitiatorAgentID != link.RightAgentID) {
				return fmt.Errorf("invalid federation link")
			}
			links[link.LinkID] = link
		}
		routeEdges := map[string]map[string]bool{}
		for _, route := range lease.FederationRoutes {
			if !seen[route.PublisherPeerID] || !agentIDPattern.MatchString(route.SourceAgentID) ||
				route.MaximumHops < 1 || route.MaximumHops > 2 || len(route.Edges) > 2 ||
				routeEdges[route.PublisherPeerID] != nil {
				return fmt.Errorf("invalid federation route")
			}
			visited := map[string]bool{route.SourceAgentID: true}
			depth := map[string]int{route.SourceAgentID: 0}
			edges := map[string]bool{}
			localRoute := route.SourceAgentID == limits.agentID
			for _, edge := range route.Edges {
				link, exists := links[edge.LinkID]
				edgeKey := edge.LinkID + "\x00" + edge.FromAgentID + "\x00" + edge.ToAgentID
				linkedEndpoints := !exists ||
					(link.LeftAgentID == edge.FromAgentID && link.RightAgentID == edge.ToAgentID) ||
					(link.RightAgentID == edge.FromAgentID && link.LeftAgentID == edge.ToAgentID)
				edgeDepth := depth[edge.FromAgentID] + 1
				if !linkIDPattern.MatchString(edge.LinkID) || !agentIDPattern.MatchString(edge.FromAgentID) ||
					!agentIDPattern.MatchString(edge.ToAgentID) || edge.FromAgentID == edge.ToAgentID ||
					!visited[edge.FromAgentID] || visited[edge.ToAgentID] || edgeDepth > route.MaximumHops ||
					!linkedEndpoints || edges[edgeKey] {
					return fmt.Errorf("cyclic or unauthorized federation route")
				}
				visited[edge.ToAgentID] = true
				depth[edge.ToAgentID] = edgeDepth
				edges[edgeKey] = true
				if edge.FromAgentID == limits.agentID || edge.ToAgentID == limits.agentID {
					localRoute = true
					if !exists {
						return fmt.Errorf("missing local federation link")
					}
				}
			}
			if !localRoute {
				return fmt.Errorf("irrelevant federation route")
			}
			routeEdges[route.PublisherPeerID] = edges
		}
		demands := map[string]bool{}
		for _, demand := range lease.FederationDemands {
			link, exists := links[demand.LinkID]
			key := demand.LinkID + "\x00" + demand.FromAgentID + "\x00" + demand.ToAgentID + "\x00" +
				demand.PublisherPeerID + "\x00" + demand.PublicationID + "\x00" + demand.Layer
			routeEdgeKey := demand.LinkID + "\x00" + demand.FromAgentID + "\x00" + demand.ToAgentID
			if !exists || demands[key] || !seen[demand.PublisherPeerID] ||
				!trackIDPattern.MatchString(demand.PublicationID) ||
				!oneOf(demand.Layer, "audio", "single", "low", "medium", "high") ||
				!routeEdges[demand.PublisherPeerID][routeEdgeKey] ||
				!((link.LeftAgentID == demand.FromAgentID && link.RightAgentID == demand.ToAgentID) ||
					(link.RightAgentID == demand.FromAgentID && link.LeftAgentID == demand.ToAgentID)) {
				return fmt.Errorf("invalid federation demand")
			}
			demands[key] = true
		}
	}
	for _, server := range lease.ICEServers {
		if len(server.URLs) == 0 || len(server.URLs) > 8 {
			return fmt.Errorf("invalid agent ICE server")
		}
		for _, rawURL := range server.URLs {
			if len(rawURL) > 2048 {
				return fmt.Errorf("invalid agent ICE URL")
			}
		}
	}
	return nil
}

func validSubscriptionPlanLayers(plan subscriptionPlan) bool {
	if plan.Source == "microphone" || plan.Source == "screen-audio" {
		return plan.PreferredLayer == "audio" && plan.MaximumLayer == "audio"
	}
	if plan.Source == "screen" {
		return plan.PreferredLayer == "single" && plan.MaximumLayer == "single"
	}
	if plan.Source != "camera" {
		return false
	}
	if plan.PreferredLayer == "single" || plan.MaximumLayer == "single" {
		return plan.PreferredLayer == "single" && plan.MaximumLayer == "single"
	}
	rank := map[string]int{"low": 0, "medium": 1, "high": 2}
	preferred, preferredOK := rank[plan.PreferredLayer]
	maximum, maximumOK := rank[plan.MaximumLayer]
	return preferredOK && maximumOK && (!plan.Enabled || preferred <= maximum)
}
