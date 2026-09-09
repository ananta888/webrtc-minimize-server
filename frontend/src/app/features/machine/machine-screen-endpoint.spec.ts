import { describe, expect, it, vi } from "vitest";
import { machineScreenEndpoint } from "./machine-screen-endpoint";

function setup() {
  const order: string[] = [];
  const screen = { open: vi.fn(() => { order.push("open"); return {} as never; }),
    close: vi.fn(() => { order.push("screen"); }), push: vi.fn(async () => {}),
    status: vi.fn(() => ({ open: false, generation: 2, sequence: 0 })),
    diagnostics: vi.fn(() => ({ schema: "ananta.meet-screen-diagnostics.v1", lastStopReason: "closed" })) };
  const audio = { close: vi.fn(() => { order.push("audio"); }) };
  return { screen, audio, order, endpoint: machineScreenEndpoint(screen, audio) };
}

describe("owned screen endpoint composition", () => {
  it("does not start, stop or capture on construction and keeps the existing wire shape", () => {
    const f = setup();
    expect(Object.isFrozen(f.endpoint)).toBe(true);
    expect(Object.keys(f.endpoint).sort()).toEqual(["close", "diagnostics", "open", "push", "status"]);
    expect(f.order).toEqual([]);
    expect(f.endpoint.status()).toEqual(f.screen.status());
    expect(f.endpoint.diagnostics()).toEqual(f.screen.diagnostics());
    expect(f.order).toEqual([]);
  });
  it("stops both prior sources before passing the requested source to its authority adapter", () => {
    const f = setup(); f.endpoint.open("screen:owned");
    expect(f.order).toEqual(["audio", "screen", "open"]);
    expect(f.screen.open).toHaveBeenCalledExactlyOnceWith("screen:owned");
  });
  it.each(["audio", "screen", "both"])("isolates %s cleanup errors, redacts them and never opens a replacement", kind => {
    const f = setup();
    if (kind !== "screen") f.audio.close.mockImplementation(() => { throw new Error("private_audio_detail"); });
    if (kind !== "audio") f.screen.close.mockImplementation(() => { throw new Error("private_screen_detail"); });
    expect(() => f.endpoint.open("screen:replacement")).toThrow(/^meet_screen_cleanup_failed$/);
    expect(f.audio.close).toHaveBeenCalledOnce(); expect(f.screen.close).toHaveBeenCalledOnce();
    expect(f.screen.open).not.toHaveBeenCalled();
  });
  it("attempts the picture stop even when the audio stop throws during explicit close", () => {
    const f = setup(); f.audio.close.mockImplementation(() => { throw new Error("audio"); });
    expect(() => f.endpoint.close()).toThrow("meet_screen_cleanup_failed");
    expect(f.screen.close).toHaveBeenCalledOnce(); expect(f.screen.open).not.toHaveBeenCalled();
  });
  it("delegates frames unchanged; an old generation is not silently replaced", async () => {
    const f = setup(); f.screen.push.mockRejectedValue(new Error("meet_screen_frame_order_invalid"));
    await expect(f.endpoint.push(7, 8, "fixture")).rejects.toThrow("meet_screen_frame_order_invalid");
    expect(f.screen.push).toHaveBeenCalledExactlyOnceWith(7, 8, "fixture");
    expect(f.order).toEqual([]);
  });
});
