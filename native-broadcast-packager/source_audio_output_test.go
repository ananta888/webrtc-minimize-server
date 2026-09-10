package main

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"
)

func outputAssignmentFixture(t *testing.T) ([]byte, sourceProgramAssignment, time.Time) {
	t.Helper()
	raw, err := os.ReadFile("testdata/source-program-assignment.v5.json")
	if err != nil {
		t.Fatal(err)
	}
	now := time.UnixMilli(1900000000000)
	a, err := parseSourceProgramAssignment(raw, now)
	if err != nil {
		t.Fatal(err)
	}
	return raw, a, now
}

func TestSourceAudioOutputV5BoundsAndLegacyIsolation(t *testing.T) {
	raw, a, now := outputAssignmentFixture(t)
	if a.outputAudioChannels() != 1 {
		t.Fatal("explicit mono lost")
	}
	for _, change := range []func(*sourceProgramAssignment){
		func(a *sourceProgramAssignment) { a.AudioOutput = nil },
		func(a *sourceProgramAssignment) { a.Version = 4 },
		func(a *sourceProgramAssignment) { a.Version = 6 },
		func(a *sourceProgramAssignment) { a.AudioOutput.Codec = "opus" },
		func(a *sourceProgramAssignment) { a.AudioOutput.SampleRate = 44100 },
		func(a *sourceProgramAssignment) { a.AudioOutput.Channels = 0 },
		func(a *sourceProgramAssignment) { a.AudioOutput.Channels = 3 },
		func(a *sourceProgramAssignment) { a.AudioOutput.TargetBitsPerSecond = 15999 },
		func(a *sourceProgramAssignment) { a.AudioOutput.TargetBitsPerSecond = 192001 },
		func(a *sourceProgramAssignment) { a.Profile.Renditions[0].AudioBitsPerSecond = 64000 },
	} {
		_, bad, _ := outputAssignmentFixture(t)
		change(&bad)
		if validSourceProgramAssignment(bad, now) {
			t.Fatal("invalid format admitted")
		}
		if _, err := parseSourceProgramAssignment(sourceAssignmentBytes(t, bad), now); err == nil {
			t.Fatal("invalid wire admitted")
		}
	}
	for _, channels := range []int{1, 2} {
		for _, rate := range []int{16000, 48000, 96000, 192000, 320000} {
			_, candidate, _ := outputAssignmentFixture(t)
			candidate.AudioOutput.Channels, candidate.AudioOutput.TargetBitsPerSecond = channels, rate
			candidate.Profile.Renditions[0].AudioBitsPerSecond = rate
			if validSourceProgramAssignment(candidate, now) != (channels == 2 || rate <= 192000) {
				t.Fatal("wrong output bound")
			}
		}
	}
	for _, pair := range [][2]string{
		{`"audioOutput": {`, `"audioOutput": null, "audioOutput": {`},
		{`"channels": 1`, `"channels": 1, "channels": 2`},
		{`"channels": 1`, `"channels": 1, "\u0063hannels": 1`},
		{`"channels": 1`, `"CHANNELS": 1`},
		{`"channels": 1`, `"channels": null`},
		{`"codec": "aac"`, `"codec": "aac", "path": "/untrusted"`},
	} {
		bad := []byte(strings.Replace(string(raw), pair[0], pair[1], 1))
		if string(bad) == string(raw) {
			t.Fatal("mutation not applied")
		}
		if _, err := parseSourceProgramAssignment(bad, now); err == nil {
			t.Fatal("ambiguous output admitted")
		}
	}
	a.Version, a.AudioOutput = 4, nil
	legacy := sourceAssignmentBytes(t, a)
	if _, err := parseSourceProgramAssignment(legacy, now); err != nil || a.outputAudioChannels() != 2 {
		t.Fatal("legacy default changed")
	}
	if _, err := parseSourceProgramAssignment([]byte(strings.Replace(string(legacy), `{`, `{"audioOutput":null,`, 1)), now); err == nil {
		t.Fatal("v4 accepted even null v5 field")
	}
	if _, err := decodePackagerControlMessage(raw, now, false); err == nil {
		t.Fatal("v5 bypassed opt-in")
	}
	if m, err := decodePackagerControlMessage(raw, now, true); err != nil || m.Version != 5 {
		t.Fatal("enabled dispatch lost version")
	}
}

func TestSourceAudioOutputEncoderAndLocalBudget(t *testing.T) {
	_, a, now := outputAssignmentFixture(t)
	cfg := config{sourceBudget: "compact-v1", maximumRenditions: 3, maximumPixelsPerSecond: 1280 * 720 * 30}
	local, err := localSourceProgramConfig(cfg, a, now)
	if err != nil || local.encoder.audioChannels != 1 {
		t.Fatal("local adapter lost output format")
	}
	for _, channels := range []int{0, 1, 2} {
		c := sourceEncoderTestConfig(t.TempDir())
		c.audioChannels = channels
		for _, epoch := range []sourceHLSEpoch{0, 1, 127} {
			c.hlsEpoch = epoch
			if !validSourceEncoderConfig(c) {
				t.Fatal("valid format rejected")
			}
			args := strings.Join(sourceProgramEncoderArguments(c, "/owned/.pending", "pipe:3", "pipe:4"), " ")
			if !strings.Contains(args, "-f s16le -ar 48000 -ac 2") {
				t.Fatal("output selection changed PCM input")
			}
			for i, rendition := range c.profile.Renditions {
				for _, expected := range []string{fmt.Sprintf("-ac:a:%d %d", i, c.outputAudioChannels()), fmt.Sprintf("-b:a:%d %d", i, rendition.AudioBitsPerSecond)} {
					if !strings.Contains(args, expected) {
						t.Fatal("encoder lost selected output")
					}
				}
			}
		}
	}
	for _, channels := range []int{-1, 3, 8} {
		c := sourceEncoderTestConfig(t.TempDir())
		c.audioChannels = channels
		if validSourceEncoderConfig(c) {
			t.Fatal("unbounded output channels")
		}
	}
}

func TestSourceAudioOutputV3ObservationAndV2DowngradeFence(t *testing.T) {
	p, _, _, owner, _ := audioControlFixture(t)
	p.cfg.encoder.audioChannels = 1
	p.cfg.encoder.profile.Renditions = []assignmentRendition{{ID: "low", AudioBitsPerSecond: 48000}}
	read := func(name string) []byte {
		raw, err := os.ReadFile("testdata/" + name + ".v3.json")
		if err != nil {
			t.Fatal(err)
		}
		return raw
	}
	if _, err := p.ApplyAudioCommand(strategyFixture(t, "source-audio")); err == nil || p.audio.revision != 2 {
		t.Fatal("v2 mutated mono program")
	}
	if _, err := p.QueryAudio(strategyFixture(t, "source-audio-query")); err == nil {
		t.Fatal("v2 falsely reports stereo")
	}
	receipt, err := p.ApplyAudioCommand(read("source-audio"))
	if err != nil || receipt.Version != 3 {
		t.Fatal("v3 strategy not applied", err)
	}
	state, err := p.QueryAudio(read("source-audio-query"))
	if err != nil || state.Version != 3 || state.Encoding.Channels != 1 || state.Encoding.Renditions[0].TargetBitsPerSecond != 48000 {
		t.Fatal("v3 lost actual format")
	}
	var want sourceAudioReply
	if json.Unmarshal(read("source-audio-state"), &want) != nil {
		t.Fatal("invalid fixture")
	}
	got, _ := json.Marshal(state)
	expected, _ := json.Marshal(want)
	if string(got) != string(expected) {
		t.Fatal("shared v3 observation mismatch")
	}
	legacy, err := p.QueryAudio(audioControlFixtureBytes(t, "source-audio-query"))
	if err != nil || legacy.Encoding != nil || legacy.Mix != nil {
		t.Fatal("v1 observation changed")
	}
	owner.Store(false)
	if _, err := p.QueryAudio(read("source-audio-query")); err == nil {
		t.Fatal("v3 survived revocation")
	}
}

func TestSourceAudioOutputOwnerPinsFormatAcrossRenewalAndPrepareReplay(t *testing.T) {
	c, r, local, _ := sourceOwnerFixture(t)
	r.Version = 5
	r.AudioOutput = &sourceAudioEncodingSelection{"aac", 48000, 1, 48000}
	for i := range r.Profile.Renditions {
		r.Profile.Renditions[i].AudioBitsPerSecond = 48000
	}
	local.encoder.audioChannels = 2 // A local caller cannot override the server's validated selection.
	raw := sourceAssignmentBytes(t, r)
	if err := c.prepareSourceProgramAssignment(raw, time.Now(), local, sourceOwnerTestFactory); err != nil {
		t.Fatal(err)
	}
	a := c.assignment
	p := a.sourceProgram.generation.Load()
	if p.cfg.encoder.audioChannels != 1 {
		t.Fatal("owner did not bind selected format")
	}
	if err := c.prepareSourceProgramAssignment(raw, time.Now(), local, sourceOwnerTestFactory); err != nil || c.assignment != a {
		t.Fatal("identical prepare changed owner")
	}
	r.AudioOutput.Channels = 2
	if err := c.prepareSourceProgramAssignment(sourceAssignmentBytes(t, r), time.Now(), local, sourceOwnerTestFactory); err == nil {
		t.Fatal("prepare changed channels without new generation")
	}
	r.AudioOutput.Channels, r.AudioOutput.TargetBitsPerSecond = 1, 64000
	for i := range r.Profile.Renditions {
		r.Profile.Renditions[i].AudioBitsPerSecond = 64000
	}
	if err := c.prepareSourceProgramAssignment(sourceAssignmentBytes(t, r), time.Now(), local, sourceOwnerTestFactory); err == nil {
		t.Fatal("prepare changed rate without new generation")
	}
	msg := serverMessage{AssignmentID: a.AssignmentID, ProgramEpoch: a.ProgramEpoch, FencingRevision: a.FencingRevision, ExpiresAt: r.ExpiresAt + 1000}
	if err := c.renewAssignment(msg, time.Now()); err != nil {
		t.Fatal(err)
	}
	state, err := p.audioLevels(3)
	if err != nil || state.Encoding.Channels != 1 || state.Encoding.Renditions[0].TargetBitsPerSecond != 48000 {
		t.Fatal("renewal changed pinned format")
	}
	c.closeAssignmentMedia()
	if _, err := p.audioLevels(3); err == nil {
		t.Fatal("revoked owner retained encoder observation")
	}
}
