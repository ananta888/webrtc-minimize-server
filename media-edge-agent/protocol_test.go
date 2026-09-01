package main

import (
	"encoding/json"
	"fmt"
	"testing"
	"time"

	"github.com/pion/webrtc/v4"
)

func TestAuthProofIsBoundToAgentNonceAndTimestamp(t *testing.T) {
	secret := "0123456789abcdef0123456789abcdef"
	proof := authProof(secret, "laptop-edge", "nonce-a", 1000)
	if len(proof) != 43 {
		t.Fatalf("unexpected proof length: %d", len(proof))
	}
	if proof == authProof(secret, "other-edge", "nonce-a", 1000) ||
		proof == authProof(secret, "laptop-edge", "nonce-b", 1000) ||
		proof == authProof(secret, "laptop-edge", "nonce-a", 1001) {
		t.Fatal("authentication proof is not context-bound")
	}
}

func TestServerControlAcceptsBoundedMultiPublicationAgentSync(t *testing.T) {
	plans := make([]subscriptionPlan, 800)
	for index := range plans {
		plans[index] = subscriptionPlan{
			SubscriberPeerID: "fedcba9876543210", PublisherPeerID: "0123456789abcdef",
			PublicationID: fmt.Sprintf("camera-%04d", index), Source: "camera", Enabled: true,
			PreferredLayer: "medium", MaximumLayer: "high", Revision: int64(index + 1),
		}
	}
	raw, err := json.Marshal(map[string]any{
		"version": 1,
		"type":    "agent-sync",
		"leases": []agentLease{{
			Version: 3, Type: "agent-lease", RoomID: "room-123456", Role: "primary",
			MembershipEpoch: 1, RouteEpoch: 1, LeaseExpiresAt: 20_000,
			Peers: []leasePeer{
				{ID: "0123456789abcdef", Connect: true, Publish: true, Subscribe: true},
				{ID: "fedcba9876543210", Connect: true, Subscribe: true},
			},
			Subscriptions: plans, FederationLinks: []federationLink{},
			FederationRoutes: []federationRoute{}, FederationDemands: []federationDemand{},
			ICEServers: []webrtc.ICEServer{},
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(raw) <= 96*1024 {
		t.Fatalf("fixture did not cross the former unsafe control limit: %d", len(raw))
	}
	if _, err = decodeServerMessage(raw); err != nil {
		t.Fatalf("bounded multi-publication sync was rejected: %v", err)
	}
}

func TestServerControlMessagesRequireVersionAndExactFields(t *testing.T) {
	tests := []string{
		`{"version":1,"type":"agent-challenge","nonce":"0123456789abcdef0123456789abcdef","expiresAt":20000}`,
		`{"version":1,"type":"agent-authenticated","agentId":"laptop-edge"}`,
		`{"version":1,"type":"agent-enrolled","agentId":"laptop-edge","keyFingerprint":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"}`,
		`{"version":1,"type":"agent-sync","leases":[]}`,
		`{"version":1,"type":"peer-signal","roomId":"room-123456","peerId":"0123456789abcdef","routeEpoch":2,"description":{"type":"offer","sdp":"v=0\\r\\n"}}`,
		`{"version":1,"type":"peer-signal","roomId":"room-123456","peerId":"0123456789abcdef","routeEpoch":2,"candidate":null}`,
		`{"version":1,"type":"federation-peer-signal","roomId":"room-123456","routeEpoch":2,"linkId":"abcdefghijklmnopqrstuv","fromAgentId":"remote-edge","description":{"type":"offer","sdp":"v=0\\r\\n"}}`,
		`{"version":1,"type":"federation-peer-signal","roomId":"room-123456","routeEpoch":2,"linkId":"abcdefghijklmnopqrstuv","fromAgentId":"remote-edge","candidate":null}`,
		`{"version":1,"type":"agent-error","code":"stale_agent_route"}`,
	}
	for index, raw := range tests {
		if _, err := decodeServerMessage([]byte(raw)); err != nil {
			t.Fatalf("valid control message %d rejected: %v", index, err)
		}
	}
	invalid := []string{
		`{"type":"agent-authenticated","agentId":"laptop-edge"}`,
		`{"version":1,"type":"agent-authenticated","agentId":"laptop-edge","sharedSecret":"forbidden"}`,
		`{"version":1,"type":"peer-signal","roomId":"room-123456","peerId":"0123456789abcdef","routeEpoch":2,"candidate":null,"description":{"type":"offer","sdp":"v=0"}}`,
		`{"version":1,"type":"peer-signal","roomId":"room-123456","peerId":"0123456789abcdef","routeEpoch":2,"candidate":{"candidate":"x","authority":true}}`,
		`{"version":1,"type":"federation-peer-signal","roomId":"room-123456","routeEpoch":2,"linkId":"abcdefghijklmnopqrstuv","fromAgentId":"remote-edge","candidate":null,"authority":true}`,
	}
	for index, raw := range invalid {
		if _, err := decodeServerMessage([]byte(raw)); err == nil {
			t.Fatal(fmt.Sprintf("invalid control message %d accepted", index))
		}
	}
}

func TestFederationControlRequiresClosedEpochBoundMessages(t *testing.T) {
	valid := []string{
		`{"version":1,"type":"federation-hello","roomId":"room-123456","routeEpoch":7,"linkId":"abcdefghijklmnopqrstuv","agentId":"remote-edge","leaseExpiresAt":20000}`,
		`{"version":1,"type":"federation-ack","roomId":"room-123456","routeEpoch":7,"linkId":"abcdefghijklmnopqrstuv","agentId":"remote-edge","accepted":true}`,
		`{"version":1,"type":"federation-stats","roomId":"room-123456","routeEpoch":7,"linkId":"abcdefghijklmnopqrstuv","agentId":"remote-edge","sequence":1,"receivedPackets":2,"forwardedPackets":3,"droppedPackets":0}`,
	}
	for index, raw := range valid {
		if _, err := decodeFederationControl([]byte(raw)); err != nil {
			t.Fatalf("valid federation control %d rejected: %v", index, err)
		}
	}
	invalid := []string{
		`{"version":1,"type":"federation-hello","roomId":"room-123456","routeEpoch":0,"linkId":"abcdefghijklmnopqrstuv","agentId":"remote-edge","leaseExpiresAt":20000}`,
		`{"version":1,"type":"federation-ack","roomId":"room-123456","routeEpoch":7,"linkId":"abcdefghijklmnopqrstuv","agentId":"remote-edge","accepted":true,"authority":"forbidden"}`,
		`{"version":1,"type":"federation-stats","roomId":"room-123456","routeEpoch":7,"linkId":"abcdefghijklmnopqrstuv","agentId":"remote-edge","sequence":1,"receivedPackets":2,"forwardedPackets":3,"droppedPackets":-1}`,
	}
	for index, raw := range invalid {
		if _, err := decodeFederationControl([]byte(raw)); err == nil {
			t.Fatalf("invalid federation control %d accepted", index)
		}
	}
}

func TestVersionThreeLeaseRejectsDemandOutsideServerAuthoredRoute(t *testing.T) {
	values := validEnvironment()
	values["MEDIA_AGENT_ID"] = "agent-a"
	cfg, err := loadConfig(environment(values))
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	lease := agentLease{
		Version: 3, Type: "agent-lease", RoomID: "room-123456", Role: "primary",
		MembershipEpoch: 1, RouteEpoch: 2, LeaseExpiresAt: now.Add(30 * time.Second).UnixMilli(),
		Peers: []leasePeer{
			{ID: "0123456789abcdef", Connect: true, Publish: true, Subscribe: true},
			{ID: "fedcba9876543210"},
		},
		Subscriptions: []subscriptionPlan{},
		FederationLinks: []federationLink{{
			LinkID: "abcdefghijklmnopqrstuv", LeftAgentID: "agent-a", RightAgentID: "agent-b",
			InitiatorAgentID: "agent-a",
		}},
		FederationRoutes: []federationRoute{{
			PublisherPeerID: "0123456789abcdef", SourceAgentID: "agent-a", MaximumHops: 2,
			Edges: []federationEdge{{
				LinkID: "abcdefghijklmnopqrstuv", FromAgentID: "agent-a", ToAgentID: "agent-b",
			}},
		}},
		FederationDemands: []federationDemand{{
			LinkID: "abcdefghijklmnopqrstuv", FromAgentID: "agent-b", ToAgentID: "agent-a",
			PublisherPeerID: "0123456789abcdef", PublicationID: "camera-track", Layer: "high",
		}},
		ICEServers: []webrtc.ICEServer{},
	}
	if err = validateLease(lease, now, cfg); err == nil {
		t.Fatal("reverse-direction demand outside the publisher DAG was accepted")
	}
}

func TestLeaseValidationBoundsMembershipEpochPeersAndICE(t *testing.T) {
	cfg, err := loadConfig(environment(validEnvironment()))
	if err != nil {
		t.Fatal(err)
	}
	now := time.UnixMilli(10_000)
	lease := agentLease{
		Version:         1,
		Type:            "agent-lease",
		RoomID:          "room-123456",
		Role:            "primary",
		MembershipEpoch: 1,
		RouteEpoch:      2,
		LeaseExpiresAt:  20_000,
		Peers:           []leasePeer{{ID: "0123456789abcdef"}},
	}
	if err = validateLease(lease, now, cfg); err != nil {
		t.Fatal(err)
	}
	lease.LeaseExpiresAt = 9_999
	if err = validateLease(lease, now, cfg); err == nil {
		t.Fatal("expired lease accepted")
	}
	lease.LeaseExpiresAt = now.Add(121 * time.Second).UnixMilli()
	if err = validateLease(lease, now, cfg); err == nil {
		t.Fatal("overlong lease accepted")
	}
	lease.LeaseExpiresAt = 20_000
	lease.Peers = append(lease.Peers, leasePeer{ID: "0123456789abcdef"})
	if err = validateLease(lease, now, cfg); err == nil {
		t.Fatal("duplicate peer accepted")
	}
}

func TestVersionTwoLeaseRestrictsPublisherAuthority(t *testing.T) {
	cfg, err := loadConfig(environment(validEnvironment()))
	if err != nil {
		t.Fatal(err)
	}
	agent := newMediaAgent(cfg, nil)
	now := time.Now()
	if err = agent.applySync([]agentLease{{
		Version: 2, Type: "agent-lease", RoomID: "room-123456", Role: "standby",
		MembershipEpoch: 1, RouteEpoch: 3, LeaseExpiresAt: now.Add(30 * time.Second).UnixMilli(),
		Peers: []leasePeer{
			{ID: "0123456789abcdef", Publish: true},
			{ID: "fedcba9876543210", Publish: false},
		},
	}}, now); err != nil {
		t.Fatal(err)
	}
	room := agent.rooms["room-123456"]
	if room == nil || !room.allowedPublishers["0123456789abcdef"] || room.allowedPublishers["fedcba9876543210"] {
		t.Fatal("publisher assignment was not enforced")
	}
	room.close()
}

func TestVersionThreeLeaseBindsIndividualSubscriptionLayers(t *testing.T) {
	cfg, err := loadConfig(environment(validEnvironment()))
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	lease := agentLease{
		Version: 3, Type: "agent-lease", RoomID: "room-123456", Role: "primary",
		MembershipEpoch: 2, RouteEpoch: 4, LeaseExpiresAt: now.Add(30 * time.Second).UnixMilli(),
		Peers: []leasePeer{
			{ID: "0123456789abcdef", Connect: true, Publish: true, Subscribe: true},
			{ID: "fedcba9876543210", Connect: true, Subscribe: true},
		},
		Subscriptions: []subscriptionPlan{{
			SubscriberPeerID: "fedcba9876543210", PublisherPeerID: "0123456789abcdef",
			PublicationID: "camera-track", Source: "camera", Enabled: true,
			PreferredLayer: "medium", MaximumLayer: "high", Revision: 1,
		}},
		FederationLinks:   []federationLink{},
		FederationRoutes:  []federationRoute{},
		FederationDemands: []federationDemand{},
		ICEServers:        []webrtc.ICEServer{},
	}
	if err = validateLease(lease, now, cfg); err != nil {
		t.Fatal(err)
	}
	lease.Subscriptions[0].PreferredLayer = "audio"
	if err = validateLease(lease, now, cfg); err == nil {
		t.Fatal("camera subscription accepted an audio layer")
	}
}
