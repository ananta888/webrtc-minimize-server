package trustedsframe

import (
	"encoding/json"
	"regexp"
	"sync"
	"time"
)

var publicationPattern = regexp.MustCompile(`^[A-Za-z0-9_={}:-]{1,128}$`)
var peerPattern = regexp.MustCompile(`^[a-f0-9]{16}$`)

// SourceLease is server-authorized metadata, not a self-authenticating token.
// It is accepted only from the authenticated control connection by an adapter
// that also supplies mandatory current local assignment and room policy.
type SourceLease struct {
	Version            int     `json:"version"`
	Type               string  `json:"type"`
	SourceLeaseID      string  `json:"sourceLeaseId"`
	Revision           int64   `json:"revision"`
	Consent            Consent `json:"consent"`
	AssignmentID       string  `json:"assignmentId"`
	WriterLeaseID      string  `json:"writerLeaseId"`
	FencingRevision    int64   `json:"fencingRevision"`
	PublisherPeerID    string  `json:"publisherPeerId"`
	PublisherDeviceRef string  `json:"publisherDeviceRef"`
	PublicationID      string  `json:"publicationId"`
	PublicationEpoch   int64   `json:"publicationEpoch"`
	Codec              string  `json:"codec"`
	FrameEnvelope      string  `json:"frameEnvelope"`
	IssuedAt           int64   `json:"issuedAt"`
	ExpiresAt          int64   `json:"expiresAt"`
}

func ParseSourceLease(raw []byte, now int64) (SourceLease, error) {
	var lease SourceLease
	var fields map[string]json.RawMessage
	if exactObject(raw, []string{"version", "type", "sourceLeaseId", "revision", "consent", "assignmentId", "writerLeaseId", "fencingRevision", "publisherPeerId", "publisherDeviceRef", "publicationId", "publicationEpoch", "codec", "frameEnvelope", "issuedAt", "expiresAt"}, &fields) != nil || json.Unmarshal(raw, &lease) != nil {
		return lease, ErrKey
	}
	c, err := parseConsent(fields["consent"], now)
	if err != nil {
		return lease, err
	}
	lease.Consent = c
	if lease.Version != 1 || lease.Type != "trusted-source-lease" || !ref(lease.SourceLeaseID, "sls_") || !positive(lease.Revision) || lease.Revision > 1024 ||
		!ref(lease.AssignmentID, "asn_") || !ref(lease.WriterLeaseID, "lea_") || !positive(lease.FencingRevision) || !peerPattern.MatchString(lease.PublisherPeerID) ||
		!ref(lease.PublisherDeviceRef, "dev_") || !publicationPattern.MatchString(lease.PublicationID) || !positive(lease.PublicationEpoch) || lease.FrameEnvelope != Envelope ||
		!positive(lease.IssuedAt) || !positive(lease.ExpiresAt) || lease.IssuedAt > now+1000 || lease.IssuedAt < c.GrantedAt-5000 ||
		lease.ExpiresAt <= now || lease.ExpiresAt <= lease.IssuedAt || lease.ExpiresAt-lease.IssuedAt > 5000 || lease.ExpiresAt > now+5000 || lease.ExpiresAt > c.ExpiresAt {
		return lease, ErrKey
	}
	audio := c.SourceKind == "microphone" || c.SourceKind == "screen-audio"
	if audio && lease.Codec != "audio/opus" || !audio && lease.Codec != "video/vp8" {
		return lease, ErrKey
	}
	return lease, nil
}

// SourcePolicy reads actual local authenticated-control, assignment and room
// state. It must not reenter SourceReceiver, retain a mutable lease, or grant
// authority from JSON alone. No media keys are supplied to this port.
type SourcePolicy func(SourceLease, int64) bool

type SourceReceiver struct {
	mu       sync.Mutex
	lease    SourceLease
	policy   SourcePolicy
	receiver *Receiver
	timer    *time.Timer
	deadline time.Time
	lastNow  int64
	invalid  bool
	closed   bool
	done     chan struct{}
}

func NewSourceReceiver(raw []byte, packagerRef, deviceRef string, policy SourcePolicy, now int64) (*SourceReceiver, error) {
	lease, err := ParseSourceLease(raw, now)
	if err != nil || lease.Revision != 1 || policy == nil {
		return nil, ErrKey
	}
	s := &SourceReceiver{lease: lease, policy: policy, lastNow: now, done: make(chan struct{})}
	consent, err := json.Marshal(lease.Consent)
	if err != nil {
		return nil, ErrKey
	}
	s.receiver, err = NewReceiver(consent, packagerRef, deviceRef, lease.Codec, func(c Consent, at int64) bool {
		allowed := !s.closed && !s.invalid && c == s.lease.Consent && at < s.lease.ExpiresAt && s.policy(s.lease, at)
		if !allowed {
			s.invalid = true
		}
		return allowed
	}, now)
	if err != nil {
		return nil, err
	}
	s.mu.Lock()
	s.deadline = time.Now().Add(time.Duration(lease.ExpiresAt-now) * time.Millisecond)
	s.timer = time.AfterFunc(time.Duration(lease.ExpiresAt-now)*time.Millisecond, s.expire)
	s.mu.Unlock()
	return s, nil
}

func (s *SourceReceiver) current(now int64) error {
	if s.closed {
		return ErrClosed
	}
	if s.invalid || s.receiver == nil || s.policy == nil || now < s.lastNow || now >= s.lease.ExpiresAt || !time.Now().Before(s.deadline) || !s.policy(s.lease, now) {
		s.destroy()
		return ErrClosed
	}
	s.lastNow = now
	return nil
}

func (s *SourceReceiver) Announcement(now int64) ([]byte, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.announcement(now)
}
func (s *SourceReceiver) AnnouncementNow() ([]byte, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.announcement(time.Now().UnixMilli())
}
func (s *SourceReceiver) announcement(now int64) ([]byte, error) {
	if err := s.current(now); err != nil {
		return nil, err
	}
	result, err := s.receiver.Announcement(now)
	if err == ErrClosed {
		s.destroy()
	}
	return result, err
}

// AcceptKey is called only by the dedicated authenticated publisher channel.
// The returned ACK means key installation, never successful media decoding.
// Neither base key nor private agreement key leaves this receiver.
func (s *SourceReceiver) AcceptKey(raw []byte, now int64) ([]byte, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.acceptKey(raw, now)
}
func (s *SourceReceiver) AcceptKeyNow(raw []byte) ([]byte, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.acceptKey(raw, time.Now().UnixMilli())
}
func (s *SourceReceiver) acceptKey(raw []byte, now int64) ([]byte, error) {
	if err := s.current(now); err != nil {
		return nil, err
	}
	kid, err := s.receiver.Install(raw, now)
	if err != nil {
		if err == ErrClosed {
			s.destroy()
		}
		return nil, err
	}
	var envelope keyEnvelope
	// Install already performed closed-field, cryptographic and binding checks.
	if json.Unmarshal(raw, &envelope) != nil {
		s.destroy()
		return nil, ErrKey
	}
	if err = s.current(now); err != nil {
		return nil, err
	}
	return json.Marshal(map[string]any{"version": 1, "type": "trusted-source-key-ack", "sourceLeaseId": s.lease.SourceLeaseID,
		"leaseRevision": s.lease.Revision, "consentId": s.lease.Consent.ConsentID, "agreementKeyId": envelope.AgreementKeyID,
		"envelopeId": envelope.EnvelopeID, "keyId": kid, "state": "key-installed", "expiresAt": min(s.lease.ExpiresAt, envelope.ExpiresAt)})
}

func (s *SourceReceiver) Decrypt(frame []byte, now int64) ([]byte, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.decrypt(frame, now)
}
func (s *SourceReceiver) DecryptNow(frame []byte) ([]byte, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.decrypt(frame, time.Now().UnixMilli())
}
func (s *SourceReceiver) decrypt(frame []byte, now int64) ([]byte, error) {
	if err := s.current(now); err != nil {
		return nil, err
	}
	result, err := s.receiver.Decrypt(frame, now)
	if err == ErrClosed {
		s.destroy()
	}
	if err == nil {
		if currentErr := s.current(now); currentErr != nil {
			clear(result)
			return nil, currentErr
		}
	}
	return result, err
}

func (s *SourceReceiver) Alive(now int64) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.current(now) == nil
}
func (s *SourceReceiver) AliveNow() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.current(time.Now().UnixMilli()) == nil
}

// AliveFor binds a local consumer to this receiver's complete immutable scope.
// A retained binding survives authorized renewal, not source/owner replacement.
// This neither creates a grant nor exposes keys or mutable receiver state.
func (s *SourceReceiver) AliveFor(lease SourceLease) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.current(time.Now().UnixMilli()) == nil && sourceLeaseBinding(s.lease) == sourceLeaseBinding(lease)
}

func sourceLeaseBinding(lease SourceLease) SourceLease {
	lease.Revision, lease.IssuedAt, lease.ExpiresAt = 0, 0, 0
	return lease
}

// Done signals terminal permission loss to transport owners without invoking
// callbacks under the crypto mutex. A zero receiver is already closed.
func (s *SourceReceiver) Done() <-chan struct{} {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.done == nil {
		s.done = make(chan struct{})
		close(s.done)
	}
	return s.done
}

func (s *SourceReceiver) Renew(raw []byte, now int64) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.renew(raw, now)
}
func (s *SourceReceiver) RenewNow(raw []byte) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.renew(raw, time.Now().UnixMilli())
}
func (s *SourceReceiver) renew(raw []byte, now int64) error {
	if err := s.current(now); err != nil {
		return err
	}
	next, err := ParseSourceLease(raw, now)
	if err != nil {
		return err
	}
	if next == s.lease {
		return nil
	}
	if sourceLeaseBinding(s.lease) != sourceLeaseBinding(next) || next.Revision != s.lease.Revision+1 || next.IssuedAt < s.lease.IssuedAt || next.ExpiresAt <= s.lease.ExpiresAt || !s.policy(next, now) {
		return ErrKey
	}
	s.lease = next
	s.deadline = time.Now().Add(time.Duration(next.ExpiresAt-now) * time.Millisecond)
	s.timer.Reset(time.Duration(next.ExpiresAt-now) * time.Millisecond)
	return nil
}

func (s *SourceReceiver) expire() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return
	}
	// A previous timer callback may already be waiting for the mutex during a
	// valid renewal. Check the current deadline instead of closing its successor.
	if remaining := time.Until(s.deadline); remaining > 0 {
		s.timer.Reset(remaining)
		return
	}
	s.destroy()
}
func (s *SourceReceiver) Destroy() { s.mu.Lock(); defer s.mu.Unlock(); s.destroy() }
func (s *SourceReceiver) destroy() {
	if s.closed {
		return
	}
	s.closed = true
	if s.done != nil {
		select {
		case <-s.done:
		default:
			close(s.done)
		}
	}
	if s.timer != nil {
		s.timer.Stop()
		s.timer = nil
	}
	if s.receiver != nil {
		s.receiver.Destroy()
	}
	s.policy = nil
}
