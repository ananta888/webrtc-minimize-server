import { afterEach, expect, it, vi } from "vitest";
import { parseNativeCapacityPreview, NativeCapacityPreview } from "./native-capacity-preview";
import { NativeCapacityPreviewController, CapacityPreviewState } from "./native-capacity-preview-controller";
import { BroadcastControlPlaneService } from "./broadcast-control-plane.service";
import Ajv2020 from "ajv/dist/2020.js";
import { readFileSync } from "node:fs";
const validateRequest = new Ajv2020({ strict: true }).compile(JSON.parse(readFileSync(
  "contracts/native-packager/capacity-preview-request.v2.schema.json", "utf8")));

const request = { roomId: "room-alpha", title: "Private title", visibility: "private" as const,
  packagerId: "pkr_aaaaaaaaaaaaaaaa", requestedRenditions: 1, allowHardwareAcceleration: false };
const response = (): NativeCapacityPreview => ({ schema: "ananta.native-capacity-preview.v1", reserved: false, costStatus: "unknown",
  observedAt: 1800000000000, expiresAt: 1800000005000, requestedRenditions: 1, reduced: false, videoEncoder: "libx264",
  demand: { cpuUnits: 4, memoryMiB: 224, encoderSlots: 1, gpuSlots: 0, egressBitsPerSecond: 648600 },
  renditions: [{ id: "low", width: 640, height: 360, framesPerSecond: 15, videoBitsPerSecond: 500000, audioBitsPerSecond: 64000, audioChannels: 2 }] });
afterEach(() => vi.restoreAllMocks());
it("accepts only a bounded closed observation whose demand matches its actual ladder", () => {
  expect(parseNativeCapacityPreview(response(), 1)).toEqual(response());
  for (const change of ["reserved", "expiry", "extra", "demand", "rendition", "reduced", "cost", "encoder", "authority"]) {
    const value: any = response();
    if (change === "reserved") value.reserved = true;
    if (change === "expiry") value.expiresAt++;
    if (change === "extra") value.demand.owner = "other";
    if (change === "demand") value.demand.egressBitsPerSecond++;
    if (change === "rendition") value.renditions[0].width = 4000;
    if (change === "reduced") value.reduced = true;
    if (change === "cost") value.costStatus = "free";
    if (change === "encoder") value.videoEncoder = "unknown";
    if (change === "authority") value.lease = "not_authority";
    expect(() => parseNativeCapacityPreview(value, 1), change).toThrow("invalid_native_capacity_preview");
  }
  expect(() => parseNativeCapacityPreview(response(), 2)).toThrow();
});

const combinedResponse = (): NativeCapacityPreview => ({ ...response(), schema: "ananta.native-capacity-preview.v2", programSlots: "available" });
it("combined preview requires explicit v2 confirmation and rejects downgrade or invented reservations", () => {
  expect(parseNativeCapacityPreview(combinedResponse(), 1, 2)).toEqual(combinedResponse());
  expect(() => parseNativeCapacityPreview(response(), 1, 2)).toThrow();
  expect(() => parseNativeCapacityPreview(combinedResponse(), 1, 1)).toThrow();
  for (const change of [{ programSlots: undefined }, { programSlots: "reserved" }, { programSlots: true },
    { reserved: true }, { schema: "ananta.native-capacity-preview.v3" }, { availableSlots: 10 }]) {
    expect(() => parseNativeCapacityPreview({ ...combinedResponse(), ...change }, 1, 2)).toThrow();
  }
});

function controllerFixture() {
  let now = 100, key: string | null = "session-one", state: CapacityPreviewState = { phase: "idle", value: null };
  const query = vi.fn(async (_request: unknown, _signal: AbortSignal) => response());
  const controller = new NativeCapacityPreviewController({ now: () => now, context: () => key ? { key, request } : null,
    changed: next => { state = next; }, query });
  return { controller, query, state: () => state, time: (value: number) => { now = value; }, key: (value: string | null) => { key = value; } };
}
it("never queries on construction; expires on monotonic request-start time including network delay", async () => {
  const f = controllerFixture(); expect(f.query).not.toHaveBeenCalled();
  f.query.mockImplementationOnce(async () => { f.time(4000); return response(); });
  await f.controller.query(); expect(f.state().phase).toBe("current");
  f.time(5100); f.controller.tick(); expect(f.state()).toEqual({ phase: "stale", value: null });
});
it.each(["session", "expiry", "destroy", "replacement"])("discards a delayed response after %s", async change => {
  const f = controllerFixture(); let resolve!: (value: NativeCapacityPreview) => void;
  f.query.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  const pending = f.controller.query(); const signal = f.query.mock.calls[0][1];
  if (change === "session") { f.key("session-two"); f.controller.tick(); }
  if (change === "expiry") { f.time(5100); f.controller.tick(); }
  if (change === "destroy") f.controller.destroy();
  if (change === "replacement") await f.controller.query();
  const before = f.state(); resolve(response()); await pending;
  expect(signal.aborted).toBe(true); expect(f.state()).toBe(before);
  if (change !== "replacement") expect(f.state().phase).not.toBe("current");
});
it("bounds stalled requests and hides failed or now unauthorized observations", async () => {
  const f = controllerFixture(); await f.controller.query(); f.key(null); f.controller.tick();
  expect(f.state()).toEqual({ phase: "stale", value: null });
  await f.controller.query(); expect(f.query).toHaveBeenCalledTimes(1);
  f.key("next"); f.query.mockRejectedValueOnce(new Error("secret-message")); await f.controller.query();
  expect(f.state()).toEqual({ phase: "unavailable", value: null });
  f.controller.destroy(); await f.controller.query(); expect(f.query).toHaveBeenCalledTimes(2);
});

const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
const service = () => new BroadcastControlPlaneService({ authorizationHeader: () => ({ authorization: "Bearer synthetic" }) } as never,
  { fingerprint: () => "a".repeat(43) } as never);
it.each([1, 2, 3])("connects closed request version %s through the real lazy HTTP service without program creation", async version => {
  const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(json(combinedResponse()));
  await service().nativeCapacityPreview({ ...request,
    ...(version === 2 ? { audioOutput: { codec: "aac", sampleRate: 48000, channels: 1, targetBitsPerSecond: 48000 } as const } : {}),
    ...(version === 3 ? { videoOutput: { profile: "screen-v1" } as const } : {}) }, new AbortController().signal);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch.mock.calls[0][0]).toBe("/api/broadcasts/native-capacity-preview");
  const options = fetch.mock.calls[0][1]!, body = JSON.parse(String(options.body));
  expect(validateRequest(body), JSON.stringify(validateRequest.errors)).toBe(true);
  expect(body.requestVersion).toBe(version); expect(body.trigger).toBe("user-action");
  expect(body.previewVersion).toBe(2);
  expect(body.title).toBeUndefined(); expect(body.programId).toBeUndefined(); expect(body.authorization).toBeUndefined();
  if (version === 3) expect(body.audioOutput).toBeNull();
  expect(options).toMatchObject({ cache: "no-store", redirect: "error", credentials: "same-origin" });
});
it("fails closed on oversize, invalid, denied and aborted HTTP observations", async () => {
  const fetch = vi.spyOn(globalThis, "fetch");
  for (const value of [json(response()), json({ ...combinedResponse(), extra: "x".repeat(5000) }), json({ ...combinedResponse(), reserved: true }),
    new Response("denied", { status: 429 })]) {
    fetch.mockResolvedValueOnce(value);
    await expect(service().nativeCapacityPreview(request, new AbortController().signal)).rejects.toThrow();
  }
  fetch.mockClear();
  await expect(service().nativeCapacityPreview(request, AbortSignal.abort())).rejects.toThrow();
  expect(fetch).not.toHaveBeenCalled();
});
