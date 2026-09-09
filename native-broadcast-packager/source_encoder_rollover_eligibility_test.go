package main

import (
	"sync/atomic"
	"testing"
)

func TestSourceEncoderFirstFailureClassifiesOnlyProvenSourceRevocation(t *testing.T) {
	for _, mode := range []string{"source", "incoming-source", "writer", "owner-stop", "nil-source", "oversize", "quota"} {
		t.Run(mode, func(t *testing.T) {
			var allowed atomic.Bool
			allowed.Store(true)
			f := &sourceEncoderFence{writer: allowed.Load}
			source := &sourceRenderFence{allowed: func() bool { return true }}
			var g sourceRenderGuard
			g.add(source)
			if mode != "incoming-source" && !f.Admit(g) {
				t.Fatal("setup")
			}
			want := sourceEncoderFailureSource
			switch mode {
			case "writer":
				allowed.Store(false)
				want = sourceEncoderFailureWriter
			case "owner-stop":
				f.Revoke()
				want = sourceEncoderFailureStopped
			case "nil-source":
				g = sourceRenderGuard{count: 1}
				want = sourceEncoderFailureGuard
			case "oversize":
				g.count = 81
				want = sourceEncoderFailureGuard
			case "quota":
				for i := 1; i < 80; i++ {
					var next sourceRenderGuard
					next.add(&sourceRenderFence{allowed: func() bool { return true }})
					if !f.Admit(next) {
						t.Fatal("quota setup")
					}
				}
				g = sourceRenderGuard{}
				g.add(&sourceRenderFence{allowed: func() bool { return true }})
				want = sourceEncoderFailureQuota
			}
			if mode == "source" || mode == "incoming-source" || mode == "writer" || mode == "owner-stop" {
				source.closed.Store(true)
			}
			if f.Admit(g) || f.Valid() || f.failure.Load() != want {
				t.Fatal("wrong first failure", f.failure.Load(), want)
			}
			allowed.Store(true)
			source.closed.Store(false)
			f.Revoke()
			f.Clear()
			if f.failure.Load() != want || f.Valid() {
				t.Fatal("cleanup lost terminal cause")
			}
		})
	}
}

func TestSourceEncoderRolloverRequiresReapedCleanStillAuthorizedWriter(t *testing.T) {
	for _, mode := range []string{"source", "running", "cleanup", "writer", "nil-writer", "revoked", "stopped", "unknown", "quota", "epoch-budget"} {
		t.Run(mode, func(t *testing.T) {
			done := make(chan struct{})
			finished := make(chan struct{})
			p := &sourceProgramEncoder{finished: finished, fence: &sourceEncoderFence{},
				cfg: sourceProgramEncoderConfig{revoked: done, authorized: func() bool { return true }}}
			p.fence.fail(sourceEncoderFailureSource)
			if mode != "running" {
				close(finished)
			}
			switch mode {
			case "cleanup":
				p.cleanupFailed.Store(true)
			case "writer":
				p.cfg.authorized = func() bool { return false }
			case "nil-writer":
				p.cfg.authorized = nil
			case "revoked":
				close(done)
			case "stopped":
				p.fence.failure.Store(sourceEncoderFailureStopped)
			case "unknown":
				p.fence.failure.Store(sourceEncoderFailureNone)
			case "quota":
				p.fence.failure.Store(sourceEncoderFailureQuota)
			case "epoch-budget":
				p.cfg.hlsEpoch = sourceHLSEpochLimit - 1
			}
			if p.CanRollover() != (mode == "source") {
				t.Fatal("unsafe recovery eligibility")
			}
		})
	}
}
