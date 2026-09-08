package trustedsframe

import (
	"bytes"
	"crypto/ecdh"
	"encoding/base64"
	"encoding/json"
	"io"
	"regexp"
)

const maxSafeInteger = int64(9007199254740991)

var tokenPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{16,64}$`)
var roomPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{5,47}$`)
var keyIDPattern = regexp.MustCompile(`^[a-f0-9]{16}$`)

// Consent is metadata attested by the control-plane adapter, not a signed
// credential. Parsing this structure alone does not authorize any operation.
type Consent struct {
	Version            int    `json:"version"`
	Type               string `json:"type"`
	Trigger            string `json:"trigger"`
	ConsentID          string `json:"consentId"`
	TenantID           string `json:"tenantId"`
	RoomID             string `json:"roomId"`
	RoomEpoch          int64  `json:"roomEpoch"`
	ProgramID          string `json:"programId"`
	ProgramEpoch       int64  `json:"programEpoch"`
	GrantorSubjectRef  string `json:"grantorSubjectRef"`
	GranteePackagerRef string `json:"granteePackagerRef"`
	GranteeDeviceRef   string `json:"granteeDeviceRef"`
	SourceID           string `json:"sourceId"`
	SourceKind         string `json:"sourceKind"`
	Purpose            string `json:"purpose"`
	Status             string `json:"status"`
	GrantedAt          int64  `json:"grantedAt"`
	ExpiresAt          int64  `json:"expiresAt"`
}

type publicJWK struct {
	Kty    string   `json:"kty"`
	Crv    string   `json:"crv"`
	X      string   `json:"x"`
	Y      string   `json:"y"`
	Ext    bool     `json:"ext"`
	KeyOps []string `json:"key_ops"`
}

func positive(n int64) bool { return n > 0 && n <= maxSafeInteger }
func ref(value, prefix string) bool {
	return len(value) > len(prefix) && value[:len(prefix)] == prefix && tokenPattern.MatchString(value[len(prefix):])
}

// Unlike encoding/json's struct decoder, this rejects duplicate and
// case-insensitive aliases as well as unknown/missing fields and trailing JSON.
func exactObject(raw []byte, fields []string, out any) error {
	return exactObjectLimit(raw, fields, out, 8192)
}

func exactObjectLimit(raw []byte, fields []string, out any, limit int) error {
	if len(raw) == 0 || len(raw) > limit {
		return ErrKey
	}
	r := json.NewDecoder(bytes.NewReader(raw))
	first, err := r.Token()
	if err != nil || first != json.Delim('{') {
		return ErrKey
	}
	allowed := make(map[string]bool, len(fields))
	for _, key := range fields {
		allowed[key] = true
	}
	seen := make(map[string]bool, len(fields))
	for r.More() {
		token, err := r.Token()
		if err != nil {
			return ErrKey
		}
		name, ok := token.(string)
		if !ok || !allowed[name] || seen[name] {
			return ErrKey
		}
		seen[name] = true
		var value json.RawMessage
		if r.Decode(&value) != nil {
			return ErrKey
		}
	}
	last, err := r.Token()
	if err != nil || last != json.Delim('}') || len(seen) != len(fields) {
		return ErrKey
	}
	if _, err = r.Token(); err != io.EOF {
		return ErrKey
	}
	if json.Unmarshal(raw, out) != nil {
		return ErrKey
	}
	return nil
}

func parseConsent(raw []byte, now int64) (Consent, error) {
	var c Consent
	if err := exactObject(raw, []string{"version", "type", "trigger", "consentId", "tenantId", "roomId", "roomEpoch", "programId", "programEpoch", "grantorSubjectRef", "granteePackagerRef", "granteeDeviceRef", "sourceId", "sourceKind", "purpose", "status", "grantedAt", "expiresAt"}, &c); err != nil {
		return c, err
	}
	if !positive(now) || now > maxSafeInteger-600000 || c.Version != 1 || c.Type != "trusted-decrypt-consent" || c.Trigger != "user-action" || c.Purpose != "broadcast-program" || c.Status != "active" ||
		!ref(c.ConsentID, "cns_") || !ref(c.TenantID, "tn_") || !roomPattern.MatchString(c.RoomID) || !positive(c.RoomEpoch) || !ref(c.ProgramID, "prg_") || !positive(c.ProgramEpoch) ||
		!ref(c.GrantorSubjectRef, "sub_") || !ref(c.GranteePackagerRef, "pkr_") || !ref(c.GranteeDeviceRef, "dev_") || !ref(c.SourceID, "src_") ||
		!positive(c.GrantedAt) || !positive(c.ExpiresAt) || c.GrantedAt > now+5000 || c.ExpiresAt <= now || c.ExpiresAt <= c.GrantedAt || c.ExpiresAt-c.GrantedAt > 600000 {
		return c, ErrKey
	}
	switch c.SourceKind {
	case "microphone", "camera", "screen", "screen-audio":
	default:
		return c, ErrKey
	}
	return c, nil
}

func decodeURL(value string, length int) ([]byte, error) {
	if len(value) != (length*8+5)/6 {
		return nil, ErrKey
	}
	b, err := base64.RawURLEncoding.Strict().DecodeString(value)
	if err != nil || len(b) != length || base64.RawURLEncoding.EncodeToString(b) != value {
		return nil, ErrKey
	}
	return b, nil
}

func parsePublicJWK(raw []byte) (*ecdh.PublicKey, error) {
	var j publicJWK
	if exactObject(raw, []string{"kty", "crv", "x", "y", "ext", "key_ops"}, &j) != nil || j.Kty != "EC" || j.Crv != "P-256" || !j.Ext || j.KeyOps == nil || len(j.KeyOps) != 0 {
		return nil, ErrKey
	}
	x, err := decodeURL(j.X, 32)
	if err != nil {
		return nil, err
	}
	y, err := decodeURL(j.Y, 32)
	if err != nil {
		return nil, err
	}
	encoded := append(append([]byte{4}, x...), y...)
	key, err := ecdh.P256().NewPublicKey(encoded)
	if err != nil {
		return nil, ErrKey
	}
	return key, nil
}

func exportPublicJWK(key *ecdh.PublicKey) publicJWK {
	encoded := key.Bytes()
	return publicJWK{Kty: "EC", Crv: "P-256", X: base64.RawURLEncoding.EncodeToString(encoded[1:33]), Y: base64.RawURLEncoding.EncodeToString(encoded[33:]), Ext: true, KeyOps: []string{}}
}
