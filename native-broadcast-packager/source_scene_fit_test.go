package main

import (
	"encoding/json"
	"os"
	"reflect"
	"testing"
	"time"
)

func TestSourceSceneV2ClosedFitsAndVersionedControl(t *testing.T) {
	raw, err := os.ReadFile("testdata/source-scene.v2.json")
	if err != nil {
		t.Fatal(err)
	}
	var c sourceSceneCommand
	if json.Unmarshal(raw, &c) != nil {
		t.Fatal("fixture")
	}
	now := time.UnixMilli(c.IssuedAt)
	if _, err := parseSourceSceneCommand(raw, now); err != nil {
		t.Fatal(err)
	}
	m, err := decodePackagerControlMessage(raw, now, true)
	if err != nil || m.Version != 2 {
		t.Fatal("lost explicit v2", err)
	}
	if _, err := decodePackagerControlMessage(raw, now, false); err == nil {
		t.Fatal("disabled control accepted")
	}
	for _, change := range []func(map[string]any){
		func(v map[string]any) { delete(v, "sourceFits") },
		func(v map[string]any) { v["sourceFits"] = nil },
		func(v map[string]any) { v["sourceFits"] = []string{} },
		func(v map[string]any) { v["sourceFits"] = []string{"contain", "cover"} },
		func(v map[string]any) { v["sourceFits"] = []string{"stretch"} },
		func(v map[string]any) { v["sourceFits"] = []any{nil} },
		func(v map[string]any) { v["version"] = 1 },
		func(v map[string]any) { v["version"] = 3 },
		func(v map[string]any) { v["fit"] = "cover" },
	} {
		var v map[string]any
		_ = json.Unmarshal(raw, &v)
		change(v)
		bad, _ := json.Marshal(v)
		if _, err := parseSourceSceneCommand(bad, now); err == nil {
			t.Fatal("invalid presentation accepted")
		}
	}
}

func TestSourceSceneV2ActualPixelsCASAndOwnedSnapshot(t *testing.T) {
	p, c, _, _ := sceneFixture(t)
	s, err := p.video.Add(sourceVideoMixInputConfig{width: 32, height: 32, kind: "screen", fit: "contain",
		maxFrameAgeSamples: 24000, authorized: func() bool { return true }, mapTimestamp: func(n uint32) (int64, bool) { return int64(n), true }})
	if err != nil {
		t.Fatal(err)
	}
	id := "sls_aaaaaaaaaaaaaaaa"
	p.sources[id] = &sourceGenerationSource{sourceLazyDecoder: &sourceLazyDecoder{}, video: s, allowed: func() bool { return true }}
	if err := s.WriteRGBA(32, 32, 0, solidVideoMix(32, 32, 220, 20, 20)); err != nil {
		t.Fatal(err)
	}
	fits := []string{"contain"}
	c.Version, c.Layout, c.SourceLeaseIDs, c.SourceFits = 2, "single", []string{id}, &fits
	if r, err := p.ApplySceneCommand(sceneBytes(t, c)); err != nil || r.Version != 2 || r.SceneRevision != 2 {
		t.Fatal("v2 apply", err)
	}
	renderVideoMix(t, p.video, 0, func(pixels []byte) {
		if videoMixColor(pixels, 64, 0, 18) != [4]byte{9, 19, 31, 255} || videoMixColor(pixels, 64, 32, 18)[0] != 220 {
			t.Fatal("contain pixels")
		}
	})
	fits[0] = "cover"
	if _, err := p.ApplySceneCommand(sceneBytes(t, c)); err == nil || p.video.revision != 2 {
		t.Fatal("changed replay accepted")
	}
	c.CommandID, c.ExpectedSceneRevision = "scn_bbbbbbbbbbbbbbbb", 2
	if _, err := p.ApplySceneCommand(sceneBytes(t, c)); err != nil {
		t.Fatal(err)
	}
	fits[0] = "contain" // Caller cannot mutate retained presentation after the command.
	renderVideoMix(t, p.video, 1600, func(pixels []byte) {
		if videoMixColor(pixels, 64, 0, 18)[0] != 220 || s.cfg.fit != "contain" {
			t.Fatal("cover or source policy mutated")
		}
	})
	q := sceneQueryFor(c)
	q.Version = 2
	state, err := p.QueryScene(sceneQueryBytes(t, q))
	if err != nil || !reflect.DeepEqual(state["sourceFits"], []string{"cover"}) {
		t.Fatal("v2 observation", err)
	}
	state["sourceFits"].([]string)[0] = "contain"
	if p.video.sceneFits[0] != "cover" {
		t.Fatal("aliased query")
	}
	q.Version = 1
	legacy, err := p.QueryScene(sceneQueryBytes(t, q))
	if err != nil {
		t.Fatal(err)
	}
	if _, extra := legacy["sourceFits"]; extra {
		t.Fatal("v1 shape changed")
	}
	if _, err := p.video.setScenePresentationGuarded(3, "single", []*sourceVideoMixInput{s}, nil, []string{"contain"}, func() bool { return false }); err == nil || p.video.sceneFits[0] != "cover" {
		t.Fatal("expired guard changed scene")
	}
	c.Version, c.SourceFits, c.CommandID, c.ExpectedSceneRevision = 1, nil, "scn_cccccccccccccccc", 3
	if _, err := p.ApplySceneCommand(sceneBytes(t, c)); err != nil {
		t.Fatal(err)
	}
	renderVideoMix(t, p.video, 3200, func(pixels []byte) {
		if videoMixColor(pixels, 64, 0, 18)[0] != 9 {
			t.Fatal("v1 did not restore original source default")
		}
	})
	s.Close()
	c.Version, c.SourceFits, c.CommandID, c.ExpectedSceneRevision = 2, &fits, "scn_dddddddddddddddd", 4
	if _, err := p.ApplySceneCommand(sceneBytes(t, c)); err == nil {
		t.Fatal("closed source selected")
	}
}

func TestSourceSceneV2EmptyFitsAndUnsupportedQueries(t *testing.T) {
	p, c, clock, _ := sceneFixture(t)
	c.Version = 2
	fits := []string{}
	c.SourceFits = &fits
	if _, err := p.ApplySceneCommand(sceneBytes(t, c)); err != nil {
		t.Fatal(err)
	}
	q := sceneQueryFor(c)
	q.Version = 2
	state, err := p.QueryScene(sceneQueryBytes(t, q))
	if err != nil || !reflect.DeepEqual(state["sourceFits"], []string{}) {
		t.Fatal("empty snapshot", err)
	}
	q.Version = 3
	if _, err := parseSourceSceneQuery(sceneQueryBytes(t, q), time.UnixMilli(clock.Load())); err == nil {
		t.Fatal("unknown query version")
	}
}

func TestSourceSceneV2SharedObservationAndReceipt(t *testing.T) {
	p, c, _, _ := sceneFixture(t)
	c.Version = 2
	fits := []string{}
	c.SourceFits = &fits
	q := sceneQueryFor(c)
	q.Version = 2
	state, err := p.QueryScene(sceneQueryBytes(t, q))
	if err != nil {
		t.Fatal(err)
	}
	receipt, err := p.ApplySceneCommand(sceneBytes(t, c))
	if err != nil {
		t.Fatal(err)
	}
	rejected := sourceSceneReply(c, "source-program-scene-rejected", c.IssuedAt)
	rejected["reasonCode"] = "SCENE_NOT_APPLIED"
	for name, value := range map[string]any{"source-scene-query": q, "source-scene-state": state, "source-scene-applied": receipt, "source-scene-rejected": rejected} {
		want, err := os.ReadFile("testdata/" + name + ".v2.json")
		if err != nil {
			t.Fatal(err)
		}
		got, err := json.Marshal(value)
		if err != nil {
			t.Fatal(err)
		}
		var a, b any
		if json.Unmarshal(want, &a) != nil || json.Unmarshal(got, &b) != nil || !reflect.DeepEqual(a, b) {
			t.Fatal("shared v2 fixture mismatch", name)
		}
	}
}

func TestSourceSceneV2PreservesActualReceiverRevocation(t *testing.T) {
	client, lease, now := trustedSourceFixture(t)
	p, _ := generationTestOwner(t, generationTestConfig(t, lease), nil)
	receiver, err := client.prepareTrustedSource(sourceBytes(t, lease), now)
	if err != nil {
		t.Fatal(err)
	}
	source, err := p.AddSource(lease, receiver)
	if err != nil {
		t.Fatal(err)
	}
	fits := []string{"cover"}
	c := sourceSceneCommand{Version: 2, Type: "source-program-scene", CommandID: "scn_aaaaaaaaaaaaaaaa", AssignmentID: lease.AssignmentID,
		ProgramID: lease.Consent.ProgramID, ProgramEpoch: lease.Consent.ProgramEpoch, LeaseID: lease.WriterLeaseID, FencingRevision: lease.FencingRevision,
		ExpectedSceneRevision: 1, Layout: "single", SourceLeaseIDs: []string{lease.SourceLeaseID}, SourceFits: &fits,
		IssuedAt: now.UnixMilli(), ExpiresAt: now.Add(4 * time.Second).UnixMilli()}
	if r, err := p.ApplySceneCommand(sceneBytes(t, c)); err != nil || r.Version != 2 || r.SceneRevision != 2 {
		t.Fatal("authorized v2 source", err)
	}
	source.Close()
	awaitSource(t, source.finished)
	c.CommandID, c.ExpectedSceneRevision = "scn_bbbbbbbbbbbbbbbb", 2
	if _, err := p.ApplySceneCommand(sceneBytes(t, c)); err == nil {
		t.Fatal("revoked receiver revived by presentation")
	}
}
