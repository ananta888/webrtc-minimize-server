package main

import (
	"errors"
	"slices"
	"sync"
	"sync/atomic"
	"time"
)

type sourceProgramGenerationFactory func(sourceProgramGenerationConfig) (*sourceProgramGeneration, error)

// This owner is published before construction. Cancellation can therefore fence
// a codec constructor without waiting for it under any client registry lock.
type sourceAssignmentOwner struct {
	request        sourceProgramAssignment
	client         *client
	assignment     *packagerAssignment
	done, finished chan struct{}
	once           sync.Once
	statusMu       sync.Mutex // Wire ordering only; never a registry lock.
	attached       atomic.Bool
	generation     atomic.Pointer[sourceProgramGeneration]
	deadline       atomic.Pointer[time.Time]
}

func (o *sourceAssignmentOwner) cancel() {
	o.once.Do(func() { close(o.done) })
	if p := o.generation.Load(); p != nil {
		p.Close()
	}
}

func (o *sourceAssignmentOwner) permitted() bool {
	select {
	case <-o.done:
		return false
	default:
	}
	c, a := o.client, o.assignment
	if !c.sessionAuthenticated.Load() || c.trustedSourceDeviceRef() != o.request.SourceContext.GranteeDeviceRef {
		return false
	}
	c.roomsMu.RLock()
	defer c.roomsMu.RUnlock()
	if !slices.Contains(c.rooms, a.RoomID) {
		return false
	}
	c.assignmentMu.Lock()
	defer c.assignmentMu.Unlock()
	now := time.Now()
	deadline := o.deadline.Load()
	return c.assignment == a && a.sourceProgram == o && oneOf(a.State, "ready", "starting", "running", "degraded") && a.expiresAt.Load() > now.UnixMilli() && deadline != nil && now.Before(*deadline)
}

// Internal v4 entry, not wired to the public dispatcher until the source/renew/
// recovery gates are complete. Resource budgets come from a LOCAL caller;
// assignment JSON cannot choose directories, executables or allocation budgets.
func (c *client) prepareSourceProgramAssignment(raw []byte, now time.Time, local sourceProgramGenerationConfig, create sourceProgramGenerationFactory) error {
	r, err := parseSourceProgramAssignment(raw, now)
	if err != nil {
		return err
	}
	scope, err := r.scopeForDevice(c.trustedSourceDeviceRef(), now)
	if err != nil || !c.sessionAuthenticated.Load() {
		return errors.New("source assignment authority denied")
	}
	if len(r.Profile.Renditions) > c.cfg.maximumRenditions || !slices.Contains(c.capability.videoEncoders, r.Profile.VideoEncoder) || !slices.Contains(c.capability.audioEncoders, "aac") {
		return errors.New("source assignment capability denied")
	}
	pixels := 0
	for _, rendition := range r.Profile.Renditions {
		pixels += rendition.Width * rendition.Height * rendition.FramesPerSecond
	}
	if pixels > c.cfg.maximumPixelsPerSecond || local.encoder.width*local.encoder.height*local.encoder.fps > c.cfg.maximumPixelsPerSecond {
		return errors.New("source assignment pixel budget denied")
	}
	a := &packagerAssignment{AssignmentID: r.AssignmentID, RoomID: r.RoomID, ProgramID: r.ProgramID, ProgramEpoch: int(r.ProgramEpoch), LeaseID: r.LeaseID,
		FencingRevision: int(r.FencingRevision), ResourceRef: r.ResourceRef, Profile: r.Profile, ICEServers: r.ICEServers, State: "ready"}
	a.expiresAt.Store(r.ExpiresAt)
	o := &sourceAssignmentOwner{request: r, client: c, assignment: a, done: make(chan struct{}), finished: make(chan struct{})}
	started := time.Now()
	deadline := started.Add(time.Duration(r.ExpiresAt-started.UnixMilli()) * time.Millisecond)
	o.deadline.Store(&deadline)
	a.sourceProgram = o
	local.scope, local.now = scope, time.Now
	local.encoder.ffmpegPath, local.encoder.outputRoot = c.cfg.ffmpegPath, c.cfg.outputRoot
	local.encoder.packagerID, local.encoder.resourceRef, local.encoder.profile = c.cfg.packagerID, r.ResourceRef, r.Profile
	local.encoder.authorized, local.encoder.revoked = o.permitted, o.done
	if !validSourceProgramGeneration(local) {
		return errors.New("source assignment local budget denied")
	}
	c.roomsMu.RLock()
	c.assignmentMu.Lock()
	at := time.Now().UnixMilli()
	for id, until := range c.sourceAssignmentHistory {
		if until <= at {
			delete(c.sourceAssignmentHistory, id)
		}
	}
	_, replay := c.sourceAssignmentHistory[r.AssignmentID]
	allowed := c.sessionAuthenticated.Load() && slices.Contains(c.rooms, r.RoomID) && c.assignment == nil && r.ExpiresAt > at && !replay && len(c.sourceAssignmentHistory) < 512
	if allowed {
		if c.sourceAssignmentHistory == nil {
			c.sourceAssignmentHistory = make(map[string]int64)
		}
		c.sourceAssignmentHistory[r.AssignmentID] = r.ExpiresAt
		c.assignment = a
		c.thermalState = false
	}
	c.assignmentMu.Unlock()
	c.roomsMu.RUnlock()
	if !allowed {
		return errors.New("source assignment reservation denied")
	}
	go o.watchAuthority()
	if create == nil {
		create = newSourceProgramGeneration
	}
	p, err := create(local) // No assignment/source/room registry lock held.
	if err != nil || p == nil || !o.permitted() {
		o.cancel()
		if p != nil {
			p.Close()
			<-p.finished
		}
		close(o.finished)
		c.assignmentMu.Lock()
		if c.assignment == a {
			a.State = "failed"
			c.assignment = nil
		}
		c.assignmentMu.Unlock()
		return errors.New("source assignment construction failed or revoked")
	}
	o.generation.Store(p)
	// Close may have won between the check and store. No source is admitted yet.
	if !o.permitted() {
		o.cancel()
	}
	o.attached.Store(true)
	go o.watch(p)
	if !o.permitted() {
		<-o.finished
		return errors.New("source assignment commit revoked")
	}
	// Ready means the bounded local generation exists, not that an approved
	// source has arrived, decoded, or appeared in its output (which may be slate).
	if err = o.sendReady(); err != nil {
		o.cancel()
		<-o.finished
		return err
	}
	return nil
}

func (o *sourceAssignmentOwner) sendReady() error {
	o.statusMu.Lock()
	defer o.statusMu.Unlock()
	if !o.permitted() {
		return errors.New("source assignment status revoked")
	}
	return o.client.send(o.client.assignmentStatus(o.assignment, "ready", "CAPABILITY_READY"))
}

func (o *sourceAssignmentOwner) watch(p *sourceProgramGeneration) {
	select {
	case <-o.done:
		p.Close()
		<-p.finished
	case <-p.finished:
	}
	o.cancel()
	o.attached.Store(false)
	close(o.finished) // A terminal status callback must not wait on itself.
	_ = o.client.transitionAssignment(o.assignment, "failed", "SOURCE_PROGRAM_STOPPED")
}

func (o *sourceAssignmentOwner) watchAuthority() {
	ticker := time.NewTicker(20 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-o.done:
			return
		case <-o.finished:
			return
		case <-ticker.C:
			if !o.permitted() {
				o.cancel()
				return
			}
		}
	}
}

func (c *client) setConsentedRooms(rooms []string) {
	c.roomsMu.Lock()
	c.rooms = append([]string(nil), rooms...)
	c.assignmentMu.Lock()
	var revoked *sourceAssignmentOwner
	if a := c.assignment; a != nil && a.sourceProgram != nil && !slices.Contains(rooms, a.RoomID) {
		revoked = a.sourceProgram
		// Only the constant-time fence under registry locks; no codec/IO close.
		revoked.once.Do(func() { close(revoked.done) })
	}
	c.assignmentMu.Unlock()
	c.roomsMu.Unlock()
	if revoked != nil {
		revoked.cancel()
	}
}

func (c *client) closeAssignmentResources(a *packagerAssignment) {
	if a == nil {
		return
	}
	c.closeAssignmentTrustedResources(a)
	if a.Media != nil {
		a.Media.close()
	}
}

func (c *client) closeAssignmentTrustedResources(a *packagerAssignment) {
	if a == nil {
		return
	}
	if a.sourceProgram != nil {
		a.sourceProgram.cancel()
	}
	c.closeAssignmentTrustedSources(a)
	if a.sourceProgram != nil {
		<-a.sourceProgram.finished
		// Do not let an in-flight ready response follow STOP_COMPLETE. The
		// actual control writer is bounded; no assignment/source lock is held.
		a.sourceProgram.statusMu.Lock()
		a.sourceProgram.statusMu.Unlock()
	}
}
