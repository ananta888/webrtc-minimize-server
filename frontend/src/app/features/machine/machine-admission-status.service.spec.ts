import { afterEach, describe, expect, it, vi } from "vitest";
import { MachineAdmissionStatusService, parseMachineAdmission } from "./machine-admission-status.service";
import { MACHINE_INTEGRATION_CAPABILITIES } from "./machine-integration-status";

const contract = (admissionEnabled = false) => ({ schema: "ananta.meet-capabilities.v1", admissionEnabled,
  publication: "mp4-v1", sessionLease: "ananta.meet-session-lease.v1",
  chatEvents: false, audioSubscription: false, screenPublication: false });
const integration = (admissionEnabled = false) => ({ schema: "ananta.meet-integration.v1", admissionEnabled,
  supportedCapabilities: [...MACHINE_INTEGRATION_CAPABILITIES], operatorCapabilityCeiling: ["chat.read"],
  publisherConsentRequired: ["audio.receive", "chat.read", "video.receive"], sessionLease: "ananta.meet-session-lease.v1" });
const response = (value: unknown = integration()) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
const services: MachineAdmissionStatusService[] = [];
function setup() { const service = new MachineAdmissionStatusService(); services.push(service); return service; }
afterEach(() => { services.splice(0).forEach(service => service.ngOnDestroy()); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("machine admission status (observation, never authority)", () => {
  it("accepts only the exact legacy contract without translating old media booleans", () => {
    expect(parseMachineAdmission(contract())).toBe(false);
    expect(parseMachineAdmission(contract(true))).toBe(true);
    for (const [key, value] of Object.entries(contract())) {
      const missing = { ...contract() } as Record<string, unknown>; delete missing[key];
      expect(() => parseMachineAdmission(missing)).toThrow();
      expect(() => parseMachineAdmission({ ...contract(), [key]: typeof value === "boolean" ? "true" : "unknown" })).toThrow();
    }
    for (const field of ["chatEvents", "audioSubscription", "screenPublication"]) {
      expect(() => parseMachineAdmission({ ...contract(), [field]: true })).toThrow();
    }
    for (const value of [null, [], true, { ...contract(), hubConnected: true }]) expect(() => parseMachineAdmission(value)).toThrow();
  });
  it.each([false, true])("reads admission %s without credentials, follows no redirects and expires without polling", async enabled => {
    vi.useFakeTimers(); const fetcher = vi.fn(async () => response(integration(enabled))); vi.stubGlobal("fetch", fetcher);
    const service = setup(); expect(fetcher).not.toHaveBeenCalled();
    await service.refresh();
    expect(service.state()).toBe(enabled ? "enabled" : "disabled");
    expect(service.checkedAt()).toBe(Date.now());
    expect(service.integration()).toEqual(integration(enabled));
    expect(fetcher).toHaveBeenCalledExactlyOnceWith("/api/machine/integration", expect.objectContaining({
      method: "GET", credentials: "omit", cache: "no-store", redirect: "error", signal: expect.any(AbortSignal),
    }));
    await vi.advanceTimersByTimeAsync(30_000); expect(service.state()).toBe("stale");
    expect(service.integration()).toBeNull();
    expect(fetcher).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  });
  it.each(["http", "redirect", "type", "length", "stream", "json", "schema", "utf8", "missing-body"])("clears earlier success on invalid %s", async kind => {
    vi.useFakeTimers(); const fetcher = vi.fn(async () => response(integration(true))); vi.stubGlobal("fetch", fetcher);
    const service = setup(); await service.refresh(); expect(service.state()).toBe("enabled");
    let bad: Response = response();
    if (kind === "http") bad = new Response("failure", { status: 503 });
    if (kind === "redirect") Object.defineProperty(bad, "redirected", { value: true });
    if (kind === "type") bad.headers.set("content-type", "text/html");
    if (kind === "length") bad.headers.set("content-length", "999999");
    if (kind === "stream") bad = new Response(" ".repeat(2049), { headers: { "content-type": "application/json" } });
    if (kind === "json") bad = new Response("{", { headers: { "content-type": "application/json" } });
    if (kind === "schema") bad = response({ ...integration(), future: true });
    if (kind === "utf8") bad = new Response(new Uint8Array([255]), { headers: { "content-type": "application/json" } });
    if (kind === "missing-body") bad = new Response(null, { headers: { "content-type": "application/json" } });
    fetcher.mockResolvedValueOnce(bad); await service.refresh();
    expect(service.state()).toBe("unavailable"); expect(service.checkedAt()).toBeNull();
    expect(service.integration()).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("allows one request, enforces its deadline even without cooperative fetch, and ignores a late response", async () => {
    vi.useFakeTimers(); let resolve!: (response: Response) => void;
    const fetcher = vi.fn(() => new Promise<Response>(done => { resolve = done; })); vi.stubGlobal("fetch", fetcher);
    const service = setup(), pending = service.refresh(); await service.refresh(); expect(fetcher).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(5000); await pending;
    expect(service.state()).toBe("unavailable"); expect(vi.getTimerCount()).toBe(0);
    resolve(response(integration(true))); await Promise.resolve(); await Promise.resolve();
    expect(service.state()).toBe("unavailable");
    expect(service.integration()).toBeNull();
  });
  it("cancels a stalled body under the same request deadline", async () => {
    vi.useFakeTimers(); const cancelled = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream({ cancel: cancelled }), { headers: { "content-type": "application/json" } })));
    const service = setup(), pending = service.refresh();
    await vi.advanceTimersByTimeAsync(5000); await pending;
    expect(cancelled).toHaveBeenCalledOnce(); expect(service.state()).toBe("unavailable"); expect(vi.getTimerCount()).toBe(0);
  });
  it("destroys pending and freshness timers without late state writes or reactivation", async () => {
    vi.useFakeTimers(); const fetcher = vi.fn(async () => response(integration(true))); vi.stubGlobal("fetch", fetcher);
    const service = setup(); await service.refresh(); expect(vi.getTimerCount()).toBe(1);
    service.ngOnDestroy(); expect(vi.getTimerCount()).toBe(0); await service.refresh(); expect(fetcher).toHaveBeenCalledOnce();
    const next = setup(); fetcher.mockImplementationOnce(() => new Promise(() => {}));
    const pending = next.refresh(); next.ngOnDestroy(); await pending;
    expect(next.state()).toBe("idle"); expect(next.checkedAt()).toBeNull(); expect(vi.getTimerCount()).toBe(0);
  });
});
