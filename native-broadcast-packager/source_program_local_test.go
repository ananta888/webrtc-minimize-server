package main

import (
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestSourceLocalBudgetEnvironment(t *testing.T) {
	for _, value := range []string{"", "compact-v1", "standard-v1", "expanded-v1", " standard-v1 ", "unknown", "COMPACT-V1", "compact-v1,expanded-v1"} {
		t.Run(value, func(t *testing.T) {
			cfg, err := loadConfig(func(k string) string {
				return map[string]string{"NATIVE_PACKAGER_CONTROL_URL": "wss://example.test/native-packager",
					"NATIVE_PACKAGER_ID": "pkr_0123456789abcdef", "NATIVE_PACKAGER_IDENTITY_FILE": "/tmp/test-identity.pem",
					"NATIVE_PACKAGER_SOURCE_BUDGET": value}[k]
			})
			want := defaultValue(value, "compact-v1")
			valid := oneOf(want, "compact-v1", "standard-v1", "expanded-v1")
			if valid && (err != nil || cfg.sourceBudget != want) || !valid && err == nil {
				t.Fatal("local profile environment validation", err)
			}
		})
	}
}

func TestSourceLocalProfilesReachFencedOwner(t *testing.T) {
	for _, name := range []string{"compact-v1", "standard-v1", "expanded-v1"} {
		t.Run(name, func(t *testing.T) {
			c, r, _, _ := sourceOwnerFixture(t)
			c.cfg.sourceBudget = name
			r.Profile.Renditions = []assignmentRendition{
				{ID: "low", Width: 640, Height: 360, FramesPerSecond: 15, VideoBitsPerSecond: 400000, AudioBitsPerSecond: 64000},
				{ID: "high", Width: 1280, Height: 720, FramesPerSecond: 25, VideoBitsPerSecond: 1400000, AudioBitsPerSecond: 96000},
			}
			before := sourceAssignmentBytes(t, r)
			calls := 0
			factory := func(cfg sourceProgramGenerationConfig) (*sourceProgramGeneration, error) {
				calls++
				b, _ := sourceProgramLocalBudget(name)
				if !validSourceProgramGeneration(cfg) || cfg.encoder.width != 1280 || cfg.encoder.height != 720 || cfg.encoder.fps != 25 ||
					cfg.maxPublishers != 20 || cfg.maxSources != 80 || cfg.maxDecoders != b.decoders || cfg.maxDecodeBytes != b.decodeBytes ||
					cfg.maxPCMBytes != b.pcmBytes || cfg.maxRGBABytes != b.rgbaBytes || cfg.encoder.maxOutputBytes != b.outputBytes ||
					cfg.sourceWidth != b.width || cfg.sourceHeight != b.height || !reflect.DeepEqual(cfg.encoder.profile, r.Profile) ||
					!cfg.encoder.authorized() || cfg.scope.deviceRef != c.trustedSourceDeviceRef() {
					return nil, errors.New("local configuration did not reach real authorized owner")
				}
				return sourceOwnerTestFactory(cfg)
			}
			if err := c.prepareLocalSourceProgramAssignment(before, time.Now(), factory); err != nil {
				t.Fatal(err)
			}
			a := c.assignment
			deadline := a.sourceProgram.deadline.Load()
			if err := c.prepareLocalSourceProgramAssignment(before, time.Now(), factory); err != nil || calls != 1 || c.assignment != a || a.sourceProgram.deadline.Load() != deadline {
				t.Fatal("configured retry replaced owner or deadline", err)
			}
			if string(before) != string(sourceAssignmentBytes(t, r)) {
				t.Fatal("local capacity rewrote wire profile")
			}
			c.setConsentedRooms(nil)
			awaitSource(t, a.sourceProgram.finished)
			if a.sourceProgram.permitted() {
				t.Fatal("local configuration retained authority after revoke")
			}
		})
	}
}

func TestSourceLocalAdmissionRejectsBeforeReservationOrConstructor(t *testing.T) {
	for name, change := range map[string]func(*client, *sourceProgramAssignment){
		"missing-local-policy": func(c *client, _ *sourceProgramAssignment) { c.cfg.sourceBudget = "" },
		"unknown-local-policy": func(c *client, _ *sourceProgramAssignment) { c.cfg.sourceBudget = "untrusted-secret" },
		"sum-pixels":           func(c *client, _ *sourceProgramAssignment) { c.cfg.maximumPixelsPerSecond = 1 },
		"renditions":           func(c *client, _ *sourceProgramAssignment) { c.cfg.maximumRenditions = 1 },
		"one-queue-frame":      func(_ *client, a *sourceProgramAssignment) { a.Profile.MaximumQueueFrames = 1 },
		"odd-size":             func(_ *client, a *sourceProgramAssignment) { a.Profile.Renditions[0].Width++ },
		"overflow-fps": func(_ *client, a *sourceProgramAssignment) {
			a.Profile.Renditions[0].FramesPerSecond = int(^uint(0) >> 1)
		},
		"no-auth":       func(c *client, _ *sourceProgramAssignment) { c.sessionAuthenticated.Store(false) },
		"no-room":       func(c *client, _ *sourceProgramAssignment) { c.setConsentedRooms(nil) },
		"wrong-device":  func(_ *client, a *sourceProgramAssignment) { a.SourceContext.GranteeDeviceRef = "dev_bbbbbbbbbbbbbbbb" },
		"missing-codec": func(c *client, _ *sourceProgramAssignment) { c.capability.videoEncoders = nil },
		"expired":       func(_ *client, a *sourceProgramAssignment) { a.ExpiresAt = time.Now().Add(-time.Second).UnixMilli() },
	} {
		t.Run(name, func(t *testing.T) {
			c, r, _, _ := sourceOwnerFixture(t)
			c.cfg.sourceBudget = "compact-v1"
			change(c, &r)
			calls := 0
			err := c.prepareLocalSourceProgramAssignment(sourceAssignmentBytes(t, r), time.Now(), func(sourceProgramGenerationConfig) (*sourceProgramGeneration, error) {
				calls++
				return nil, errors.New("unexpected constructor")
			})
			if err == nil || strings.Contains(err.Error(), "untrusted-secret") || calls != 0 || c.assignment != nil || len(c.sourceAssignmentHistory) != 0 {
				t.Fatal("invalid local admission mutated owner or disclosed input", err)
			}
		})
	}
}

func TestSourceLocalCanvasCeilingIsIndependentOfRenditionSum(t *testing.T) {
	c, r, _, _ := sourceOwnerFixture(t)
	c.cfg.sourceBudget = "compact-v1"
	r.Profile.Renditions = []assignmentRendition{
		{ID: "low", Width: 1920, Height: 90, FramesPerSecond: 1, VideoBitsPerSecond: 100000, AudioBitsPerSecond: 16000},
		{ID: "high", Width: 160, Height: 1080, FramesPerSecond: 60, VideoBitsPerSecond: 100000, AudioBitsPerSecond: 16000},
	}
	c.cfg.maximumPixelsPerSecond = 1920*90 + 160*1080*60
	if _, err := localSourceProgramConfig(c.cfg, r, time.Now()); err == nil {
		t.Fatal("independent maxima escaped canvas pixel ceiling")
	}
	c.cfg.maximumPixelsPerSecond = 1920 * 1080 * 60
	local, err := localSourceProgramConfig(c.cfg, r, time.Now())
	if err != nil || local.encoder.width != 1920 || local.encoder.height != 1080 || local.encoder.fps != 60 {
		t.Fatal("exact canvas boundary rejected", err)
	}
	for _, q := range []int{2, 8, 16, 120} {
		r.Profile.MaximumQueueFrames = q
		local, err = localSourceProgramConfig(c.cfg, r, time.Now())
		want := min(16, q)*3840 + min(8, q)*1920*1080*4
		if err != nil || local.encoder.maxRawBytes != want {
			t.Fatal("raw pool accounting", q, err)
		}
	}
}

func TestSourceLocalDecoderBudgetRetainedUntilAllOwnersRelease(t *testing.T) {
	for _, name := range []string{"compact-v1", "standard-v1", "expanded-v1"} {
		b, _ := sourceProgramLocalBudget(name)
		quota, err := newSourceDecodeBudget(b.decoders, b.decodeBytes)
		if err != nil {
			t.Fatal(err)
		}
		var held []*sourceDecodeReservation
		charge := sourceVideoDecodeBytes(b.width, b.height)
		for {
			r, err := quota.reserve(charge)
			if err != nil {
				break
			}
			held = append(held, r)
		}
		if len(held) == 0 || int64(len(held)) != min(int64(b.decoders), b.decodeBytes/charge) {
			t.Fatal("local process/byte intersection not enforced", name)
		}
		warmup := held[0].retain()
		held[0].release()
		if _, err = quota.reserve(charge); err == nil {
			t.Fatal("warmup released quota before wipe")
		}
		warmup.release()
		replacement, err := quota.reserve(charge)
		if err != nil {
			t.Fatal("released quota unavailable", err)
		}
		quota.Close()
		if _, err = quota.reserve(1); err == nil {
			t.Fatal("closed quota admitted work")
		}
		replacement.release()
		for _, r := range held {
			r.release()
		}
		if quota.processes != 0 || quota.bytes != 0 {
			t.Fatal("local quota retained charges")
		}
	}
}
