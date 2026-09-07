import { afterEach, describe, expect, it, vi } from "vitest";
import { createMachineMediaElement } from "./machine-media-element";
import { MachinePublicationOwnership } from "./machine-publication-ownership";

function fixture() {
  const audio = { kind: "audio", stop: vi.fn() }, videoTrack = { kind: "video", stop: vi.fn() };
  const stream = { getTracks: () => [audio, videoTrack], getAudioTracks: () => [audio], getVideoTracks: () => [videoTrack] };
  const video = { readyState: 2, duration: 1, videoWidth: 640, videoHeight: 360, captureStream: () => stream,
    pause: vi.fn(), play: vi.fn(async () => {}), load: vi.fn(), removeAttribute: vi.fn(), ended: true };
  vi.spyOn(document, "createElement").mockReturnValue(video as never);
  vi.stubGlobal("MediaStream", class { constructor(readonly tracks: unknown[]) {} });
  vi.stubGlobal("URL", { createObjectURL: () => "blob:fixture", revokeObjectURL: vi.fn() });
  const ownership = new MachinePublicationOwnership();
  const mesh = { attachPublication: vi.fn(), detachPublication: vi.fn() };
  return { video, audio, videoTrack, ownership, mesh,
    create: (outputs: ("avatar" | "speech")[]) => createMachineMediaElement(new Uint8Array(8), outputs, mesh, ownership) };
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
describe("MP4 element source ownership", () => {
  it("coexists with independent avatar while reserving only speech and stopping unselected tracks", () => {
    const f = fixture(), avatar = f.ownership.claim(["camera"]), handle = f.create(["speech"]);
    expect(() => f.ownership.claim(["microphone"])).toThrow("meet_machine_publication_busy_or_invalid");
    handle.attach(["speech"]);
    expect(f.videoTrack.stop).toHaveBeenCalledOnce();
    expect(f.mesh.attachPublication.mock.calls.map(([source]) => source)).toEqual(["microphone"]);
    handle.close();
    expect(avatar.owns("camera")).toBe(true);
    expect(f.mesh.detachPublication).toHaveBeenCalledExactlyOnceWith("microphone");
    const replacement = f.ownership.claim(["microphone"]); handle.close();
    expect(replacement.owns("microphone")).toBe(true);
    expect(f.mesh.detachPublication).toHaveBeenCalledOnce();
  });
  it("rejects overlapping avatar or PCM owners before decoder allocation", () => {
    const f = fixture(); f.ownership.claim(["camera"]);
    expect(() => f.create(["avatar", "speech"])).toThrow("meet_machine_publication_busy_or_invalid");
    expect(document.createElement).not.toHaveBeenCalled();
    expect(f.ownership.claim(["microphone"]).owns("microphone")).toBe(true);
  });
  it("releases a failed setup and continues cleanup after an element exception", () => {
    const f = fixture(); vi.mocked(document.createElement).mockImplementationOnce(() => { throw new Error("allocation_failed"); });
    expect(() => f.create(["speech"])).toThrow("allocation_failed");
    const handle = f.create(["speech"]); handle.attach(["speech"]);
    f.video.pause.mockImplementation(() => { throw new Error("pause_failed"); });
    handle.close();
    expect(f.audio.stop).toHaveBeenCalled(); expect(URL.revokeObjectURL).toHaveBeenCalled();
    expect(f.ownership.claim(["microphone"]).owns("microphone")).toBe(true);
  });
});
