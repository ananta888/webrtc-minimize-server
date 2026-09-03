package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"time"

	"github.com/pion/webrtc/v4"
)

const (
	maximumBrowserAgentControlBytes         = 256
	maximumBrowserAgentControlBufferedBytes = 64 * 1024
	maximumBrowserAgentControlMessages      = 16
	maximumBrowserAgentNegotiationSequence  = int64(9_007_199_254_740_991)
	browserAgentControlRateWindow           = 10 * time.Second
	browserAgentNegotiationTurnTimeout      = 5 * time.Second
)

type browserAgentNegotiationControl struct {
	Version    int    `json:"version"`
	Type       string `json:"type"`
	RouteEpoch int64  `json:"routeEpoch"`
	Sequence   int64  `json:"sequence"`
}

func decodeBrowserAgentNegotiationControl(raw []byte) (browserAgentNegotiationControl, error) {
	if len(raw) == 0 || len(raw) > maximumBrowserAgentControlBytes {
		return browserAgentNegotiationControl{}, fmt.Errorf("invalid browser-agent control size")
	}
	if _, err := exactRawFields(raw, "version", "type", "routeEpoch", "sequence"); err != nil {
		return browserAgentNegotiationControl{}, err
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	var message browserAgentNegotiationControl
	if err := decoder.Decode(&message); err != nil {
		return browserAgentNegotiationControl{}, fmt.Errorf("invalid browser-agent control: %w", err)
	}
	if message.Version != 1 ||
		(message.Type != "media-agent-negotiation-request" && message.Type != "media-agent-negotiation-grant") ||
		message.RouteEpoch < 1 || message.Sequence < 1 || message.Sequence > maximumBrowserAgentNegotiationSequence {
		return browserAgentNegotiationControl{}, fmt.Errorf("invalid browser-agent negotiation turn")
	}
	return message, nil
}

func (p *mediaPeer) attachNegotiationControl(channel *webrtc.DataChannel) {
	p.mu.Lock()
	if p.closed || p.control != nil && p.control != channel {
		p.mu.Unlock()
		_ = channel.Close()
		return
	}
	p.control = channel
	p.mu.Unlock()
	channel.OnOpen(func() { go p.negotiate() })
	channel.OnMessage(func(message webrtc.DataChannelMessage) {
		if !message.IsString || p.acceptNegotiationControl(message.Data) != nil {
			p.close()
		}
	})
	channel.OnClose(func() { p.close() })
}

func (p *mediaPeer) acceptNegotiationControl(raw []byte) error {
	message, err := decodeBrowserAgentNegotiationControl(raw)
	if err != nil || message.Type != "media-agent-negotiation-grant" ||
		message.RouteEpoch != p.room.routeEpoch {
		return fmt.Errorf("invalid browser-agent negotiation grant")
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.closed {
		return fmt.Errorf("peer connection closed")
	}
	now := time.Now()
	if p.controlWindowStart.IsZero() || now.Sub(p.controlWindowStart) >= browserAgentControlRateWindow {
		p.controlWindowStart = now
		p.controlMessages = 0
	}
	p.controlMessages++
	if p.controlMessages > maximumBrowserAgentControlMessages || message.Sequence != p.localNegotiationReq {
		return fmt.Errorf("unexpected browser-agent negotiation grant")
	}
	p.localNegotiationReq = 0
	p.localNegotiationAck = message.Sequence
	go p.negotiate()
	return nil
}

func (p *mediaPeer) sendNegotiationControl(messageType string, sequence int64) error {
	p.mu.Lock()
	channel := p.control
	routeEpoch := p.room.routeEpoch
	valid := !p.closed && channel != nil && channel.ReadyState() == webrtc.DataChannelStateOpen &&
		channel.BufferedAmount() <= maximumBrowserAgentControlBufferedBytes
	p.mu.Unlock()
	if !valid {
		return fmt.Errorf("browser-agent control unavailable")
	}
	raw, err := json.Marshal(browserAgentNegotiationControl{
		Version: 1, Type: messageType, RouteEpoch: routeEpoch, Sequence: sequence,
	})
	if err != nil || len(raw) > maximumBrowserAgentControlBytes {
		return fmt.Errorf("encode browser-agent control")
	}
	return channel.SendText(string(raw))
}

func (p *mediaPeer) expireNegotiationRequest(sequence int64) {
	timer := time.NewTimer(browserAgentNegotiationTurnTimeout)
	defer timer.Stop()
	<-timer.C
	p.mu.Lock()
	if p.closed || p.localNegotiationReq != sequence {
		p.mu.Unlock()
		return
	}
	p.localNegotiationReq = 0
	p.mu.Unlock()
	p.negotiate()
}
