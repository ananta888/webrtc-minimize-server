package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net/http"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

type signalingClient struct {
	cfg   config
	agent *mediaAgent
	mu    sync.Mutex
	conn  *websocket.Conn
}

func newSignalingClient(cfg config, agent *mediaAgent) *signalingClient {
	return &signalingClient{cfg: cfg, agent: agent}
}

func (c *signalingClient) run(ctx context.Context) error {
	backoff := c.cfg.reconnectMin
	for ctx.Err() == nil {
		err := c.runConnection(ctx)
		if ctx.Err() != nil {
			return nil
		}
		if err != nil {
			log.Printf("media agent control connection ended: %v", sanitizedError(err))
		}
		timer := time.NewTimer(backoff)
		select {
		case <-ctx.Done():
			timer.Stop()
			return nil
		case <-timer.C:
		}
		backoff *= 2
		if backoff > c.cfg.reconnectMax {
			backoff = c.cfg.reconnectMax
		}
	}
	return nil
}

func (c *signalingClient) runConnection(ctx context.Context) error {
	tlsConfig, err := c.cfg.tlsConfig()
	if err != nil {
		return err
	}
	dialer := websocket.Dialer{
		HandshakeTimeout:  15 * time.Second,
		TLSClientConfig:   tlsConfig,
		EnableCompression: false,
	}
	conn, response, err := dialer.DialContext(ctx, c.cfg.signalURL, http.Header{})
	if err != nil {
		if response != nil {
			return fmt.Errorf("websocket upgrade status %d", response.StatusCode)
		}
		return fmt.Errorf("connect control websocket: %w", err)
	}
	defer conn.Close()
	conn.SetReadLimit(maximumServerControlBytes)
	c.mu.Lock()
	c.conn = conn
	c.mu.Unlock()
	defer func() {
		c.mu.Lock()
		if c.conn == conn {
			c.conn = nil
		}
		c.mu.Unlock()
	}()
	authenticated := false
	authenticatedReady := make(chan struct{})
	connectionDone := make(chan struct{})
	defer close(connectionDone)
	go func() {
		select {
		case <-ctx.Done():
			select {
			case <-authenticatedReady:
				// Consent remains authoritative on the server. This only makes a
				// planned local shutdown immediately ineligible for new leases.
				_ = c.send(map[string]any{"type": "draining", "enabled": true})
			default:
			}
			_ = conn.WriteControl(
				websocket.CloseMessage,
				websocket.FormatCloseMessage(websocket.CloseNormalClosure, "agent_shutdown"),
				time.Now().Add(time.Second),
			)
			_ = conn.Close()
		case <-connectionDone:
		}
	}()
	heartbeatDone := make(chan struct{})
	defer close(heartbeatDone)
	for {
		_, raw, readErr := conn.ReadMessage()
		if readErr != nil {
			return readErr
		}
		message, decodeErr := decodeServerMessage(raw)
		if decodeErr != nil {
			return decodeErr
		}
		switch message.Type {
		case "agent-challenge":
			if authenticated || message.ExpiresAt <= time.Now().UnixMilli() ||
				message.ExpiresAt > time.Now().Add(time.Minute).UnixMilli() {
				return fmt.Errorf("invalid authentication challenge")
			}
			timestamp := time.Now().UnixMilli()
			if err = c.send(map[string]any{
				"type": "authenticate", "agentId": c.cfg.agentID, "timestamp": timestamp,
				"proof": authProof(c.cfg.sharedSecret, c.cfg.agentID, message.Nonce, timestamp),
			}); err != nil {
				return err
			}
		case "agent-authenticated":
			if authenticated || message.AgentID != c.cfg.agentID {
				return fmt.Errorf("invalid authentication result")
			}
			authenticated = true
			close(authenticatedReady)
			if err = c.send(c.capability()); err != nil {
				return err
			}
			go c.heartbeat(ctx, heartbeatDone)
			log.Print("media agent authenticated and ready")
		case "agent-sync":
			if !authenticated {
				return fmt.Errorf("agent sync before authentication")
			}
			if err = c.agent.applySync(message.Leases, time.Now()); err != nil {
				return err
			}
		case "peer-signal":
			if !authenticated {
				return fmt.Errorf("peer signal before authentication")
			}
			if err = c.agent.handleSignal(message); err != nil {
				_ = c.send(map[string]any{"type": "peer-state", "roomId": message.RoomID,
					"peerId": message.PeerID, "routeEpoch": message.RouteEpoch, "connected": false})
			}
		case "federation-peer-signal":
			if !authenticated {
				return fmt.Errorf("federation signal before authentication")
			}
			if err = c.agent.handleFederationSignal(message); err != nil {
				_ = c.send(map[string]any{
					"version": 1, "type": "federation-state", "roomId": message.RoomID,
					"routeEpoch": message.RouteEpoch, "linkId": message.LinkID,
					"remoteAgentId": message.FromAgentID, "connected": false,
				})
			}
		case "agent-error":
			if message.Code == "agent_rate_limited" || message.Code == "agent_authentication_failed" {
				return fmt.Errorf("control rejected agent message: %s", message.Code)
			}
			log.Printf("control rejected an agent operation: %s", message.Code)
		default:
			return fmt.Errorf("unknown control message type")
		}
	}
}

func (c *signalingClient) heartbeat(ctx context.Context, done <-chan struct{}) {
	ticker := time.NewTicker(c.cfg.heartbeat)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-done:
			return
		case <-ticker.C:
			_ = c.send(map[string]any{"type": "heartbeat", "rooms": c.agent.heartbeats()})
			_ = c.send(c.capability())
		}
	}
}

func (c *signalingClient) capability() map[string]any {
	return map[string]any{
		"type": "capability", "visible": true, "battery": c.cfg.battery,
		"network": c.cfg.network, "capacity": c.cfg.capacity, "load": c.agent.loadPercent(),
		"maxRooms": c.cfg.maxRooms, "maxPeers": c.cfg.maxPeers, "maxTracks": c.cfg.maxTracks,
	}
}

func (c *signalingClient) send(value any) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.conn == nil {
		return errors.New("control websocket unavailable")
	}
	_ = c.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
	return c.conn.WriteJSON(value)
}

func sanitizedError(err error) string {
	if err == nil {
		return "unknown"
	}
	var closeError *websocket.CloseError
	if errors.As(err, &closeError) {
		return fmt.Sprintf("websocket closed (%d)", closeError.Code)
	}
	return err.Error()
}
