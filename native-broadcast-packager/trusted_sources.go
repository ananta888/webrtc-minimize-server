package main

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"slices"
	"time"

	"github.com/ananta/webrtc-minimize-server/native-broadcast-packager/internal/trustedsframe"
)

type nativeTrustedSource struct {
	owner     *packagerAssignment
	receiver  *trustedsframe.SourceReceiver
	consentID string
	lease     trustedsframe.SourceLease
	transport *trustedSourceTransport
}

func (s *nativeTrustedSource) destroy() {
	s.receiver.Destroy()
	if s.transport != nil {
		s.transport.close()
	}
}

func (c *client) trustedSourceDeviceRef() string {
	if c.identity == nil || c.identity.privateKey == nil {
		return ""
	}
	key := c.identity.publicKey
	digest := sha256.Sum256([]byte("P-256\x00" + key.X + "\x00" + key.Y))
	return "dev_" + base64.RawURLEncoding.EncodeToString(digest[:])
}

// Parent policy is derived from local state, not from claimed lease fields.
// Assignment locks are always released before closing source receivers.
func (c *client) trustedSourceAllowed(lease trustedsframe.SourceLease, expected *packagerAssignment, now int64) bool {
	if !c.sessionAuthenticated.Load() || c.trustedSourceDeviceRef() == "" || lease.Consent.GranteePackagerRef != c.cfg.packagerID || lease.Consent.GranteeDeviceRef != c.trustedSourceDeviceRef() {
		return false
	}
	c.roomsMu.RLock()
	roomAllowed := slices.Contains(c.rooms, lease.Consent.RoomID)
	c.roomsMu.RUnlock()
	if !roomAllowed {
		return false
	}
	c.assignmentMu.Lock()
	defer c.assignmentMu.Unlock()
	a := c.assignment
	if a == nil || a != expected {
		return false
	}
	stateAllowed := oneOf(a.State, "running", "degraded")
	if o := a.sourceProgram; o != nil {
		select {
		case <-o.done:
			return false
		default:
		}
		context := o.request.SourceContext
		deadline := o.deadline.Load()
		if !o.attached.Load() || deadline == nil || !time.Now().Before(*deadline) || context.TenantID != lease.Consent.TenantID || context.RoomEpoch != lease.Consent.RoomEpoch {
			return false
		}
		stateAllowed = oneOf(a.State, "ready", "starting", "running", "degraded")
	}
	return stateAllowed && a.expiresAt.Load() > now && a.expiresAt.Load() >= lease.ExpiresAt &&
		a.AssignmentID == lease.AssignmentID && a.RoomID == lease.Consent.RoomID && a.ProgramID == lease.Consent.ProgramID && int64(a.ProgramEpoch) == lease.Consent.ProgramEpoch &&
		a.LeaseID == lease.WriterLeaseID && int64(a.FencingRevision) == lease.FencingRevision
}

// Internal control adapter entry point. No HTTP or key-bearing control message
// is introduced. The source transport must bind its publisher channel before
// exposing Announcement/AcceptKey; a prepared receiver is not media readiness.
func (c *client) prepareTrustedSource(raw []byte, now time.Time) (*trustedsframe.SourceReceiver, error) {
	lease, err := trustedsframe.ParseSourceLease(raw, now.UnixMilli())
	if err != nil {
		return nil, err
	}
	c.sourcesMu.Lock()
	defer c.sourcesMu.Unlock()
	c.pruneTrustedSourcesLocked(now.UnixMilli())
	if current := c.trustedSources[lease.SourceLeaseID]; current != nil {
		if current.transport != nil {
			err = current.receiver.RenewNow(raw)
		} else {
			err = current.receiver.Renew(raw, now.UnixMilli())
		}
		if err != nil {
			return nil, err
		}
		current.lease = lease
		return current.receiver, nil
	}
	if len(c.trustedSources) >= 80 || len(c.trustedSourceHistory) >= 512 {
		return nil, errors.New("trusted source capacity exceeded")
	}
	if _, used := c.trustedSourceHistory[lease.Consent.ConsentID]; used {
		return nil, errors.New("trusted source consent already used")
	}
	c.assignmentMu.Lock()
	expected := c.assignment
	c.assignmentMu.Unlock()
	receiver, err := trustedsframe.NewSourceReceiver(raw, c.cfg.packagerID, c.trustedSourceDeviceRef(),
		func(scope trustedsframe.SourceLease, at int64) bool {
			return c.trustedSourceAllowed(scope, expected, at)
		}, now.UnixMilli())
	if err != nil {
		return nil, err
	}
	if c.trustedSources == nil {
		c.trustedSources = make(map[string]*nativeTrustedSource)
	}
	if c.trustedSourceHistory == nil {
		c.trustedSourceHistory = make(map[string]int64)
	}
	c.trustedSources[lease.SourceLeaseID] = &nativeTrustedSource{owner: expected, receiver: receiver, consentID: lease.Consent.ConsentID, lease: lease}
	c.trustedSourceHistory[lease.Consent.ConsentID] = lease.Consent.ExpiresAt
	return receiver, nil
}

func (c *client) handleTrustedSourceControl(command *trustedsframe.SourceCommand, now time.Time) error {
	if !c.sessionAuthenticated.Load() || command == nil {
		return errors.New("source control authentication required")
	}
	// Revalidate even for internal callers; this method never accepts key data.
	raw, err := json.Marshal(command)
	if err != nil {
		return err
	}
	validated, err := trustedsframe.DecodeSourceCommand(raw)
	if err != nil {
		return err
	}
	command = &validated
	state := "failed"
	if command.Type == "trusted-source-prepare" {
		var lease trustedsframe.SourceLease
		if json.Unmarshal(command.Lease, &lease) != nil {
			return errors.New("invalid source lease")
		}
		command.SourceLeaseID, command.LeaseRevision, command.ConsentID = lease.SourceLeaseID, lease.Revision, lease.Consent.ConsentID
		command.AssignmentID, command.FencingRevision, command.ExpiresAt = lease.AssignmentID, lease.FencingRevision, lease.ExpiresAt
		if receiver, prepareErr := c.prepareTrustedSource(command.Lease, now); prepareErr == nil {
			c.sourcesMu.Lock()
			source := c.trustedSources[lease.SourceLeaseID]
			if source != nil && source.receiver == receiver {
				// The transport can advance the receiver clock while a control
				// message waits. Sample under its mutex, not at dispatch time.
				if source.transport != nil && receiver.AliveNow() || source.transport == nil && receiver.Alive(now.UnixMilli()) {
					state = "receiver-prepared"
				}
			}
			c.sourcesMu.Unlock()
		}
	} else {
		c.sourcesMu.Lock()
		source := c.trustedSources[command.SourceLeaseID]
		if source == nil {
			state = "stopped"
		} else if source.lease.Consent.ConsentID == command.ConsentID && source.lease.AssignmentID == command.AssignmentID &&
			source.lease.FencingRevision == command.FencingRevision && command.LeaseRevision >= source.lease.Revision && command.LeaseRevision <= source.lease.Revision+1 {
			source.destroy()
			delete(c.trustedSources, command.SourceLeaseID)
			state = "stopped"
		}
		c.sourcesMu.Unlock()
	}
	return c.send(map[string]any{"version": 1, "type": "trusted-source-status", "sourceLeaseId": command.SourceLeaseID,
		"leaseRevision": command.LeaseRevision, "consentId": command.ConsentID, "assignmentId": command.AssignmentID,
		"fencingRevision": command.FencingRevision, "state": state, "expiresAt": command.ExpiresAt, "observedAt": now.UnixMilli()})
}

func (c *client) pruneTrustedSourcesLocked(now int64) {
	for id, source := range c.trustedSources {
		var alive bool
		if source.transport != nil {
			alive = source.receiver.AliveNow()
		} else {
			alive = source.receiver.Alive(now)
		}
		if !alive {
			source.destroy()
			delete(c.trustedSources, id)
		}
	}
	for id, expires := range c.trustedSourceHistory {
		if expires <= now {
			delete(c.trustedSourceHistory, id)
		}
	}
}
func (c *client) pruneTrustedSources(now time.Time) {
	c.sourcesMu.Lock()
	defer c.sourcesMu.Unlock()
	c.pruneTrustedSourcesLocked(now.UnixMilli())
}
func (c *client) closeTrustedSources() {
	c.sourcesMu.Lock()
	sources := c.trustedSources
	c.trustedSources = nil
	c.sourcesMu.Unlock()
	for _, source := range sources {
		source.destroy()
	}
	// Retain bounded consent tombstones through their original expiration.
}

func (c *client) closeAssignmentTrustedSources(assignment *packagerAssignment) {
	if assignment == nil {
		return
	}
	// A successor can be admitted between detaching the old assignment and
	// acquiring sourcesMu. Wire IDs are not an ownership fence for that race.
	c.sourcesMu.Lock()
	var owned []*nativeTrustedSource
	for id, source := range c.trustedSources {
		if source.owner == assignment {
			owned = append(owned, source)
			delete(c.trustedSources, id)
		}
	}
	c.sourcesMu.Unlock()
	for _, source := range owned {
		source.destroy()
	}
	// Consent tombstones remain until their original expiry, just as on shutdown.
}
