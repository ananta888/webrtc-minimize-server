import { afterEach, describe, expect, it, vi } from "vitest";
import { RuntimeConfigService } from "./runtime-config.service";

describe("Bounded runtime bootstrap", () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
  it("does not publish configuration while loading or after an HTTP failure", async () => {
    let release!: (response: Response) => void;
    const fetcher = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) => new Promise<Response>(resolve => { release = resolve; }));
    vi.stubGlobal("fetch", fetcher);
    const service = new RuntimeConfigService();
    const pending = service.load();
    expect(service.value()).toBeNull();
    expect(fetcher.mock.calls[0][1]).toMatchObject({ credentials: "same-origin", redirect: "error", signal: expect.any(AbortSignal) });
    release(new Response("unavailable", { status: 503 }));
    await expect(pending).rejects.toThrow("runtime_config_unavailable");
    expect(service.value()).toBeNull();
  });

  it("bounds stalled runtime requests and rejects late bodies after expiry", async () => {
    const abort = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(abort.signal);
    let release!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(resolve => { release = resolve; })));
    const service = new RuntimeConfigService(), pending = service.load();
    abort.abort(); release(new Response("{}"));
    await expect(pending).rejects.toThrow("runtime_config_timeout");
    expect(timeout).toHaveBeenCalledWith(15_000);
    expect(service.value()).toBeNull();
  });

  it.each([null, [], {}, { auth: {} }])("rejects invalid configuration without a fallback: %s", async body => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body))));
    const service = new RuntimeConfigService();
    await expect(service.load()).rejects.toThrow("runtime_config_invalid");
    expect(service.value()).toBeNull();
  });
});
