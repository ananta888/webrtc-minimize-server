import "@angular/compiler";
import { readFileSync } from "node:fs";
import Ajv from "ajv/dist/2020.js";
import { signal } from "@angular/core";
import { afterEach, expect, it, vi } from "vitest";
import { NativeSceneState } from "./native-source-scene-contract";
import { NativeSourceLabels, parseNativeSourceLabels } from "./native-source-labels-contract";
import { NativeSourceLabelsController, NativeSourceLabelsView } from "./native-source-labels-controller";
import { NativeSourceSceneService } from "./native-source-scene.service";
import { NativeSourceProgramService } from "./native-source-program.service";
import { BroadcastControlPlaneService } from "./broadcast-control-plane.service";

const now = 1800000000000, source = "sls_aaaaaaaaaaaaaaaa", peerId = "a".repeat(16);
const scope = { programId: "prg_aaaaaaaaaaaaaaaa", programRevision: 1, programEpoch: 1,
  packagerId: "pkr_aaaaaaaaaaaaaaaa", assignmentId: "asn_aaaaaaaaaaaaaaaa", fencingRevision: 1 };
const state: NativeSceneState = { ...scope, sceneControlVersion: 2, outcome: "observed", observedAt: now, sceneRevision: 1,
  layout: "single", sourceLeaseIds: [source], sourceFits: ["contain"], activeSourceLeaseId: "",
  availableSources: [{ sourceLeaseId: source, sourceKind: "camera" }] };
const labels: NativeSourceLabels = { ...scope, version: 1, bindings: [{ sourceLeaseId: source, publisherPeerId: peerId, sourceKind: "camera" }] };
const schema = new Ajv({ strict: true }).compile(JSON.parse(readFileSync("contracts/native-packager/source-labels-response.v1.schema.json", "utf8")));
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

it("parses a closed immutable reply only for the queried scene scope, source IDs and kinds", () => {
  expect(schema(labels)).toBe(true);
  const parsed = parseNativeSourceLabels(labels, state);
  expect(Object.isFrozen(parsed)).toBe(true); expect(Object.isFrozen(parsed.bindings)).toBe(true);
  expect(Object.isFrozen(parsed.bindings[0])).toBe(true);
  expect(parseNativeSourceLabels({ ...labels, bindings: [] }, state).bindings).toEqual([]);
  for (const key of Object.keys(labels)) {
    const bad: any = { ...labels }; delete bad[key]; expect(schema(bad)).toBe(false);
    expect(() => parseNativeSourceLabels(bad, state)).toThrow();
  }
  for (const patch of [{ version: 2 }, { principal: "not-an-authority" }, { programId: "prg_bbbbbbbbbbbbbbbb" },
    { programRevision: 2 }, { programEpoch: 2 }, { packagerId: "pkr_bbbbbbbbbbbbbbbb" },
    { assignmentId: "asn_bbbbbbbbbbbbbbbb" }, { fencingRevision: 2 }, { bindings: null },
    { bindings: Array(81).fill(labels.bindings[0]) }, { bindings: [...labels.bindings, ...labels.bindings] }]) {
    expect(() => parseNativeSourceLabels({ ...labels, ...patch }, state)).toThrow();
  }
  for (const patch of [{ extra: true }, { sourceLeaseId: "sls_bbbbbbbbbbbbbbbb" }, { sourceKind: "screen" },
    { sourceKind: "microphone" }, { publisherPeerId: "G".repeat(16) }, { publisherPeerId: "" }, { name: "untrusted" }]) {
    expect(() => parseNativeSourceLabels({ ...labels, bindings: [{ ...labels.bindings[0], ...patch }] }, state)).toThrow();
  }
});

function lifecycle() {
  vi.useFakeTimers(); vi.setSystemTime(now);
  let owner: string | null = "owner-alpha", scene: NativeSceneState | null = state;
  let resolve!: (v: NativeSourceLabels) => void;
  let view: NativeSourceLabelsView = { phase: "idle", labels: null };
  const request = vi.fn((_scene: NativeSceneState, _signal: AbortSignal) => new Promise<NativeSourceLabels>(done => { resolve = done; }));
  const controller = new NativeSourceLabelsController({ owner: () => owner, scene: () => scene, request, changed: value => { view = value; } });
  return { controller, request, view: () => view, resolve: (value = labels) => resolve(value),
    owner: (v: string | null) => { owner = v; }, scene: (v: NativeSceneState | null) => { scene = v; } };
}

it.each(["owner", "leave", "scene", "expiry", "clock", "destroy"])("discards a delayed label reply after %s loss without retries", async kind => {
  const f = lifecycle(); f.controller.observe(state); await flush();
  expect(f.view().phase).toBe("pending"); expect(f.request).toHaveBeenCalledTimes(1);
  if (kind === "owner") f.owner("owner-beta");
  if (kind === "leave") f.owner(null);
  if (kind === "scene") f.scene({ ...state, assignmentId: "asn_bbbbbbbbbbbbbbbb" });
  if (kind === "expiry") vi.setSystemTime(now + 5000);
  if (kind === "clock") vi.setSystemTime(now - 1);
  if (kind === "destroy") f.controller.destroy(); else f.controller.tick();
  expect(f.request.mock.calls[0][1].aborted).toBe(true);
  f.resolve(); await flush(); expect(f.view().labels).toBe(null);
  expect(f.request).toHaveBeenCalledTimes(1); f.controller.destroy(); expect(vi.getTimerCount()).toBe(0);
});

it("bounds pending requests, ignores late completion and only retries after explicit new observation", async () => {
  const f = lifecycle(); f.controller.observe(state); await flush();
  await vi.advanceTimersByTimeAsync(3000);
  expect(f.view().phase).toBe("unavailable"); expect(f.request.mock.calls[0][1].aborted).toBe(true);
  f.resolve(); await flush(); expect(f.view().labels).toBe(null); expect(f.request).toHaveBeenCalledTimes(1);
  f.controller.observe(state); await flush(); f.resolve(); await flush();
  expect(f.view().phase).toBe("ready"); expect(f.view().labels).toEqual(labels);
  f.controller.destroy(); expect(vi.getTimerCount()).toBe(0);
});

it("does not fetch empty scenes and retires a superseded lookup before starting the next", async () => {
  const f = lifecycle(), empty = { ...state, availableSources: [] };
  f.scene(empty); f.controller.observe(empty); await flush(); expect(f.request).not.toHaveBeenCalled();
  f.scene(state); f.controller.observe(state); await flush(); const oldResolve = f.resolve;
  const oldSignal = f.request.mock.calls[0][1];
  f.controller.observe(null); expect(oldSignal.aborted).toBe(true);
  oldResolve(); await flush(); expect(f.view().labels).toBe(null); f.controller.destroy();
});

it("rechecks ownership on reply even before the next tick and does not accept a malformed projection", async () => {
  const f = lifecycle(); f.controller.observe(state); await flush(); f.owner("owner-beta");
  f.resolve(); await flush(); expect(f.view().labels).toBe(null);
  f.controller.observe(state); await flush();
  f.resolve({ ...labels, assignmentId: "asn_bbbbbbbbbbbbbbbb" }); await flush();
  expect(f.view().phase).toBe("unavailable"); expect(f.view().labels).toBe(null);
  f.controller.destroy(); expect(vi.getTimerCount()).toBe(0);
});

it("an old reply cannot replace bindings from a newer scene observation", async () => {
  const f = lifecycle();
  let oldResolve!: (v: NativeSourceLabels) => void;
  f.request.mockImplementationOnce(() => new Promise(done => { oldResolve = done; }));
  f.controller.observe(state); await flush();
  const next = { ...state, observedAt: now + 1, sceneRevision: 2 };
  vi.setSystemTime(now + 1); f.scene(next); f.controller.observe(next); await flush();
  f.resolve({ ...labels, bindings: [] }); await flush(); expect(f.view().labels?.bindings).toEqual([]);
  oldResolve(labels); await flush(); expect(f.view().labels?.bindings).toEqual([]);
  expect(f.request).toHaveBeenCalledTimes(2); f.controller.destroy();
});

it("wires scene and label lifecycles independently, resolves current names and clears on loss", async () => {
  vi.useFakeTimers(); vi.setSystemTime(now);
  const owner = signal<string | null>("owner-alpha"), name = signal<string | null>("Synthetic participant");
  const program = { ...scope, tenantId: "tn_aaaaaaaaaaaaaaaa", roomId: "room-alpha" };
  const programs = { sceneContext: () => owner() ? { key: owner(), program } : null, publisherName: vi.fn(() => name()) };
  let resolve!: (v: NativeSourceLabels) => void;
  const control = { nativeSourceScene: vi.fn(async () => state),
    nativeSourceLabels: vi.fn((_scene: NativeSceneState, _signal: AbortSignal) => new Promise<NativeSourceLabels>(done => { resolve = done; })) };
  const service = new NativeSourceSceneService(programs as never, control as never);
  try {
    await service.controller.refresh(); await flush();
    expect(service.view().phase).toBe("ready"); expect(service.labels().phase).toBe("pending");
    expect(service.publisherName(source)).toBe(null); expect(control.nativeSourceScene).toHaveBeenCalledTimes(1);
    resolve(labels); await flush(); expect(service.publisherName(source)).toBe("Synthetic participant");
    expect(programs.publisherName).toHaveBeenLastCalledWith(peerId);
    name.set("Renamed participant"); expect(service.publisherName(source)).toBe("Renamed participant");
    name.set(null); expect(service.publisherName(source)).toBe(null);
    name.set("New name"); owner.set("owner-beta"); expect(service.publisherName(source)).toBe(null);
    await vi.advanceTimersByTimeAsync(250); expect(service.labels().labels).toBe(null);
    expect(control.nativeSourceLabels).toHaveBeenCalledTimes(1);
  } finally { service.ngOnDestroy(); }
  expect(vi.getTimerCount()).toBe(0);
});

it("resolves only current membership names, including self, without agent/invite identity fallbacks", () => {
  const member = { id: peerId, name: "Remote person" };
  const port = { sceneContext: () => ({}), room: { peerId: () => "b".repeat(16), displayName: () => "My name" },
    mesh: { peerChoices: () => [member] } };
  const name = (id: string) => NativeSourceProgramService.prototype.publisherName.call(port as never, id);
  expect(name(peerId)).toBe("Remote person"); expect(name("b".repeat(16))).toBe("My name");
  expect(name("c".repeat(16))).toBe(null); expect(name("invalid")).toBe(null);
  member.name = "a".repeat(100); expect(name(peerId)).toHaveLength(80);
  port.mesh.peerChoices = () => []; expect(name(peerId)).toBe(null);
  port.sceneContext = () => null as never; expect(name("b".repeat(16))).toBe(null);
});

it("sends only the closed label request, parses bounded responses and never sends after cancellation", async () => {
  const validateRequest = new Ajv({ strict: true }).compile(JSON.parse(readFileSync("contracts/native-packager/source-labels-request.v1.schema.json", "utf8")));
  const service = new BroadcastControlPlaneService({ authorizationHeader: () => ({ Authorization: "Bearer synthetic" }) } as never,
    { fingerprint: () => "f".repeat(43) } as never);
  const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
  const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(response(labels));
  await expect(service.nativeSourceLabels(state, new AbortController().signal)).resolves.toEqual(labels);
  const [url, options] = fetchMock.mock.calls[0];
  expect(url).toBe(`/api/broadcasts/${state.programId}/native-source-labels`);
  expect(options).toMatchObject({ method: "POST", cache: "no-store", redirect: "error", credentials: "same-origin" });
  expect(validateRequest(JSON.parse(String(options!.body)))).toBe(true);
  expect(JSON.parse(String(options!.body))).toMatchObject({ expectedAssignmentId: state.assignmentId, sourceLeaseIds: [source] });
  fetchMock.mockResolvedValueOnce(response({ ...labels, bindings: [{ ...labels.bindings[0], name: "injected" }] }));
  await expect(service.nativeSourceLabels(state, new AbortController().signal)).rejects.toThrow();
  fetchMock.mockResolvedValueOnce(response({ padding: "a".repeat(17000) }));
  await expect(service.nativeSourceLabels(state, new AbortController().signal)).rejects.toThrow();
  fetchMock.mockResolvedValueOnce(response({}, 429));
  await expect(service.nativeSourceLabels(state, new AbortController().signal)).rejects.toThrow();
  const count = fetchMock.mock.calls.length, abort = new AbortController();
  const pending = service.nativeSourceLabels(state, abort.signal); abort.abort();
  await expect(pending).rejects.toMatchObject({ name: "AbortError" }); expect(fetchMock).toHaveBeenCalledTimes(count);
});
