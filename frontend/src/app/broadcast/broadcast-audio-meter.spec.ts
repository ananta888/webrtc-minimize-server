import { afterEach, describe, expect, it, vi } from "vitest";

import { BrowserBroadcastAudioMeterFactory } from "./broadcast-audio-meter";

function fixture(options: { failCloseOnce?: boolean; failResume?: boolean } = {}) {
  const source = { connect: vi.fn(), disconnect: vi.fn() };
  const analyser = {
    fftSize: 0,
    smoothingTimeConstant: 0,
    disconnect: vi.fn(),
    getByteTimeDomainData: vi.fn(),
  };
  let closeFails = options.failCloseOnce === true;
  const context = {
    state: "suspended",
    createMediaStreamSource: vi.fn(() => source),
    createAnalyser: vi.fn(() => analyser),
    resume: vi.fn(async () => {
      if (options.failResume) throw new Error("resume_failed");
      context.state = "running";
    }),
    close: vi.fn(async () => {
      if (closeFails) {
        closeFails = false;
        throw new Error("close_failed");
      }
      context.state = "closed";
    }),
  };
  const AudioContextMock = vi.fn(() => context);
  const requestAnimationFrame = vi.fn(() => 17);
  const cancelAnimationFrame = vi.fn();
  vi.stubGlobal("AudioContext", AudioContextMock);
  vi.stubGlobal("requestAnimationFrame", requestAnimationFrame);
  vi.stubGlobal("cancelAnimationFrame", cancelAnimationFrame);
  return { source, analyser, context, AudioContextMock, requestAnimationFrame, cancelAnimationFrame };
}

describe("BrowserBroadcastAudioMeterFactory", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("disconnects its AudioNodes, animation loop and context idempotently", async () => {
    const context = fixture();
    const listener = vi.fn();
    const factory = new BrowserBroadcastAudioMeterFactory();
    const meter = await factory.create({} as MediaStream, listener);

    expect(context.context.resume).toHaveBeenCalledOnce();
    expect(context.source.connect).toHaveBeenCalledWith(context.analyser);
    expect(context.requestAnimationFrame).toHaveBeenCalledOnce();
    await meter.close();
    await meter.close();
    expect(context.cancelAnimationFrame).toHaveBeenCalledOnce();
    expect(context.source.disconnect).toHaveBeenCalledOnce();
    expect(context.analyser.disconnect).toHaveBeenCalledOnce();
    expect(context.context.close).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenLastCalledWith(0);
  });

  it("retains only the failed close step for a deterministic retry", async () => {
    const context = fixture({ failCloseOnce: true });
    const meter = await new BrowserBroadcastAudioMeterFactory().create({} as MediaStream, vi.fn());

    await expect(meter.close()).rejects.toThrow("close_failed");
    await meter.close();
    expect(context.source.disconnect).toHaveBeenCalledOnce();
    expect(context.analyser.disconnect).toHaveBeenCalledOnce();
    expect(context.context.close).toHaveBeenCalledTimes(2);
  });

  it("closes partial resources when AudioContext resume fails", async () => {
    const context = fixture({ failResume: true });
    await expect(new BrowserBroadcastAudioMeterFactory().create(
      {} as MediaStream,
      vi.fn(),
    )).rejects.toThrow("resume_failed");
    expect(context.source.disconnect).toHaveBeenCalledOnce();
    expect(context.analyser.disconnect).toHaveBeenCalledOnce();
    expect(context.context.close).toHaveBeenCalledOnce();
  });
});
