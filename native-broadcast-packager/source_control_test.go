package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"sync"
	"testing"
	"time"
)

func TestSourceControlExplicitLocalOptIn(t *testing.T) {
	for _, raw := range []string{"", "disabled", "enabled", " enabled ", "true", "1", "ENABLED", "unknown-secret"} {
		c, err := loadConfig(func(k string) string {
			return map[string]string{"NATIVE_PACKAGER_CONTROL_URL": "wss://example.test/native-packager", "NATIVE_PACKAGER_ID": "pkr_0123456789abcdef",
				"NATIVE_PACKAGER_IDENTITY_FILE": "/tmp/test.pem", "NATIVE_PACKAGER_SOURCE_PROGRAMS": raw}[k]
		})
		valid := oneOf(defaultValue(raw, "disabled"), "disabled", "enabled")
		if valid && (err != nil || c.sourcePrograms != (defaultValue(raw, "disabled") == "enabled")) || !valid && err == nil {
			t.Fatal("explicit local source opt-in", err)
		}
	}
}

func TestSourceControlStrictRoutingAndOwnedWireBytes(t *testing.T) {
	now := sourceProgramAssignmentTestClock()
	if _, err := decodePackagerControlMessage(sourceProgramAssignmentFixture, now, false); err == nil {
		t.Fatal("default-off control accepted v4")
	}
	raw := append([]byte(nil), sourceProgramAssignmentFixture...)
	m, err := decodePackagerControlMessage(raw, now, true)
	if err != nil || m.Version != 4 || m.SourceProgram == nil || m.PublisherPeerID != "" {
		t.Fatal("v4 routing", err)
	}
	clear(raw)
	if !bytes.Equal(m.SourceProgram, sourceProgramAssignmentFixture) {
		t.Fatal("control message retained borrowed input")
	}
	for _, replacement := range []struct{ old, next string }{
		{`"version": 4`, `"version": 3,"version": 4`},
		{`"version"`, `"Version"`},
		{`"sourceContext"`, `"SourceContext"`},
		{`"tenantId"`, `"tenantID"`},
	} {
		raw := bytes.Replace(sourceProgramAssignmentFixture, []byte(replacement.old), []byte(replacement.next), 1)
		if bytes.Equal(raw, sourceProgramAssignmentFixture) {
			t.Fatal("missing mutation")
		}
		if _, err := decodePackagerControlMessage(raw, now, true); err == nil {
			t.Fatal("alias or duplicate accepted")
		}
	}
	for _, raw := range [][]byte{nil, []byte("null"), append(append([]byte(nil), sourceProgramAssignmentFixture...), []byte("{}")...), make([]byte, 96*1024+1)} {
		if _, err := decodePackagerControlMessage(raw, now, true); err == nil {
			t.Fatal("invalid control accepted")
		}
	}
	if _, err := decodePackagerControlMessage(sourceProgramAssignmentFixture, now.Add(3*time.Minute), true); err == nil {
		t.Fatal("expired control accepted")
	}
	legacy := assignmentMessage(time.Now())
	wire, _ := json.Marshal(legacy)
	for _, enabled := range []bool{false, true} {
		decoded, err := decodePackagerControlMessage(wire, time.Now(), enabled)
		if err != nil || len(decoded.SourceProgram) != 0 || decoded.PublisherPeerID != legacy.PublisherPeerID {
			t.Fatal("legacy routing changed", err)
		}
	}
}

func TestSourceControlCannotBypassLocalAdmission(t *testing.T) {
	for _, enabled := range []bool{false, true} {
		c, r, _, _ := sourceOwnerFixture(t)
		c.cfg.sourcePrograms, c.cfg.sourceBudget = enabled, "compact-v1"
		c.sessionAuthenticated.Store(false)
		m := serverMessage{Version: 4, Type: "assignment-prepare", SourceProgram: sourceAssignmentBytes(t, r)}
		if err := c.prepareControlAssignment(m, time.Now()); err == nil || c.assignment != nil || len(c.sourceAssignmentHistory) != 0 {
			t.Fatal("control bypassed local authority")
		}
	}
}

func TestSourceControlOutputReadinessOrderAndRevoke(t *testing.T) {
	for _, revoked := range []bool{false, true} {
		t.Run(map[bool]string{false: "output", true: "revoked"}[revoked], func(t *testing.T) {
			c, r, local, _ := sourceOwnerFixture(t)
			var mu sync.Mutex
			var states []string
			status := make(chan string, 8)
			c.sendOverride = func(v any) error {
				m := v.(map[string]any)
				s := m["state"].(string)
				mu.Lock()
				states = append(states, s)
				mu.Unlock()
				status <- s
				return nil
			}
			output := &sourceGenerationTestOutput{ready: make(chan struct{}), finished: make(chan struct{})}
			factory := func(cfg sourceProgramGenerationConfig) (*sourceProgramGeneration, error) {
				return newSourceProgramGenerationWithOutput(cfg, func(sourceProgramEncoderConfig) (sourceGenerationOutput, error) { return output, nil })
			}
			if err := c.prepareSourceProgramAssignment(sourceAssignmentBytes(t, r), time.Now(), local, factory); err != nil {
				t.Fatal(err)
			}
			a := c.assignment
			o := a.sourceProgram
			if got := <-status; got != "ready" {
				t.Fatal("initial readiness", got)
			}
			for i := 0; i < 10; i++ {
				o.observeOutputReadiness()
			}
			select {
			case s := <-status:
				t.Fatal("running without output", s)
			default:
			}
			if revoked {
				c.revokeControlSession()
			}
			close(output.ready)
			if !revoked {
				for _, want := range []string{"starting", "running"} {
					select {
					case s := <-status:
						if s != want {
							t.Fatal("unordered output status", s)
						}
					case <-time.After(time.Second):
						t.Fatal("output status timeout")
					}
				}
				if err := c.transitionAssignment(a, "degraded", "THERMAL_PRESSURE"); err != nil {
					t.Fatal(err)
				}
				o.observeOutputReadiness() // A retry cannot heal a degraded live owner.
			}
			c.revokeControlSession()
			awaitSource(t, o.finished)
			if o.permitted() || c.sessionAuthenticated.Load() {
				t.Fatal("disconnect retained authority")
			}
			mu.Lock()
			defer mu.Unlock()
			if revoked {
				for _, s := range states {
					if s == "starting" || s == "running" {
						t.Fatal("output revived revoked owner")
					}
				}
			} else if len(states) < 4 || states[0] != "ready" || states[1] != "starting" || states[2] != "running" || states[3] != "degraded" {
				t.Fatal("status ordering", states)
			}
		})
	}
}

func TestSourceControlOutputStatusFailureClosesProgram(t *testing.T) {
	c, r, local, _ := sourceOwnerFixture(t)
	if err := c.prepareSourceProgramAssignment(sourceAssignmentBytes(t, r), time.Now(), local, sourceOwnerTestFactory); err != nil {
		t.Fatal(err)
	}
	o := c.assignment.sourceProgram
	c.sendOverride = func(any) error { return errors.New("synthetic write failure") }
	o.observeOutputReadiness()
	awaitSource(t, o.finished)
	if o.permitted() {
		t.Fatal("failed output status retained program")
	}
}
