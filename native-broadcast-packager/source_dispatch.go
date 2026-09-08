package main

import (
	"time"

	"github.com/ananta/webrtc-minimize-server/native-broadcast-packager/internal/trustedsframe"
	"github.com/pion/webrtc/v4"
)

func (c *client) sourceConfiguration() webrtc.Configuration {
	configuration := webrtc.Configuration{ICETransportPolicy: c.cfg.iceTransportPolicy}
	c.assignmentMu.Lock()
	defer c.assignmentMu.Unlock()
	if c.assignment != nil {
		for _, entry := range c.assignment.ICEServers {
			configuration.ICEServers = append(configuration.ICEServers, webrtc.ICEServer{URLs: append([]string(nil), entry.URLs...), Username: entry.Username,
				Credential: entry.Credential, CredentialType: webrtc.ICECredentialTypePassword})
		}
	}
	if len(configuration.ICEServers) == 0 && len(c.cfg.stunURLs) > 0 {
		configuration.ICEServers = []webrtc.ICEServer{{URLs: append([]string(nil), c.cfg.stunURLs...)}}
	}
	return configuration
}

func (c *client) handleTrustedSourceSignal(input *trustedsframe.SourcePeerSignal) error {
	if input == nil || !c.sessionAuthenticated.Load() {
		return nil
	}
	message, err := trustedsframe.ParseSourcePeerSignal(sourceSignalBytes(input))
	if err != nil {
		return nil
	}
	c.sourcesMu.Lock()
	source := c.trustedSources[message.SourceLeaseID]
	if source == nil || source.lease.Consent.ConsentID != message.ConsentID || source.lease.AssignmentID != message.AssignmentID ||
		source.lease.FencingRevision != message.FencingRevision || source.lease.PublisherPeerID != message.PublisherPeerID {
		c.sourcesMu.Unlock()
		return nil
	}
	lease := source.lease
	valid := source.receiver.AliveNow()
	if valid && source.transport == nil && message.Description != nil && message.NegotiationRevision == 1 && message.Sequence == 1 && c.trustedSourceSinkFactory != nil {
		sink, sinkErr := c.trustedSourceSinkFactory(lease)
		if sinkErr == nil && sink != nil {
			source.transport, err = newTrustedSourceTransport(c, lease, source.receiver, sink, c.sourceConfiguration())
			if err != nil {
				sink.Close()
			}
		} else if sink != nil {
			sink.Close()
		}
	}
	transport := source.transport
	c.sourcesMu.Unlock()
	if valid && transport != nil && transport.handle(&message) == nil {
		return nil
	}
	// A matched source may fail, but it cannot fail or stop its parent program.
	c.sourcesMu.Lock()
	source.destroy()
	c.sourcesMu.Unlock()
	return c.send(map[string]any{"version": 1, "type": "trusted-source-status", "sourceLeaseId": lease.SourceLeaseID,
		"leaseRevision": lease.Revision, "consentId": lease.Consent.ConsentID, "assignmentId": lease.AssignmentID, "fencingRevision": lease.FencingRevision,
		"state": "failed", "expiresAt": lease.ExpiresAt, "observedAt": time.Now().UnixMilli()})
}
