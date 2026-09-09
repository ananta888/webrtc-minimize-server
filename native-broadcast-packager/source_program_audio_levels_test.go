package main

import (
	"fmt"
	"testing"

	"github.com/ananta/webrtc-minimize-server/native-broadcast-packager/internal/trustedsframe"
)

func TestSourceProgramAudioLevelsOwnCurrentSourcesOnly(t *testing.T) {
	c, base, now := trustedSourceFixture(t)
	p, _ := generationTestOwner(t, generationTestConfig(t, base), nil)
	var receivers [3]*trustedsframe.SourceReceiver
	var leases [3]trustedsframe.SourceLease
	var ids [3]string
	for i, kind := range []string{"microphone", "screen-audio", "camera"} {
		lease := base
		suffix := fmt.Sprintf("%016x", i+1)
		ids[i] = "sls_" + suffix
		lease.SourceLeaseID = ids[i]
		lease.Consent.ConsentID, lease.Consent.SourceID, lease.PublicationID = "cns_"+suffix, "src_"+suffix, "track-"+suffix
		lease.Consent.SourceKind = kind
		if i < 2 {
			lease.Codec = "audio/opus"
		}
		var err error
		receivers[i], err = c.prepareTrustedSource(sourceBytes(t, lease), now)
		if err != nil {
			t.Fatal(err)
		}
		leases[i] = lease
	}
	// Prepare all receiver fixtures before attaching live consumers. Passing the
	// old fixture timestamp to prune after AliveFor has sampled real time would
	// correctly revoke earlier receivers as a clock rollback.
	for i, lease := range leases {
		if _, err := p.AddSource(lease, receivers[i]); err != nil {
			t.Fatal(err)
		}
	}
	state, err := p.AudioLevels()
	if err != nil || len(state.Sources) != 2 || state.Sources[0].SourceLeaseID != ids[0] || state.Sources[1].SourceKind != "screen-audio" {
		t.Fatal("incorrect bounded source snapshot", state, err)
	}
	changes := []sourceProgramAudioLevel{{ids[0], 16384, 8192, true}, {ids[1], 8192, 8192, false}}
	revision, err := p.SetAudioLevels(state.Revision, changes, func() bool { return true })
	if err != nil || revision != state.Revision+1 {
		t.Fatal("atomic levels failed", err)
	}
	after, _ := p.AudioLevels()
	if !after.Sources[0].Muted || after.Sources[0].Left != 16384 || after.Sources[1].Left != 8192 {
		t.Fatal("wrong audio selection")
	}
	for _, selected := range [][]sourceProgramAudioLevel{
		{{ids[0], 32768, 32768, false}, {ids[2], 0, 0, true}},
		{{"sls_ffffffffffffffff", 0, 0, true}}, {changes[0], changes[0]},
	} {
		if _, err := p.SetAudioLevels(revision, selected, func() bool { return true }); err == nil {
			t.Fatal("invalid source set applied")
		}
	}
	if _, err := p.SetAudioLevels(revision, changes, func() bool { return false }); err == nil {
		t.Fatal("expired command applied")
	}
	if p.budget.processes != 0 {
		t.Fatal("presentation control started a decoder")
	}
	receivers[0].Destroy()
	state, err = p.AudioLevels()
	if err != nil || len(state.Sources) != 1 || state.Sources[0].SourceLeaseID != ids[1] {
		t.Fatal("revoked source remains selectable", err)
	}
	if _, err := p.SetAudioLevels(state.Revision, changes, func() bool { return true }); err == nil {
		t.Fatal("revoked source revived")
	}
	p.Close()
	if _, err := p.AudioLevels(); err == nil {
		t.Fatal("closed owner exposed audio selection")
	}
}
