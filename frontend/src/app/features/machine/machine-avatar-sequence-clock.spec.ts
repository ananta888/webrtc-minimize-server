import { describe, expect, it } from "vitest";
import { AvatarSequenceClock } from "./machine-avatar-sequence-clock";
import { parseAvatarSequence } from "./machine-avatar-sequence-contract";
import { SPEECH_RATE } from "./machine-speech-source";

const video = (frames: number) => ({ mp4: btoa("0000ftyp00000000"), sha256: "a".repeat(64), frames,
  repeatMode: "hold_last", originKind: "generated", classification: "test_only" });
const payload = () => ({ schema: "ananta.meet-avatar-sequence.v1", totalSamples: 12 * SPEECH_RATE,
  clips: [{ startSample: 0, endSample: 10 * SPEECH_RATE, content: video(120) },
    { startSample: 10 * SPEECH_RATE, endSample: 12 * SPEECH_RATE, content: video(24) }] });
const progress = (played: number) => ({ state: "open", generation: 3,
  playedSamples: played, receivedSamples: played + 441, bufferedSamples: 441 });

describe("closed bounded sequence content", () => {
  it("copies content into owned bytes and retains contiguous immutable windows", () => {
    const input = payload(), parsed = parseAvatarSequence(input);
    parsed.clips[0].content.bytes.fill(0);
    expect(input.clips[0].content.mp4).toBe(video(120).mp4);
    expect(Object.isFrozen(parsed.clips)).toBe(true);
  });
  it.each([
    { ...payload(), url: "https://foreign" }, { ...payload(), speechGeneration: 3 },
    { ...payload(), totalSamples: 40 * SPEECH_RATE + 1 },
    { ...payload(), clips: [] }, { ...payload(), clips: Array(6).fill(payload().clips[0]) },
    { ...payload(), clips: [{ ...payload().clips[0], startSample: 1 }, payload().clips[1]] },
    { ...payload(), clips: [payload().clips[0], { ...payload().clips[1], endSample: 12 * SPEECH_RATE - 1 }] },
    { ...payload(), clips: [{ ...payload().clips[0], content: { ...video(120), repeatMode: "loop" } }, payload().clips[1]] },
    { ...payload(), clips: [payload().clips[0], { ...payload().clips[1], content: video(25) }] },
  ])("rejects overbroad, gapped, looping or mismatched plans", value => {
    expect(() => parseAvatarSequence(value)).toThrow();
  });
});

describe("native sample position without host wall-clock scheduling", () => {
  it("selects the exact clip and frame windows at the segment boundary", () => {
    const clock = new AvatarSequenceClock(parseAvatarSequence(payload()), 3);
    expect(clock.read(progress(0))).toMatchObject({ clipIndex: 0, frameIndex: 0, held: false });
    expect(clock.read(progress(10 * SPEECH_RATE - 1))).toMatchObject({ clipIndex: 0, frameIndex: 119 });
    expect(clock.read(progress(10 * SPEECH_RATE))).toMatchObject({ clipIndex: 1, frameIndex: 0 });
    const result = clock.read(progress(11 * SPEECH_RATE + 40));
    expect(result.clipIndex).toBe(1);
    expect(result.frameStartSample).toBeLessThanOrEqual(result.playedSamples);
    expect(result.frameEndSample).toBeGreaterThan(result.playedSamples);
  });
  it("retains only the last valid frame after exact native completion", () => {
    const clock = new AvatarSequenceClock(parseAvatarSequence(payload()), 3);
    clock.read(progress(0));
    const completed = { state: "completed", generation: 4,
      playedSamples: 12 * SPEECH_RATE, receivedSamples: 12 * SPEECH_RATE, bufferedSamples: 0 };
    expect(clock.read(completed)).toMatchObject({ clipIndex: 1, frameIndex: 23, held: true });
    expect(clock.read(completed).held).toBe(true);
    expect(() => clock.read(progress(0))).toThrow("meet_avatar_sequence_progress_invalid");
  });
  it.each(["failed", "closed", "foreign-generation", "backwards", "extra", "fraction", "overflow", "restart"])(
    "retires permanently on %s instead of promoting old prepared clips", reason => {
      const clock = new AvatarSequenceClock(parseAvatarSequence(payload()), 3);
      clock.read(progress(1000));
      const changed: Record<string, unknown> = progress(1001);
      if (reason === "failed" || reason === "closed") changed["state"] = reason;
      if (reason === "foreign-generation") changed["generation"] = 5;
      if (reason === "backwards") changed["playedSamples"] = 999;
      if (reason === "extra") changed["authority"] = "not-a-grant";
      if (reason === "fraction") changed["playedSamples"] = 1001.5;
      if (reason === "overflow") changed["bufferedSamples"] = 4411;
      if (reason === "restart") changed["state"] = "starting";
      expect(() => clock.read(changed)).toThrow("meet_avatar_sequence_progress_invalid");
      expect(() => clock.read(progress(1002))).toThrow("meet_avatar_sequence_progress_invalid");
    });
  it.each([0, 2049, true, NaN, 1.5])("rejects an invalid native generation %s", generation => {
    expect(() => new AvatarSequenceClock(parseAvatarSequence(payload()), generation as number)).toThrow(
      "meet_avatar_sequence_generation_invalid");
  });
  it("cannot activate an already completed speech generation", () => {
    const clock = new AvatarSequenceClock(parseAvatarSequence(payload()), 3);
    expect(() => clock.read({ state: "completed", generation: 4, playedSamples: 12 * SPEECH_RATE,
      receivedSamples: 12 * SPEECH_RATE, bufferedSamples: 0 })).toThrow("meet_avatar_sequence_progress_invalid");
  });
  it("rejects decoded-frame footprint overflow even when total PCM is bounded", () => {
    const ends = [220499, 440998, 661497, 881996, 882000];
    expect(() => parseAvatarSequence({ schema: "ananta.meet-avatar-sequence.v1", totalSamples: 882000,
      clips: ends.map((endSample, index) => ({ startSample: index ? ends[index - 1] : 0,
        endSample, content: video(index === 4 ? 2 : 120) })) })).toThrow("meet_avatar_sequence_invalid");
  });
});
