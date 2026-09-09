package main

import (
	"sync"
	"testing"
	"time"
)

type sourceChangingTestOutput struct {
	sourceGenerationTestOutput
	mu      sync.Mutex
	epoch   sourceHLSEpoch
	active  bool
	changes chan struct{}
}

func (p *sourceChangingTestOutput) OutputState() (sourceHLSEpoch, bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.epoch, p.active && !p.closed.Load()
}
func (p *sourceChangingTestOutput) CurrentReady() bool            { _, ready := p.OutputState(); return ready }
func (p *sourceChangingTestOutput) StateChanges() <-chan struct{} { return p.changes }
func (p *sourceChangingTestOutput) set(epoch sourceHLSEpoch, ready bool) {
	p.mu.Lock()
	p.epoch, p.active = epoch, ready
	p.mu.Unlock()
	select {
	case p.changes <- struct{}{}:
	default:
	}
}

func TestSourceOutputStatusTracksRestartWithoutHealingThermalPressure(t *testing.T) {
	for _, thermal := range []bool{false, true} {
		t.Run(map[bool]string{false: "replacement", true: "thermal"}[thermal], func(t *testing.T) {
			c, r, local, _ := sourceOwnerFixture(t)
			statuses := make(chan [2]string, 16)
			c.sendOverride = func(value any) error {
				v := value.(map[string]any)
				statuses <- [2]string{v["state"].(string), v["reasonCode"].(string)}
				return nil
			}
			out := &sourceChangingTestOutput{sourceGenerationTestOutput: sourceGenerationTestOutput{ready: make(chan struct{}), finished: make(chan struct{})}, changes: make(chan struct{}, 1)}
			create := func(cfg sourceProgramGenerationConfig) (*sourceProgramGeneration, error) {
				return newSourceProgramGenerationWithOutput(cfg, func(sourceProgramEncoderConfig) (sourceGenerationOutput, error) { return out, nil })
			}
			if err := c.prepareSourceProgramAssignment(sourceAssignmentBytes(t, r), time.Now(), local, create); err != nil {
				t.Fatal(err)
			}
			c.assignmentMu.Lock()
			a := c.assignment
			o := a.sourceProgram
			c.assignmentMu.Unlock()
			t.Cleanup(func() { c.revokeControlSession(); awaitSource(t, o.finished) })
			expect := func(state, reason string) {
				t.Helper()
				select {
				case got := <-statuses:
					if got != [2]string{state, reason} {
						t.Fatal("wrong status", got)
					}
				case <-time.After(time.Second):
					t.Fatal("missing status", state, reason)
				}
			}
			expect("ready", "CAPABILITY_READY")
			o.observeOutputReadiness()
			out.set(0, true)
			expect("starting", "PROGRAM_STARTING")
			expect("running", "OUTPUT_READY")
			out.set(1, false)
			expect("degraded", "SOURCE_PROGRAM_RESTARTING")
			if thermal {
				if err := c.transitionAssignment(a, "degraded", "THERMAL_PRESSURE"); err != nil {
					t.Fatal(err)
				}
				expect("degraded", "THERMAL_PRESSURE")
			}
			out.set(1, true)
			if thermal {
				select {
				case got := <-statuses:
					t.Fatal("restart healed thermal pressure", got)
				case <-time.After(60 * time.Millisecond):
				}
				c.assignmentMu.Lock()
				state, reason := a.State, o.reasonCode
				c.assignmentMu.Unlock()
				if state != "degraded" || reason != "THERMAL_PRESSURE" {
					t.Fatal("thermal state lost")
				}
			} else {
				expect("running", "OUTPUT_READY")
				// Coalesced hints cannot conceal a whole encoder replacement.
				out.set(2, true)
				expect("degraded", "SOURCE_PROGRAM_RESTARTING")
				expect("running", "OUTPUT_READY")
			}
		})
	}
}
