package main

import (
	"bytes"
	"encoding/json"
	"fmt"
)

const maximumFederationControlBytes = 4096

type federationControlMessage struct {
	Version          int    `json:"version"`
	Type             string `json:"type"`
	RoomID           string `json:"roomId"`
	RouteEpoch       int64  `json:"routeEpoch"`
	LinkID           string `json:"linkId"`
	AgentID          string `json:"agentId"`
	LeaseExpiresAt   int64  `json:"leaseExpiresAt"`
	Accepted         bool   `json:"accepted"`
	Sequence         int64  `json:"sequence"`
	ReceivedPackets  int64  `json:"receivedPackets"`
	ForwardedPackets int64  `json:"forwardedPackets"`
	DroppedPackets   int64  `json:"droppedPackets"`
}

func decodeFederationControl(raw []byte) (federationControlMessage, error) {
	if len(raw) == 0 || len(raw) > maximumFederationControlBytes {
		return federationControlMessage{}, fmt.Errorf("invalid federation control size")
	}
	var header struct {
		Version int    `json:"version"`
		Type    string `json:"type"`
	}
	if json.Unmarshal(raw, &header) != nil || header.Version != 1 {
		return federationControlMessage{}, fmt.Errorf("invalid federation control version")
	}
	var fields []string
	switch header.Type {
	case "federation-hello":
		fields = []string{"version", "type", "roomId", "routeEpoch", "linkId", "agentId", "leaseExpiresAt"}
	case "federation-ack":
		fields = []string{"version", "type", "roomId", "routeEpoch", "linkId", "agentId", "accepted"}
	case "federation-negotiation-request", "federation-negotiation-grant":
		fields = []string{"version", "type", "roomId", "routeEpoch", "linkId", "agentId", "sequence"}
	case "federation-stats":
		fields = []string{
			"version", "type", "roomId", "routeEpoch", "linkId", "agentId", "sequence",
			"receivedPackets", "forwardedPackets", "droppedPackets",
		}
	default:
		return federationControlMessage{}, fmt.Errorf("unknown federation control type")
	}
	if _, err := exactRawFields(raw, fields...); err != nil {
		return federationControlMessage{}, err
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	var message federationControlMessage
	if err := decoder.Decode(&message); err != nil {
		return federationControlMessage{}, fmt.Errorf("invalid federation control: %w", err)
	}
	if !roomIDPattern.MatchString(message.RoomID) || message.RouteEpoch < 1 ||
		!linkIDPattern.MatchString(message.LinkID) || !agentIDPattern.MatchString(message.AgentID) {
		return federationControlMessage{}, fmt.Errorf("invalid federation control route")
	}
	if message.Type == "federation-hello" && message.LeaseExpiresAt < 1 {
		return federationControlMessage{}, fmt.Errorf("invalid federation hello")
	}
	if (message.Type == "federation-negotiation-request" || message.Type == "federation-negotiation-grant") &&
		message.Sequence < 1 {
		return federationControlMessage{}, fmt.Errorf("invalid federation negotiation sequence")
	}
	if message.Sequence < 0 || message.ReceivedPackets < 0 || message.ForwardedPackets < 0 ||
		message.DroppedPackets < 0 {
		return federationControlMessage{}, fmt.Errorf("invalid federation counters")
	}
	return message, nil
}
