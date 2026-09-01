package main

import (
	"context"
	"fmt"
	"net/http"
	"time"

	"github.com/gorilla/websocket"
)

func enrollAgent(ctx context.Context, cfg config, identity *agentIdentity) error {
	tlsConfig, err := cfg.tlsConfig()
	if err != nil {
		return err
	}
	dialer := websocket.Dialer{
		HandshakeTimeout:  15 * time.Second,
		TLSClientConfig:   tlsConfig,
		EnableCompression: false,
	}
	connection, response, err := dialer.DialContext(ctx, cfg.signalURL, http.Header{})
	if err != nil {
		if response != nil {
			return fmt.Errorf("enrollment websocket upgrade status %d", response.StatusCode)
		}
		return fmt.Errorf("connect enrollment websocket: %w", err)
	}
	defer connection.Close()
	connection.SetReadLimit(maximumServerControlBytes)
	_, raw, err := connection.ReadMessage()
	if err != nil {
		return fmt.Errorf("read enrollment challenge: %w", err)
	}
	challenge, err := decodeServerMessage(raw)
	if err != nil || challenge.Type != "agent-challenge" || challenge.ExpiresAt <= time.Now().UnixMilli() ||
		challenge.ExpiresAt > time.Now().Add(time.Minute).UnixMilli() {
		return fmt.Errorf("invalid enrollment challenge")
	}
	timestamp := time.Now().UnixMilli()
	proof, err := identity.sign(enrollmentProofMessage(
		cfg.agentID, challenge.Nonce, timestamp, cfg.enrollmentToken, identity.publicKey,
	))
	if err != nil {
		return err
	}
	if err = connection.WriteJSON(map[string]any{
		"version":         1,
		"type":            "enroll",
		"agentId":         cfg.agentID,
		"enrollmentToken": cfg.enrollmentToken,
		"timestamp":       timestamp,
		"publicKey":       identity.publicKey,
		"proof":           proof,
	}); err != nil {
		return fmt.Errorf("send enrollment proof: %w", err)
	}
	_, raw, err = connection.ReadMessage()
	if err != nil {
		return fmt.Errorf("read enrollment result: %w", err)
	}
	result, err := decodeServerMessage(raw)
	if err != nil || result.Type != "agent-enrolled" || result.AgentID != cfg.agentID {
		return fmt.Errorf("media-agent enrollment was rejected")
	}
	return nil
}
