package main

import (
	"crypto/ecdsa"
	"crypto/sha256"
	"encoding/base64"
	"math/big"
	"os"
	"path/filepath"
	"testing"
)

func TestAgentIdentityPersistsLocallyAndSignsP1363Proofs(t *testing.T) {
	filename := filepath.Join(t.TempDir(), "identity.pem")
	identity, err := loadOrCreateAgentIdentity(filename)
	if err != nil {
		t.Fatal(err)
	}
	stat, err := os.Stat(filename)
	if err != nil {
		t.Fatal(err)
	}
	if stat.Mode().Perm()&0o077 != 0 {
		t.Fatalf("identity permissions are too broad: %o", stat.Mode().Perm())
	}
	reloaded, err := loadAgentIdentity(filename)
	if err != nil {
		t.Fatal(err)
	}
	if reloaded.publicKey != identity.publicKey || len(identity.publicKey.X) != 43 || len(identity.publicKey.Y) != 43 {
		t.Fatal("persisted P-256 public identity changed")
	}
	message := signatureMessage("edge-0123456789abcdef", "0123456789abcdef0123456789abcdef", 1_000)
	proof, err := identity.sign(message)
	if err != nil {
		t.Fatal(err)
	}
	raw, err := base64.RawURLEncoding.DecodeString(proof)
	if err != nil || len(raw) != 64 {
		t.Fatalf("unexpected P1363 proof: %v, %d bytes", err, len(raw))
	}
	digest := sha256.Sum256([]byte(message))
	r := new(big.Int).SetBytes(raw[:32])
	s := new(big.Int).SetBytes(raw[32:])
	if !ecdsa.Verify(&identity.privateKey.PublicKey, digest[:], r, s) {
		t.Fatal("P-256 proof did not verify")
	}
	otherDigest := sha256.Sum256([]byte(signatureMessage("edge-0123456789abcdef", "different-nonce", 1_000)))
	if ecdsa.Verify(&identity.privateKey.PublicKey, otherDigest[:], r, s) {
		t.Fatal("P-256 proof was not bound to the challenge")
	}
}
