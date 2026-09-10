import { afterEach, describe, expect, it, vi } from "vitest";
import { loadBroadcastCaption } from "./broadcast-caption-loader";

const url = "/broadcast/play/res_aaaaaaaaaaaaaaaa/captions_live.vtt";
const text = "WEBVTT\n\ncc-1\n00:00:01.000 --> 00:00:02.000\nGrüße 中文\n";
const headers = { "content-type": "text/vtt; charset=utf-8" };
const load = (signal = new AbortController().signal) => loadBroadcastCaption(url, signal);
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("bounded broadcast caption transport", () => {
  it("decodes split UTF-8 without arrayBuffer and accepts exactly 64 KiB", async () => {
    const bytes = new TextEncoder().encode(text);
    let index = 0;
    const body = new ReadableStream<Uint8Array>({ pull(controller) {
      if (index === bytes.length) controller.close(); else controller.enqueue(bytes.slice(index, ++index));
    } });
    const response = new Response(body, { headers }), arrayBuffer = vi.spyOn(response, "arrayBuffer");
    const request = vi.fn().mockResolvedValueOnce(response)
      .mockResolvedValueOnce(new Response("WEBVTT\n\n".padEnd(65536, " "), { headers: { ...headers, "content-length": "65536" } }));
    vi.stubGlobal("fetch", request);
    expect(await load()).toBe(text); expect(arrayBuffer).not.toHaveBeenCalled(); expect(body.locked).toBe(false);
    expect((await load())?.length).toBe(65536);
    expect(request.mock.calls[0]).toEqual([location.origin + url, expect.objectContaining({ method: "GET", credentials: "same-origin", cache: "no-store", redirect: "error" })]);
  });

  it.each([undefined, "8"])("enforces actual bytes even with content-length %s", async declared => {
    const cancel = vi.fn(); let sent = 0;
    const body = new ReadableStream<Uint8Array>({ pull(controller) {
      sent++;
      controller.enqueue(new Uint8Array(sent === 1 ? 65536 : 1).fill(65));
    }, cancel }, { highWaterMark: 0 });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body, { headers: { ...headers, ...(declared ? { "content-length": declared } : {}) } })));
    await expect(load()).rejects.toThrow("broadcast_caption_unavailable");
    expect(sent).toBe(2); expect(cancel).toHaveBeenCalledOnce(); expect(body.locked).toBe(false);
  });

  it.each(["65537", "-1", "NaN", "1.5"])("rejects declared length %s without reading the body", async declared => {
    const pull = vi.fn(), cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ pull, cancel }, { highWaterMark: 0 });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body, { headers: { ...headers, "content-length": declared } })));
    await expect(load()).rejects.toThrow("broadcast_caption_unavailable");
    expect(pull).not.toHaveBeenCalled(); expect(cancel).toHaveBeenCalledOnce(); expect(body.locked).toBe(false);
  });

  it.each(["wrong-type", "missing-body", "short", "bad-header", "invalid-utf8", "truncated-utf8"])("rejects %s without retaining an open reader", async scenario => {
    const bytes = scenario === "invalid-utf8" ? new Uint8Array([255, 255, 255, 255, 255, 255, 255, 255])
      : scenario === "truncated-utf8" ? new Uint8Array([...new TextEncoder().encode("WEBVTT\n\n"), 0xc3])
      : scenario === "short" ? "WEBVTT" : scenario === "bad-header" ? "NOT-VTT!" : text;
    const response = new Response(scenario === "missing-body" ? null : bytes, { headers: { "content-type": scenario === "wrong-type" ? "text/html" : "text/vtt" } });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
    await expect(load()).rejects.toBeDefined(); expect(response.body?.locked || false).toBe(false);
  });

  it.each([401, 403, 404, 429, 500])("cancels ignored HTTP %i bodies and only 404 requests cue removal", async status => {
    const cancel = vi.fn(), body = new ReadableStream<Uint8Array>({ cancel });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body, { status, headers })));
    expect(await load()).toBe(status === 404 ? null : undefined);
    expect(cancel).toHaveBeenCalledOnce(); expect(body.locked).toBe(false);
  });

  it.each(["headers", "body", "delayed-headers"])("uses one five-second budget for hanging %s", async phase => {
    vi.useFakeTimers();
    let release!: (response: Response) => void;
    const cancel = vi.fn(), body = new ReadableStream<Uint8Array>({ cancel });
    const response = new Response(body, { headers });
    const request = vi.fn().mockImplementation(() => phase === "body" ? Promise.resolve(response) : new Promise<Response>(resolve => { release = resolve; }));
    vi.stubGlobal("fetch", request);
    let settled = false, failure: unknown;
    const pending = load().catch(error => { settled = true; failure = error; });
    await vi.advanceTimersByTimeAsync(4000);
    if (phase === "delayed-headers") release(response);
    await vi.advanceTimersByTimeAsync(999); expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1); await pending;
    expect(settled).toBe(true); expect(failure).toMatchObject({ message: "broadcast_caption_unavailable" });
    expect(request.mock.calls[0][1].signal.aborted).toBe(true); expect(request).toHaveBeenCalledOnce();
    if (phase === "headers") { release(response); await vi.advanceTimersByTimeAsync(0); }
    expect(cancel).toHaveBeenCalled(); expect(body.locked).toBe(false); expect(vi.getTimerCount()).toBe(0);
  });

  it("settles parent abort even when stream cancellation itself never settles", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const body = new ReadableStream<Uint8Array>({ cancel });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body, { headers })));
    const controller = new AbortController(), pending = load(controller.signal).catch(error => error);
    await vi.advanceTimersByTimeAsync(0); controller.abort();
    await expect(pending).resolves.toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(0);
    expect(cancel).toHaveBeenCalledOnce(); expect(body.locked).toBe(false); expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects foreign or credential-bearing paths and already-aborted work before fetch", async () => {
    const request = vi.fn(); vi.stubGlobal("fetch", request);
    for (const target of ["https://foreign.example" + url, url + "?token=x", url + "#x", "/broadcast/public/res_aaaaaaaaaaaaaaaa/captions_live.vtt", url.replace("captions_live.vtt", "index.m3u8")]) {
      await expect(loadBroadcastCaption(target, new AbortController().signal)).rejects.toThrow("broadcast_caption_unavailable");
    }
    await expect(load(AbortSignal.abort())).rejects.toMatchObject({ name: "AbortError" });
    expect(request).not.toHaveBeenCalled();
  });
});
