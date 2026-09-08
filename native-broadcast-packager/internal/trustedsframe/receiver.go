package trustedsframe

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdh"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"strconv"
	"sync"
	"time"
)

// Authorize must verify the immutable consent against the current local
// server-authorized source, membership and writer lease. It must not reenter
// Receiver. Nil is denied; no external JSON field substitutes for this port.
type Authorize func(Consent, int64) bool

type keyEnvelope struct {
	Version            int             `json:"version"`
	Type               string          `json:"type"`
	EnvelopeID         string          `json:"envelopeId"`
	ConsentID          string          `json:"consentId"`
	TenantID           string          `json:"tenantId"`
	RoomID             string          `json:"roomId"`
	RoomEpoch          int64           `json:"roomEpoch"`
	ProgramID          string          `json:"programId"`
	ProgramEpoch       int64           `json:"programEpoch"`
	GrantorSubjectRef  string          `json:"grantorSubjectRef"`
	GranteePackagerRef string          `json:"granteePackagerRef"`
	GranteeDeviceRef   string          `json:"granteeDeviceRef"`
	SourceID           string          `json:"sourceId"`
	SourceKind         string          `json:"sourceKind"`
	Purpose            string          `json:"purpose"`
	KeyID              string          `json:"keyId"`
	FrameEnvelope      string          `json:"frameEnvelope"`
	AgreementKeyID     string          `json:"agreementKeyId"`
	SenderPublicKey    json.RawMessage `json:"senderPublicKey"`
	CreatedAt          int64           `json:"createdAt"`
	ExpiresAt          int64           `json:"expiresAt"`
	Nonce              string          `json:"nonce"`
	Ciphertext         string          `json:"ciphertext"`
}

// Receiver owns one consent and one ephemeral agreement key. It exposes neither
// private agreement material nor unwrapped source keys. No network API is added.
type Receiver struct {
	mu           sync.Mutex
	consent      Consent
	authorize    Authorize
	private      *ecdh.PrivateKey
	agreementID  string
	announcement []byte
	decoder      *Decoder
	seen         map[string]struct{}
	keyTimers    map[uint64]*time.Timer
	timer        *time.Timer
	expiresAt    int64
	lastNow      int64
	closed       bool
}

func NewReceiver(rawConsent []byte, packagerRef, deviceRef, codec string, authorize Authorize, now int64) (*Receiver, error) {
	c, err := parseConsent(rawConsent, now)
	if err != nil {
		return nil, err
	}
	if authorize == nil || c.GranteePackagerRef != packagerRef || c.GranteeDeviceRef != deviceRef || !authorize(c, now) {
		return nil, ErrKey
	}
	audio := c.SourceKind == "microphone" || c.SourceKind == "screen-audio"
	if audio && codec != "audio/opus" || !audio && codec != "video/vp8" {
		return nil, ErrKey
	}
	expiresAt := min(c.ExpiresAt, now+600000)
	d, err := New(Envelope, codec, now, expiresAt)
	if err != nil {
		return nil, err
	}
	private, err := ecdh.P256().GenerateKey(rand.Reader)
	if err != nil {
		d.Destroy()
		return nil, ErrKey
	}
	token := make([]byte, 18)
	if _, err = rand.Read(token); err != nil {
		d.Destroy()
		return nil, ErrKey
	}
	agreementID := base64.RawURLEncoding.EncodeToString(token)
	announcement, err := json.Marshal(map[string]any{
		"version": 1, "type": "trusted-packager-key", "consentId": c.ConsentID, "granteePackagerRef": c.GranteePackagerRef, "granteeDeviceRef": c.GranteeDeviceRef,
		"roomId": c.RoomID, "roomEpoch": c.RoomEpoch, "programId": c.ProgramID, "programEpoch": c.ProgramEpoch,
		"agreementKeyId": agreementID, "publicKey": exportPublicJWK(private.PublicKey()), "issuedAt": now, "expiresAt": expiresAt,
	})
	if err != nil {
		d.Destroy()
		return nil, ErrKey
	}
	r := &Receiver{consent: c, authorize: authorize, private: private, agreementID: agreementID, announcement: announcement, decoder: d,
		seen: make(map[string]struct{}), keyTimers: make(map[uint64]*time.Timer), expiresAt: expiresAt, lastNow: now}
	r.mu.Lock()
	r.timer = time.AfterFunc(time.Duration(expiresAt-now)*time.Millisecond, r.Destroy)
	r.mu.Unlock()
	return r, nil
}

func (r *Receiver) Announcement(now int64) ([]byte, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if err := r.current(now); err != nil {
		return nil, err
	}
	return append([]byte(nil), r.announcement...), nil
}

// Install returns only the accepted KID for the adapter's later ACK. Replays
// never reset decoder state. An unauthenticated envelope consumes no key slot.
func (r *Receiver) Install(raw []byte, now int64) (string, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if err := r.current(now); err != nil {
		return "", err
	}
	var e keyEnvelope
	if exactObject(raw, []string{"version", "type", "envelopeId", "consentId", "tenantId", "roomId", "roomEpoch", "programId", "programEpoch", "grantorSubjectRef", "granteePackagerRef", "granteeDeviceRef", "sourceId", "sourceKind", "purpose", "keyId", "frameEnvelope", "agreementKeyId", "senderPublicKey", "createdAt", "expiresAt", "nonce", "ciphertext"}, &e) != nil {
		return "", ErrKey
	}
	c := r.consent
	if e.Version != 1 || e.Type != "trusted-decrypt-key" || !tokenPattern.MatchString(e.EnvelopeID) || e.ConsentID != c.ConsentID || e.TenantID != c.TenantID || e.RoomID != c.RoomID || e.RoomEpoch != c.RoomEpoch || e.ProgramID != c.ProgramID || e.ProgramEpoch != c.ProgramEpoch || e.GrantorSubjectRef != c.GrantorSubjectRef || e.GranteePackagerRef != c.GranteePackagerRef || e.GranteeDeviceRef != c.GranteeDeviceRef || e.SourceID != c.SourceID || e.SourceKind != c.SourceKind || e.Purpose != c.Purpose || !keyIDPattern.MatchString(e.KeyID) || e.FrameEnvelope != Envelope || e.AgreementKeyID != r.agreementID ||
		!positive(e.CreatedAt) || !positive(e.ExpiresAt) || e.CreatedAt > now+5000 || e.CreatedAt < c.GrantedAt-5000 || e.ExpiresAt <= now || e.ExpiresAt <= e.CreatedAt || e.ExpiresAt > r.expiresAt || e.ExpiresAt-e.CreatedAt > 60000 {
		return "", ErrKey
	}
	if _, seen := r.seen[e.EnvelopeID]; seen {
		return "", ErrReplay
	}
	if len(r.seen) >= 512 {
		return "", ErrKey
	}
	sender, err := parsePublicJWK(e.SenderPublicKey)
	if err != nil {
		return "", err
	}
	nonce, err := decodeURL(e.Nonce, 12)
	if err != nil {
		return "", err
	}
	ciphertext, err := decodeURL(e.Ciphertext, 32)
	if err != nil {
		return "", err
	}
	shared, err := r.private.ECDH(sender)
	if err != nil {
		return "", ErrAuthentication
	}
	defer clear(shared)
	block, err := aes.NewCipher(shared)
	if err != nil {
		return "", ErrAuthentication
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return "", ErrAuthentication
	}
	aad, err := json.Marshal([]any{e.Version, e.Type, e.EnvelopeID, e.ConsentID, e.TenantID, e.RoomID, e.RoomEpoch, e.ProgramID, e.ProgramEpoch, e.GrantorSubjectRef, e.GranteePackagerRef, e.GranteeDeviceRef, e.SourceID, e.SourceKind, e.Purpose, e.KeyID, e.FrameEnvelope, e.AgreementKeyID, e.CreatedAt, e.ExpiresAt})
	if err != nil {
		return "", ErrKey
	}
	base, err := aead.Open(nil, nonce, ciphertext, aad)
	if err != nil {
		return "", ErrAuthentication
	}
	defer clear(base)
	if len(base) != 16 {
		return "", ErrKey
	}
	if err = r.current(now); err != nil {
		return "", err
	}
	kid, err := strconv.ParseUint(e.KeyID, 16, 64)
	if err != nil {
		return "", ErrKey
	}
	// A bounded positive sender-clock skew never extends local key lifetime.
	expiry := min(e.ExpiresAt, now+60000)
	if err = r.decoder.Install(kid, base, now, expiry); err != nil {
		return "", err
	}
	r.seen[e.EnvelopeID] = struct{}{}
	if _, exists := r.keyTimers[kid]; !exists {
		r.keyTimers[kid] = time.AfterFunc(time.Duration(expiry-now)*time.Millisecond, func() {
			r.mu.Lock()
			defer r.mu.Unlock()
			if !r.closed {
				r.decoder.Remove(kid)
				delete(r.keyTimers, kid)
			}
		})
	}
	return e.KeyID, nil
}

func (r *Receiver) Decrypt(frame []byte, now int64) ([]byte, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if err := r.current(now); err != nil {
		return nil, err
	}
	return r.decoder.Decrypt(frame, now)
}

func (r *Receiver) Destroy() { r.mu.Lock(); defer r.mu.Unlock(); r.destroy() }
func (r *Receiver) current(now int64) error {
	if r.closed {
		return ErrClosed
	}
	if r.authorize == nil || r.decoder == nil || r.private == nil || now < r.lastNow || now >= r.expiresAt || !r.authorize(r.consent, now) {
		r.destroy()
		return ErrClosed
	}
	r.lastNow = now
	return nil
}
func (r *Receiver) destroy() {
	if r.closed {
		return
	}
	r.closed = true
	if r.timer != nil {
		r.timer.Stop()
		r.timer = nil
	}
	for _, timer := range r.keyTimers {
		timer.Stop()
	}
	clear(r.keyTimers)
	if r.decoder != nil {
		r.decoder.Destroy()
	}
	r.private = nil
	r.authorize = nil
	clear(r.seen)
	clear(r.announcement)
	r.announcement = nil
}
