package main

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"testing"
)

func TestConfigRequiresExactSecureOutboundEndpoint(t *testing.T) {
	values := map[string]string{
		"NATIVE_PACKAGER_CONTROL_URL":   "wss://webrtc.example/native-packager",
		"NATIVE_PACKAGER_ID":            "pkr_0123456789abcdef",
		"NATIVE_PACKAGER_IDENTITY_FILE": "/tmp/identity.pem",
	}
	cfg, err := loadConfig(func(name string) string { return values[name] })
	if err != nil || cfg.maximumRenditions != 2 {
		t.Fatalf("valid config rejected: %v", err)
	}
	values["NATIVE_PACKAGER_CONTROL_URL"] = "ws://webrtc.example/native-packager"
	if _, err = loadConfig(func(name string) string { return values[name] }); err == nil {
		t.Fatal("insecure control URL accepted")
	}
	values["NATIVE_PACKAGER_CONTROL_URL"] = "wss://webrtc.example/native-packager?token=secret"
	if _, err = loadConfig(func(name string) string { return values[name] }); err == nil {
		t.Fatal("token-bearing URL accepted")
	}
}

func TestAuthMessageMatchesP1363Signature(t *testing.T) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	message := authMessage("pkr_0123456789abcdef", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", 1234)
	digest := sha256.Sum256([]byte(message))
	r, s, err := ecdsa.Sign(rand.Reader, key, digest[:])
	if err != nil {
		t.Fatal(err)
	}
	proof := make([]byte, 64)
	r.FillBytes(proof[:32])
	s.FillBytes(proof[32:])
	if len(base64.RawURLEncoding.EncodeToString(proof)) != 86 {
		t.Fatal("unexpected P1363 proof length")
	}
}
