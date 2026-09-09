import { afterEach, describe, expect, it, vi } from "vitest";
import { createMachineScreenSurface } from "./machine-screen-surface";

function setup() {
  const drawing = { fillStyle: "", fillRect: vi.fn(), drawImage: vi.fn() };
  const track = { readyState: "live", contentHint: "", stop: vi.fn(), requestFrame: vi.fn() };
  const stream = { active: true, getTracks: () => [track], getVideoTracks: () => [track] };
  const canvas = { width: 0, height: 0, getContext: vi.fn(() => drawing), captureStream: vi.fn(() => stream) };
  vi.spyOn(document, "createElement").mockReturnValue(canvas as unknown as HTMLCanvasElement);
  const mesh = { attachPublication: vi.fn(), detachPublication: vi.fn() };
  return { drawing, track, stream, canvas, mesh };
}
afterEach(() => vi.restoreAllMocks());

describe("owned synthetic screen surface", () => {
  it("publishes only the manual-frame canvas and releases its screen once", () => {
    const f = setup(), surface = createMachineScreenSurface(f.mesh);
    expect(document.createElement).toHaveBeenCalledExactlyOnceWith("canvas");
    expect(f.canvas).toMatchObject({ width: 640, height: 360 });
    expect(f.canvas.captureStream).toHaveBeenCalledExactlyOnceWith(0);
    expect(f.mesh.attachPublication).toHaveBeenCalledExactlyOnceWith("screen", f.stream);
    expect(surface.active()).toBe(true);
    const bitmap = {} as ImageBitmap; surface.draw(bitmap); surface.frame();
    expect(f.drawing.drawImage).toHaveBeenCalledExactlyOnceWith(bitmap, 0, 0);
    expect(f.track.requestFrame).toHaveBeenCalledOnce();
    surface.close(); surface.close();
    expect(surface.active()).toBe(false); expect(f.track.stop).toHaveBeenCalledOnce();
    expect(f.mesh.detachPublication).toHaveBeenCalledExactlyOnceWith("screen");
    expect(f.canvas).toMatchObject({ width: 0, height: 0 });
  });
  it.each(["track", "stream"])("rejects draws and frame requests after the %s ends", kind => {
    const f = setup(), surface = createMachineScreenSurface(f.mesh);
    if (kind === "track") f.track.readyState = "ended"; else f.stream.active = false;
    expect(surface.active()).toBe(false);
    expect(() => surface.draw({} as ImageBitmap)).toThrow("meet_screen_source_ended");
    expect(() => surface.frame()).toThrow("meet_screen_source_ended");
    expect(f.drawing.drawImage).not.toHaveBeenCalled(); expect(f.track.requestFrame).not.toHaveBeenCalled();
    surface.close(); expect(f.mesh.attachPublication).toHaveBeenCalledOnce();
  });
  it("does not attach an already ended track", () => {
    const f = setup(); f.track.readyState = "ended";
    expect(() => createMachineScreenSurface(f.mesh)).toThrow("meet_screen_unsupported");
    expect(f.mesh.attachPublication).not.toHaveBeenCalled(); expect(f.mesh.detachPublication).not.toHaveBeenCalled();
    expect(f.track.stop).toHaveBeenCalledOnce(); expect(f.canvas.width).toBe(0);
  });
  it("cleans a partial attach failure without touching another media source", () => {
    const f = setup(); f.mesh.attachPublication.mockImplementation(() => { throw new Error("attach_failed"); });
    expect(() => createMachineScreenSurface(f.mesh)).toThrow("attach_failed");
    expect(f.mesh.detachPublication).toHaveBeenCalledExactlyOnceWith("screen");
    expect(f.track.stop).toHaveBeenCalledOnce(); expect(f.canvas.width).toBe(0);
  });
  it("resets the owned canvas even if publication detach fails", () => {
    const f = setup(), surface = createMachineScreenSurface(f.mesh);
    f.mesh.detachPublication.mockImplementation(() => { throw new Error("detach_failed"); });
    expect(() => surface.close()).toThrow("detach_failed"); surface.close();
    expect(surface.active()).toBe(false); expect(f.track.stop).toHaveBeenCalledOnce();
    expect(f.canvas).toMatchObject({ width: 0, height: 0 });
  });
});
