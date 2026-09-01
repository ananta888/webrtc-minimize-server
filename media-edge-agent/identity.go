package main

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/pem"
	"errors"
	"fmt"
	"math/big"
	"os"
	"path/filepath"
)

type agentPublicKey struct {
	Kty string `json:"kty"`
	Crv string `json:"crv"`
	X   string `json:"x"`
	Y   string `json:"y"`
	Ext bool   `json:"ext"`
}

type agentIdentity struct {
	privateKey *ecdsa.PrivateKey
	publicKey  agentPublicKey
}

func loadAgentIdentity(filename string) (*agentIdentity, error) {
	raw, err := os.ReadFile(filename)
	if err != nil {
		return nil, fmt.Errorf("read media-agent identity: %w", err)
	}
	block, trailing := pem.Decode(raw)
	if block == nil || block.Type != "PRIVATE KEY" || len(trailing) != 0 {
		return nil, fmt.Errorf("invalid media-agent identity")
	}
	parsed, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	key, ok := parsed.(*ecdsa.PrivateKey)
	if err != nil || !ok || key.Curve != elliptic.P256() {
		return nil, fmt.Errorf("invalid media-agent P-256 identity")
	}
	return identityFromPrivateKey(key), nil
}

func loadOrCreateAgentIdentity(filename string) (*agentIdentity, error) {
	identity, err := loadAgentIdentity(filename)
	if err == nil {
		return identity, nil
	}
	if !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, fmt.Errorf("generate media-agent identity: %w", err)
	}
	encoded, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		return nil, fmt.Errorf("encode media-agent identity: %w", err)
	}
	directory := filepath.Dir(filename)
	if err = os.MkdirAll(directory, 0o700); err != nil {
		return nil, fmt.Errorf("create media-agent identity directory: %w", err)
	}
	temporary, err := os.CreateTemp(directory, ".media-agent-identity-*")
	if err != nil {
		return nil, fmt.Errorf("create media-agent identity: %w", err)
	}
	temporaryName := temporary.Name()
	defer os.Remove(temporaryName)
	if err = temporary.Chmod(0o600); err == nil {
		err = pem.Encode(temporary, &pem.Block{Type: "PRIVATE KEY", Bytes: encoded})
	}
	if err == nil {
		err = temporary.Sync()
	}
	if closeErr := temporary.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return nil, fmt.Errorf("write media-agent identity: %w", err)
	}
	if err = os.Link(temporaryName, filename); errors.Is(err, os.ErrExist) {
		return loadAgentIdentity(filename)
	}
	if err != nil {
		return nil, fmt.Errorf("install media-agent identity: %w", err)
	}
	return identityFromPrivateKey(key), nil
}

func identityFromPrivateKey(key *ecdsa.PrivateKey) *agentIdentity {
	coordinate := func(value *big.Int) string {
		bytes := make([]byte, 32)
		value.FillBytes(bytes)
		return base64.RawURLEncoding.EncodeToString(bytes)
	}
	return &agentIdentity{
		privateKey: key,
		publicKey: agentPublicKey{
			Kty: "EC", Crv: "P-256", X: coordinate(key.X), Y: coordinate(key.Y), Ext: true,
		},
	}
}

func (identity *agentIdentity) sign(message string) (string, error) {
	digest := sha256.Sum256([]byte(message))
	r, s, err := ecdsa.Sign(rand.Reader, identity.privateKey, digest[:])
	if err != nil {
		return "", fmt.Errorf("sign media-agent proof: %w", err)
	}
	proof := make([]byte, 64)
	r.FillBytes(proof[:32])
	s.FillBytes(proof[32:])
	return base64.RawURLEncoding.EncodeToString(proof), nil
}

func signatureMessage(agentID, nonce string, timestamp int64) string {
	return fmt.Sprintf("v2\n%s\n%s\n%d", agentID, nonce, timestamp)
}

func enrollmentProofMessage(agentID, nonce string, timestamp int64, token string, key agentPublicKey) string {
	return fmt.Sprintf("v1\n%s\n%s\n%d\n%s\n%s\n%s", agentID, nonce, timestamp, token, key.X, key.Y)
}
