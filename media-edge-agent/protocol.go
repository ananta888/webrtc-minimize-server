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

var (
	peerIDPattern  = regexp.MustCompile(`^[a-f0-9]{16}$`)
	roomIDPattern  = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{5,47}$`)
	trackIDPattern = regexp.MustCompile(`^[A-Za-z0-9_={}:-]{1,128}$`)
	noncePattern   = regexp.MustCompile(`^[A-Za-z0-9_-]{32}$`)
	codePattern    = regexp.MustCompile(`^[a-z0-9_]{1,64}$`)
)

type serverMessage struct {
	Version     int                        `json:"version"`
	Type        string                     `json:"type"`
	Nonce       string                     `json:"nonce"`
	ExpiresAt   int64                      `json:"expiresAt"`
	AgentID     string                     `json:"agentId"`
	Code        string                     `json:"code"`
	Leases      []agentLease               `json:"leases"`
	RoomID      string                     `json:"roomId"`
	PeerID      string                     `json:"peerId"`
	RouteEpoch  int64                      `json:"routeEpoch"`
	Description *webrtc.SessionDescription `json:"description"`
	Candidate   json.RawMessage            `json:"candidate"`
}

type agentLease struct {
	Version         int                `json:"version"`
	Type            string             `json:"type"`
	RoomID          string             `json:"roomId"`
	Role            string             `json:"role"`
	MembershipEpoch int64              `json:"membershipEpoch"`
	RouteEpoch      int64              `json:"routeEpoch"`
	LeaseExpiresAt  int64              `json:"leaseExpiresAt"`
	Peers           []leasePeer        `json:"peers"`
	ICEServers      []webrtc.ICEServer `json:"iceServers"`
}

type leasePeer struct {
	ID      string `json:"id"`
	Publish bool   `json:"publish,omitempty"`
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
	if len(raw) == 0 || len(raw) > 96*1024 {
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
	if message.Type == "agent-authenticated" && !agentIDPattern.MatchString(message.AgentID) {
		return serverMessage{}, fmt.Errorf("invalid authenticated agent")
	}
	if message.Type == "agent-error" && !codePattern.MatchString(message.Code) {
		return serverMessage{}, fmt.Errorf("invalid agent error")
	}
	if message.Type == "peer-signal" {
		if !roomIDPattern.MatchString(message.RoomID) || !peerIDPattern.MatchString(message.PeerID) || message.RouteEpoch < 1 {
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
	if (lease.Version != 1 && lease.Version != 2) || lease.Type != "agent-lease" || !roomIDPattern.MatchString(lease.RoomID) ||
		!oneOf(lease.Role, "primary", "standby") || lease.MembershipEpoch < 1 || lease.RouteEpoch < 1 ||
		lease.LeaseExpiresAt <= now.UnixMilli() || lease.LeaseExpiresAt > now.Add(120*time.Second).UnixMilli() ||
		len(lease.Peers) > limits.maxPeers ||
		len(lease.ICEServers) > 24 {
		return fmt.Errorf("invalid agent lease")
	}
	seen := map[string]bool{}
	for _, peer := range lease.Peers {
		if !peerIDPattern.MatchString(peer.ID) || seen[peer.ID] {
			return fmt.Errorf("invalid agent lease peer")
		}
		seen[peer.ID] = true
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
