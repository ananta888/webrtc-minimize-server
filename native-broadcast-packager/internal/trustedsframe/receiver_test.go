package trustedsframe

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdh"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func consentFixture() Consent {
	return Consent{Version: 1, Type: "trusted-decrypt-consent", Trigger: "user-action", ConsentID: "cns_aaaaaaaaaaaaaaaa", TenantID: "tn_aaaaaaaaaaaaaaaa",
		RoomID: "room-alpha", RoomEpoch: 11, ProgramID: "prg_aaaaaaaaaaaaaaaa", ProgramEpoch: 7, GrantorSubjectRef: "sub_cccccccccccccccc",
		GranteePackagerRef: "pkr_dddddddddddddddd", GranteeDeviceRef: "dev_eeeeeeeeeeeeeeee", SourceID: "src_aaaaaaaaaaaaaaaa", SourceKind: "camera",
		Purpose: "broadcast-program", Status: "active", GrantedAt: now - 1000, ExpiresAt: now + 120000}
}

func jsonBytes(t testing.TB, value any) []byte {
	t.Helper()
	b, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return b
}
func receiverFixture(t *testing.T, c Consent, policy Authorize) *Receiver {
	t.Helper()
	codec := "video/vp8"
	if c.SourceKind == "microphone" || c.SourceKind == "screen-audio" {
		codec = "audio/opus"
	}
	r, err := NewReceiver(jsonBytes(t, c), c.GranteePackagerRef, c.GranteeDeviceRef, codec, policy, now)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(r.Destroy)
	return r
}

func sealedFixture(t *testing.T, r *Receiver, expiresAt int64) keyEnvelope {
	t.Helper()
	c := r.consent
	sender, err := ecdh.P256().GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	shared, err := sender.ECDH(r.private.PublicKey())
	if err != nil {
		t.Fatal(err)
	}
	defer clear(shared)
	blk, err := aes.NewCipher(shared)
	if err != nil {
		t.Fatal(err)
	}
	aead, err := cipher.NewGCM(blk)
	if err != nil {
		t.Fatal(err)
	}
	e := keyEnvelope{Version: 1, Type: "trusted-decrypt-key", EnvelopeID: "aaaaaaaaaaaaaaaaaaaaaaaa", ConsentID: c.ConsentID, TenantID: c.TenantID, RoomID: c.RoomID,
		RoomEpoch: c.RoomEpoch, ProgramID: c.ProgramID, ProgramEpoch: c.ProgramEpoch, GrantorSubjectRef: c.GrantorSubjectRef, GranteePackagerRef: c.GranteePackagerRef,
		GranteeDeviceRef: c.GranteeDeviceRef, SourceID: c.SourceID, SourceKind: c.SourceKind, Purpose: c.Purpose, KeyID: "0000000000000123", FrameEnvelope: Envelope,
		AgreementKeyID: r.agreementID, SenderPublicKey: jsonBytes(t, exportPublicJWK(sender.PublicKey())), CreatedAt: now, ExpiresAt: expiresAt}
	aad := jsonBytes(t, []any{e.Version, e.Type, e.EnvelopeID, e.ConsentID, e.TenantID, e.RoomID, e.RoomEpoch, e.ProgramID, e.ProgramEpoch, e.GrantorSubjectRef, e.GranteePackagerRef, e.GranteeDeviceRef, e.SourceID, e.SourceKind, e.Purpose, e.KeyID, e.FrameEnvelope, e.AgreementKeyID, e.CreatedAt, e.ExpiresAt})
	nonce := make([]byte, 12)
	if _, err = rand.Read(nonce); err != nil {
		t.Fatal(err)
	}
	e.Nonce = base64.RawURLEncoding.EncodeToString(nonce)
	e.Ciphertext = base64.RawURLEncoding.EncodeToString(aead.Seal(nil, nonce, base, aad))
	return e
}

func TestReceiverKeyAgreementAndReplay(t *testing.T) {
	c := consentFixture()
	r := receiverFixture(t, c, func(got Consent, _ int64) bool { return got == c })
	announcement, err := r.Announcement(now)
	if err != nil {
		t.Fatal(err)
	}
	var a map[string]json.RawMessage
	if json.Unmarshal(announcement, &a) != nil {
		t.Fatal("announcement")
	}
	if len(a) != 13 {
		t.Fatal("unexpected announcement fields")
	}
	if _, err = parsePublicJWK(a["publicKey"]); err != nil {
		t.Fatal(err)
	}
	announcement[0] = '!'
	if next, err := r.Announcement(now); err != nil || next[0] != '{' {
		t.Fatal("announcement alias")
	}
	e := sealedFixture(t, r, now+60000)
	wire := jsonBytes(t, e)
	var ok atomic.Int32
	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if kid, err := r.Install(wire, now); err == nil && kid == e.KeyID {
				ok.Add(1)
			}
		}()
	}
	wg.Wait()
	if ok.Load() != 1 {
		t.Fatal("concurrent key replay", ok.Load())
	}
	f, plain := frame(t, r.decoder, 291, 350, true)
	out, err := r.Decrypt(f, now)
	if err != nil || !bytes.Equal(out, plain) {
		t.Fatal("installed key did not decrypt", err)
	}
	if _, err = r.Decrypt(f, now); err != ErrReplay {
		t.Fatal("frame replay", err)
	}
	if len(r.seen) != 1 {
		t.Fatal("key replay history")
	}
	r.Destroy()
	r.Destroy()
	if r.private != nil || r.authorize != nil || r.announcement != nil || len(r.keyTimers) != 0 || len(r.decoder.keys) != 0 {
		t.Fatal("reachable secret or timer retained")
	}
	if _, err = r.Install(wire, now); err != ErrClosed {
		t.Fatal("revoked install")
	}
}

func TestReceiverRejectsScopeAndCiphertextTampering(t *testing.T) {
	c := consentFixture()
	r := receiverFixture(t, c, func(Consent, int64) bool { return true })
	e := sealedFixture(t, r, now+60000)
	var original map[string]any
	json.Unmarshal(jsonBytes(t, e), &original)
	patches := map[string]any{"version": 2, "type": "other", "envelopeId": "bbbbbbbbbbbbbbbbbbbbbbbb", "consentId": "cns_bbbbbbbbbbbbbbbb", "tenantId": "tn_bbbbbbbbbbbbbbbb",
		"roomId": "room-other", "roomEpoch": 12, "programId": "prg_bbbbbbbbbbbbbbbb", "programEpoch": 8, "grantorSubjectRef": "sub_bbbbbbbbbbbbbbbb",
		"granteePackagerRef": "pkr_bbbbbbbbbbbbbbbb", "granteeDeviceRef": "dev_bbbbbbbbbbbbbbbb", "sourceId": "src_bbbbbbbbbbbbbbbb", "sourceKind": "screen",
		"purpose": "record-media", "keyId": "0000000000000124", "frameEnvelope": "codec-prefix-v2", "agreementKeyId": "bbbbbbbbbbbbbbbbbbbbbbbb", "createdAt": now + 1, "expiresAt": now + 59999,
		"nonce": base64.RawURLEncoding.EncodeToString(make([]byte, 12)), "ciphertext": base64.RawURLEncoding.EncodeToString(make([]byte, 32))}
	for field, value := range patches {
		t.Run(field, func(t *testing.T) {
			m := make(map[string]any)
			for k, v := range original {
				m[k] = v
			}
			m[field] = value
			if _, err := r.Install(jsonBytes(t, m), now); err == nil {
				t.Fatal("tamper accepted")
			}
		})
	}
	other := receiverFixture(t, c, func(Consent, int64) bool { return true })
	swapped := e
	swapped.AgreementKeyID = other.agreementID
	if _, err := other.Install(jsonBytes(t, swapped), now); err != ErrAuthentication {
		t.Fatal("wrong private agreement key", err)
	}
	if len(r.seen) != 0 || len(r.decoder.keys) != 0 {
		t.Fatal("invalid envelopes allocated keys")
	}
	if _, err := r.Install(jsonBytes(t, e), now); err != nil {
		t.Fatal("tamper poisoned valid envelope", err)
	}
}

func TestReceiverStrictJSONAndCoordinates(t *testing.T) {
	c := consentFixture()
	r := receiverFixture(t, c, func(Consent, int64) bool { return true })
	e := sealedFixture(t, r, now+60000)
	wire := jsonBytes(t, e)
	for _, raw := range [][]byte{append(wire, []byte(" {}")...), bytes.Replace(wire, []byte(`"version":1`), []byte(`"version":1,"version":1`), 1), bytes.Replace(wire, []byte(`"version":1`), []byte(`"Version":1`), 1), bytes.Repeat([]byte(" "), 8193)} {
		if _, err := r.Install(raw, now); err == nil {
			t.Fatal("non-closed JSON")
		}
	}
	var jwk map[string]any
	json.Unmarshal(e.SenderPublicKey, &jwk)
	for _, patch := range []map[string]any{{"d": "forbidden"}, {"key_ops": nil}, {"key_ops": []string{"deriveKey"}}, {"ext": false}, {"crv": "P-384"}, {"x": base64.RawURLEncoding.EncodeToString(make([]byte, 32)), "y": base64.RawURLEncoding.EncodeToString(make([]byte, 32))}, {"x": jwk["x"].(string) + "="}} {
		value := make(map[string]any)
		for k, v := range jwk {
			value[k] = v
		}
		for k, v := range patch {
			value[k] = v
		}
		bad := e
		bad.SenderPublicKey = jsonBytes(t, value)
		if _, err := r.Install(jsonBytes(t, bad), now); err == nil {
			t.Fatal("invalid JWK accepted")
		}
	}
	bad := e
	bad.SenderPublicKey = bytes.Replace(e.SenderPublicKey, []byte(`"kty":"EC"`), []byte(`"kty":"EC","kty":"EC"`), 1)
	if _, err := r.Install(jsonBytes(t, bad), now); err == nil {
		t.Fatal("duplicate nested key")
	}
	if _, err := r.Install(wire, now); err != nil {
		t.Fatal(err)
	}
}

func TestReceiverPolicyAndExpiry(t *testing.T) {
	c := consentFixture()
	raw := jsonBytes(t, c)
	for _, policy := range []Authorize{nil, func(Consent, int64) bool { return false }} {
		if _, err := NewReceiver(raw, c.GranteePackagerRef, c.GranteeDeviceRef, "video/vp8", policy, now); err == nil {
			t.Fatal("missing policy accepted")
		}
	}
	for _, target := range [][3]string{{"pkr_bbbbbbbbbbbbbbbb", c.GranteeDeviceRef, "video/vp8"}, {c.GranteePackagerRef, "dev_bbbbbbbbbbbbbbbb", "video/vp8"}, {c.GranteePackagerRef, c.GranteeDeviceRef, "audio/opus"}} {
		if _, err := NewReceiver(raw, target[0], target[1], target[2], func(Consent, int64) bool { return true }, now); err == nil {
			t.Fatal("target/codec mismatch")
		}
	}
	var permitted atomic.Bool
	permitted.Store(true)
	r := receiverFixture(t, c, func(got Consent, _ int64) bool { return permitted.Load() && got == c })
	e := sealedFixture(t, r, now+60000)
	if _, err := r.Install(jsonBytes(t, e), now); err != nil {
		t.Fatal(err)
	}
	f, _ := frame(t, r.decoder, 291, 350, true)
	permitted.Store(false)
	if _, err := r.Decrypt(f, now); err != ErrClosed {
		t.Fatal("policy revoke", err)
	}
	permitted.Store(true)
	if _, err := r.Announcement(now); err != ErrClosed {
		t.Fatal("revoked receiver revived")
	}
	for _, step := range []int64{now - 1, c.ExpiresAt} {
		fresh := receiverFixture(t, c, func(Consent, int64) bool { return true })
		if _, err := fresh.Announcement(step); err != ErrClosed {
			t.Fatal("clock/expiry", err)
		}
	}
}

func waitUntil(t *testing.T, condition func() bool) {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	for !condition() {
		if time.Now().After(deadline) {
			t.Fatal("timer cleanup did not complete")
		}
		time.Sleep(time.Millisecond)
	}
}
func TestReceiverActiveTimerCleanup(t *testing.T) {
	c := consentFixture()
	r := receiverFixture(t, c, func(Consent, int64) bool { return true })
	e := sealedFixture(t, r, now+30)
	if _, err := r.Install(jsonBytes(t, e), now); err != nil {
		t.Fatal(err)
	}
	waitUntil(t, func() bool {
		r.mu.Lock()
		defer r.mu.Unlock()
		return len(r.keyTimers) == 0 && len(r.decoder.keys) == 0
	})
	if _, err := r.Install(jsonBytes(t, e), now+31); err == nil {
		t.Fatal("expired key revived")
	}
	c.ExpiresAt = now + 30
	fresh := receiverFixture(t, c, func(Consent, int64) bool { return true })
	waitUntil(t, func() bool {
		fresh.mu.Lock()
		defer fresh.mu.Unlock()
		return fresh.closed && fresh.private == nil && fresh.timer == nil
	})
}

func TestReceiverRechecksPolicyBeforeKeyInstall(t *testing.T) {
	c := consentFixture()
	calls := 0
	r := receiverFixture(t, c, func(Consent, int64) bool { calls++; return calls < 3 })
	e := sealedFixture(t, r, now+60000)
	if _, err := r.Install(jsonBytes(t, e), now); err != ErrClosed || !r.closed || len(r.decoder.keys) != 0 {
		t.Fatal("policy loss during unwrap did not close receiver", err)
	}
	var zero Receiver
	if _, err := zero.Announcement(now); err != ErrClosed {
		t.Fatal("uninitialized receiver accepted")
	}
	zero.Destroy()
}

func TestConsentClosedFieldsAndTimeBounds(t *testing.T) {
	c := consentFixture()
	raw := jsonBytes(t, c)
	var fields map[string]any
	json.Unmarshal(raw, &fields)
	for field := range fields {
		bad := make(map[string]any)
		for k, v := range fields {
			bad[k] = v
		}
		bad[field] = nil
		if _, err := parseConsent(jsonBytes(t, bad), now); err == nil {
			t.Fatal("null consent field", field)
		}
	}
	for _, value := range [][]byte{append(raw, []byte(" {}")...), bytes.Replace(raw, []byte(`"version":1`), []byte(`"version":1,"version":1`), 1), bytes.Replace(raw, []byte(`"version":1`), []byte(`"Version":1`), 1)} {
		if _, err := parseConsent(value, now); err == nil {
			t.Fatal("ambiguous consent JSON")
		}
	}
	for _, patch := range []map[string]any{{"grantedAt": now + 5001}, {"expiresAt": now}, {"expiresAt": now + 600000}, {"roomEpoch": maxSafeInteger + 1}, {"status": "revoked"}, {"trigger": "remote-signal"}, {"sourceKind": "chat"}} {
		bad := make(map[string]any)
		for k, v := range fields {
			bad[k] = v
		}
		for k, v := range patch {
			bad[k] = v
		}
		if _, err := parseConsent(jsonBytes(t, bad), now); err == nil {
			t.Fatal("invalid consent bounds")
		}
	}
}

func FuzzConsentAndPublicKey(f *testing.F) {
	f.Add(jsonBytes(f, consentFixture()))
	keyBytes := make([]byte, 32)
	keyBytes[31] = 1
	key, err := ecdh.P256().NewPrivateKey(keyBytes)
	if err != nil {
		f.Fatal(err)
	}
	f.Add(jsonBytes(f, exportPublicJWK(key.PublicKey())))
	f.Add([]byte(`{"version":1,"version":1}`))
	f.Fuzz(func(t *testing.T, raw []byte) {
		if c, err := parseConsent(raw, now); err == nil && (c.Status != "active" || c.ExpiresAt <= now || c.ExpiresAt-c.GrantedAt > 600000) {
			t.Fatal("invalid consent accepted")
		}
		if k, err := parsePublicJWK(raw); err == nil && (k == nil || len(k.Bytes()) != 65) {
			t.Fatal("invalid public key accepted")
		}
	})
}

// Interactive test-only bridge: native public announcement first, browser
// envelope and synthetic frames through stdin next. Never installed in main.
func TestReceiverBrowserInterop(t *testing.T) {
	if os.Getenv("TRUSTED_SFRAME_RECEIVER_INTEROP") != "1" {
		t.Skip("requires browser response to native ephemeral announcement")
	}
	c := consentFixture()
	codec := os.Getenv("TRUSTED_SFRAME_RECEIVER_CODEC")
	if codec == "audio/opus" {
		c.SourceKind = "microphone"
	} else if codec != "video/vp8" {
		t.Fatal("invalid fixture codec")
	}
	r := receiverFixture(t, c, func(got Consent, _ int64) bool { return got == c })
	announcement, err := r.Announcement(now)
	if err != nil {
		t.Fatal(err)
	}
	fmt.Println(string(jsonBytes(t, map[string]any{"announcement": json.RawMessage(announcement), "consent": c, "now": now, "codec": codec})))
	var input struct {
		Envelope json.RawMessage
		Frames   []struct {
			Wire  string
			Plain string
		}
	}
	d := json.NewDecoder(io.LimitReader(os.Stdin, 4*1024*1024))
	d.DisallowUnknownFields()
	if d.Decode(&input) != nil || len(input.Frames) != 401 {
		t.Fatal("invalid browser fixture")
	}
	if _, err = r.Install(input.Envelope, now); err != nil {
		t.Fatal("browser key envelope", err)
	}
	for i, f := range input.Frames {
		out, err := r.Decrypt(fromHex(t, f.Wire), now+int64(i))
		if err != nil || !bytes.Equal(out, fromHex(t, f.Plain)) {
			t.Fatalf("browser frame %d: %v", i, err)
		}
	}
	if _, err = r.Install(input.Envelope, now+400); err != ErrReplay {
		t.Fatal("browser key replay", err)
	}
	r.Destroy()
	if _, err = r.Decrypt(fromHex(t, input.Frames[400].Wire), now+400); err != ErrClosed {
		t.Fatal("browser revoke", err)
	}
}
