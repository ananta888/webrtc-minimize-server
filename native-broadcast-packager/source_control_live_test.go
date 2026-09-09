package main

import (
	"context"
	"crypto/ecdsa"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"math/big"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func TestLiveTrustedSourceControlSocket(t *testing.T) {
	if os.Getenv("RUN_LIVE_TRUSTED_SOURCE_DECODE") != "1" {
		t.Skip("set RUN_LIVE_TRUSTED_SOURCE_DECODE=1 with local FFmpeg")
	}
	ffmpeg, err := exec.LookPath("ffmpeg")
	if err != nil {
		t.Fatal("explicit control gate requires FFmpeg")
	}
	for _, ending := range []string{"stop", "disconnect", "cancel", "duplicate-auth", "disabled", "unauthenticated"} {
		t.Run(ending, func(t *testing.T) {
			c, request, _, lease := sourceOwnerFixture(t)
			c.sendOverride = nil
			c.cfg.ffmpegPath, c.cfg.sourceBudget, c.cfg.sourcePrograms = ffmpeg, "compact-v1", ending != "disabled"
			c.healthProbe = func() string { return "healthy" }
			c.setConsentedRooms(nil)
			accepted := make(chan *websocket.Conn, 1)
			server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path != "/native-packager" {
					http.NotFound(w, r)
					return
				}
				ws, err := (&websocket.Upgrader{}).Upgrade(w, r, nil)
				if err == nil {
					accepted <- ws
				}
			}))
			t.Cleanup(server.Close)
			roots := x509.NewCertPool()
			roots.AddCert(server.Certificate())
			c.cfg.controlURL = "wss" + strings.TrimPrefix(server.URL, "https") + "/native-packager"
			dialer := &websocket.Dialer{HandshakeTimeout: 5 * time.Second, TLSClientConfig: &tls.Config{MinVersion: tls.VersionTLS12, RootCAs: roots}}
			ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
			finished := make(chan struct{})
			go func() { defer close(finished); _ = c.connectUsingDialer(ctx, false, dialer) }()
			t.Cleanup(func() {
				cancel()
				select {
				case <-finished:
				case <-time.After(5 * time.Second):
					t.Error("control cleanup deadline")
				}
			})
			var ws *websocket.Conn
			select {
			case ws = <-accepted:
			case <-time.After(5 * time.Second):
				t.Fatal("TLS connection deadline")
			}
			t.Cleanup(func() { _ = ws.Close() })
			ws.SetReadLimit(96 * 1024)
			write := func(v any) {
				t.Helper()
				_ = ws.SetWriteDeadline(time.Now().Add(5 * time.Second))
				if err := ws.WriteJSON(v); err != nil {
					t.Fatal("control write", err)
				}
			}
			read := func() map[string]any {
				t.Helper()
				_ = ws.SetReadDeadline(time.Now().Add(5 * time.Second))
				var v map[string]any
				if err := ws.ReadJSON(&v); err != nil {
					t.Fatal("control read", err)
				}
				return v
			}
			nonce := strings.Repeat("a", 43)
			write(map[string]any{"version": 1, "type": "packager-challenge", "nonce": nonce, "expiresAt": time.Now().Add(10 * time.Second).UnixMilli()})
			auth := read()
			proof, _ := base64.RawURLEncoding.DecodeString(auth["proof"].(string))
			at := int64(auth["timestamp"].(float64))
			digest := sha256.Sum256([]byte(authMessage(c.cfg.packagerID, nonce, at)))
			if auth["type"] != "authenticate" || auth["packagerId"] != c.cfg.packagerID || len(proof) != 64 ||
				!ecdsa.Verify(&c.identity.privateKey.PublicKey, digest[:], new(big.Int).SetBytes(proof[:32]), new(big.Int).SetBytes(proof[32:])) {
				t.Fatal("actual P-256 authentication proof invalid")
			}
			if ending != "unauthenticated" {
				write(map[string]any{"version": 1, "type": "packager-authenticated", "packagerId": c.cfg.packagerID})
			}
			write(map[string]any{"version": 1, "type": "room-consent-sync", "roomIds": []string{request.RoomID}})
			reported := read()
			if reported["type"] != "capability" {
				t.Fatal("missing consent capability response")
			}
			capability := reported["capability"].(map[string]any)
			if c.cfg.sourcePrograms {
				if capability["capabilityVersion"] != float64(2) || capability["sourcePrograms"] != true {
					t.Fatal("enabled control omitted explicit source capability")
				}
			} else if capability["capabilityVersion"] != float64(1) || capability["sourcePrograms"] != nil {
				t.Fatal("disabled control changed legacy capability")
			}
			write(request)
			if ending == "disabled" || ending == "unauthenticated" {
				select {
				case <-finished:
				case <-time.After(5 * time.Second):
					t.Fatal("denied control remained open")
				}
				if c.assignment != nil || c.sessionAuthenticated.Load() || len(c.sourceAssignmentHistory) != 0 {
					t.Fatal("denied control allocated authority")
				}
				return
			}
			for _, expected := range [][2]string{{"ready", "CAPABILITY_READY"}, {"starting", "PROGRAM_STARTING"}, {"running", "OUTPUT_READY"}} {
				v := read()
				if v["type"] != "assignment-status" || v["state"] != expected[0] || v["reasonCode"] != expected[1] || v["assignmentId"] != request.AssignmentID {
					t.Fatal("invalid ordered output status")
				}
			}
			c.assignmentMu.Lock()
			a := c.assignment
			c.assignmentMu.Unlock()
			p := a.sourceProgram.generation.Load()
			encoder := p.output.(*sourceProgramEncoder)
			if !p.Ready() || a.Media != nil {
				t.Fatal("missing real source-program output or legacy media started")
			}
			for _, rendition := range request.Profile.Renditions {
				if _, err := os.Stat(filepath.Join(encoder.owner.output, rendition.ID, "index.m3u8")); err != nil {
					t.Fatal("OUTPUT_READY without HLS", err)
				}
			}
			lease.IssuedAt, lease.ExpiresAt = time.Now().UnixMilli(), time.Now().Add(5*time.Second).UnixMilli()
			write(map[string]any{"version": 1, "type": "trusted-source-prepare", "lease": lease})
			if read()["state"] != "receiver-prepared" {
				t.Fatal("v4 source bootstrap failed")
			}
			c.sourcesMu.Lock()
			source := c.trustedSources[lease.SourceLeaseID]
			c.sourcesMu.Unlock()
			if source == nil || source.owner != a || !source.receiver.AliveNow() {
				t.Fatal("source owner missing")
			}
			for i := 0; i < 3; i++ {
				request.ExpiresAt += 1000
				write(map[string]any{"version": 1, "type": "assignment-renew", "assignmentId": request.AssignmentID, "programEpoch": request.ProgramEpoch,
					"fencingRevision": request.FencingRevision, "expiresAt": request.ExpiresAt})
				write(request) // Ordered retry is the barrier after this renewal.
				v := read()
				if v["state"] != "running" || v["reasonCode"] != "OUTPUT_READY" || a.expiresAt.Load() != request.ExpiresAt || a.sourceProgram.generation.Load() != p {
					t.Fatal("wire renewal/retry replaced program or status")
				}
			}
			if ending == "stop" {
				write(map[string]any{"version": 1, "type": "assignment-stop", "assignmentId": request.AssignmentID, "programEpoch": request.ProgramEpoch,
					"fencingRevision": request.FencingRevision, "reasonCode": "USER_STOP"})
				v := read()
				if v["state"] != "stopped" || v["reasonCode"] != "STOP_COMPLETE" {
					t.Fatal("stop not acknowledged")
				}
				cancel()
			} else if ending == "duplicate-auth" {
				write(map[string]any{"version": 1, "type": "packager-authenticated", "packagerId": c.cfg.packagerID})
			} else if ending == "cancel" {
				cancel()
			} else {
				_ = ws.Close()
			}
			select {
			case <-finished:
			case <-time.After(5 * time.Second):
				t.Fatal("control exit deadline")
			}
			awaitSource(t, a.sourceProgram.finished)
			if c.sessionAuthenticated.Load() || source.receiver.AliveNow() || p.Ready() || encoder.cmd.ProcessState == nil || encoder.cleanupFailed.Load() {
				t.Fatal("control loss retained authority or codec resources")
			}
			if _, err := os.Stat(encoder.owner.output); !os.IsNotExist(err) {
				t.Fatal("control loss retained output")
			}
		})
	}
}
