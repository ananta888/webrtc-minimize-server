import { describe, expect, it, vi } from "vitest";
import { sequenceArtwork } from "./machine-avatar-sequence-artwork";
import { parseAvatarSequence } from "./machine-avatar-sequence-contract";

const content = () => parseAvatarSequence({ schema: "ananta.meet-avatar-sequence.v1", totalSamples: 22050,
  clips: [{ startSample: 0, endSample: 22050, content: { mp4: btoa("0000ftyp00000000"), sha256: "a".repeat(64),
    frames: 12, repeatMode: "hold_last", originKind: "generated", classification: "test_only" } }] });
function fixture() {
  const frames = { draw: vi.fn(), close: vi.fn() }, drawing = { fillText: vi.fn() } as never;
  const ports = { check: vi.fn(), progress: vi.fn(() => ({ state: "open", generation: 3,
    receivedSamples: 11466, playedSamples: 11025, bufferedSamples: 441 })), observe: vi.fn() };
  return { frames, drawing, ports, artwork: sequenceArtwork(content(), 3, frames, ports) };
}

describe("authority-fenced native sample artwork", () => {
  it("draws the sample-selected frame with a synthetic label and technical observation", () => {
    const f = fixture(); f.artwork.draw(f.drawing);
    expect(f.frames.draw).toHaveBeenCalledExactlyOnceWith(0, 6, f.drawing);
    expect(f.ports.check).toHaveBeenCalledTimes(3);
    expect(f.ports.observe).toHaveBeenCalledWith(expect.objectContaining({ playedSamples: 11025, frameIndex: 6 }));
  });
  it("refuses rendering before sampling when source authority is unavailable", () => {
    const f = fixture(); f.ports.check.mockImplementation(() => { throw new Error("test_source_retired"); });
    expect(() => f.artwork.draw(f.drawing)).toThrow("test_source_retired");
    expect(f.frames.draw).not.toHaveBeenCalled(); expect(f.ports.progress).not.toHaveBeenCalled();
    expect(f.frames.close).toHaveBeenCalledOnce();
  });
  it("detects authority loss during drawing and permanently retires the atlas", () => {
    const f = fixture(); let current = true;
    f.ports.check.mockImplementation(() => { if (!current) throw new Error("test_source_retired"); });
    f.frames.draw.mockImplementation(() => { current = false; });
    expect(() => f.artwork.draw(f.drawing)).toThrow("test_source_retired");
    current = true;
    expect(() => f.artwork.draw(f.drawing)).toThrow("artwork_closed");
    expect(f.ports.observe).not.toHaveBeenCalled(); f.artwork.close(); expect(f.frames.close).toHaveBeenCalledOnce();
  });
  it("does not mistake a changed speech generation for a valid progress update", () => {
    const f = fixture(); f.ports.progress.mockReturnValue({ state: "open", generation: 5,
      receivedSamples: 11466, playedSamples: 11025, bufferedSamples: 441 });
    expect(() => f.artwork.draw(f.drawing)).toThrow("sequence_progress_invalid");
    expect(f.frames.draw).not.toHaveBeenCalled(); expect(f.frames.close).toHaveBeenCalledOnce();
  });
  it("rechecks authority after observation side effects", () => {
    const f = fixture(); let current = true;
    f.ports.check.mockImplementation(() => { if (!current) throw new Error("test_source_retired"); });
    f.ports.observe.mockImplementation(() => { current = false; });
    expect(() => f.artwork.draw(f.drawing)).toThrow("test_source_retired");
    expect(f.frames.close).toHaveBeenCalledOnce();
  });
  it("cleans transferred frame ownership when generation binding is invalid", () => {
    const f = fixture();
    expect(() => sequenceArtwork(content(), 0, f.frames, f.ports)).toThrow("generation_invalid");
    expect(f.frames.close).toHaveBeenCalledOnce();
  });
});
