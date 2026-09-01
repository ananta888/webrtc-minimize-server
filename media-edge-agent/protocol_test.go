package main

import (
	"fmt"
	"testing"
	"time"
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

func TestServerControlMessagesRequireVersionAndExactFields(t *testing.T) {
	tests := []string{
		`{"version":1,"type":"agent-challenge","nonce":"0123456789abcdef0123456789abcdef","expiresAt":20000}`,
		`{"version":1,"type":"agent-authenticated","agentId":"laptop-edge"}`,
		`{"version":1,"type":"agent-sync","leases":[]}`,
		`{"version":1,"type":"peer-signal","roomId":"room-123456","peerId":"0123456789abcdef","routeEpoch":2,"description":{"type":"offer","sdp":"v=0\\r\\n"}}`,
		`{"version":1,"type":"peer-signal","roomId":"room-123456","peerId":"0123456789abcdef","routeEpoch":2,"candidate":null}`,
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
	}
	for index, raw := range invalid {
		if _, err := decodeServerMessage([]byte(raw)); err == nil {
			t.Fatal(fmt.Sprintf("invalid control message %d accepted", index))
		}
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
