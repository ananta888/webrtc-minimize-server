import { afterEach, describe, expect, it, vi } from "vitest";
import { NativePackagerStandbyService, parseNativeStandbyControl } from "./native-packager-standby.service";

const PROGRAM = "prg_aaaaaaaaaaaaaaaa", FIRST = "pkr_bbbbbbbbbbbbbbbb", SECOND = "pkr_cccccccccccccccc";
const control = (revision = 0, ids: string[] = []) => ({ controlVersion: 1, programId: PROGRAM,
  programRevision: 9, programEpoch: 2, standbyRevision: revision, standbyPackagerIds: ids });
function fixture() {
  const auth = { authorizationHeader: vi.fn(() => ({ Authorization: "Bearer fixture-token" })) };
  const device = { fingerprint: vi.fn(() => "a".repeat(43)) };
  const service = new NativePackagerStandbyService(auth as never, device as never);
  const fetch = vi.fn(async () => Response.json(control())); vi.stubGlobal("fetch", fetch);
  service.setScope(PROGRAM, 2);
  return { service, auth, device, fetch };
}

describe("keyless standby metadata port", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });
  it("never fetches on scope changes and requires explicit local load/save actions", async () => {
    const f = fixture();
    expect(f.fetch).not.toHaveBeenCalled();
    await expect(f.service.load("remote-signal")).rejects.toThrow("explicit_native_standby_action_required");
    await f.service.load("user-action");
    f.service.select(FIRST, true); f.service.select(SECOND, true); f.service.select("pkr_dddddddddddddddd", true);
    expect(f.service.selected()).toEqual([FIRST, SECOND]);
    expect(f.fetch).toHaveBeenCalledOnce();
    f.fetch.mockResolvedValue(Response.json(control(1, [FIRST, SECOND])));
    await f.service.save(2, "user-action");
    const init = (f.fetch.mock.calls as unknown as [string, RequestInit][])[1][1];
    expect(init.method).toBe("PUT");
    expect(JSON.parse(String(init.body))).toMatchObject({ expectedStandbyRevision: 0,
      expectedProgramRevision: 9, expectedProgramEpoch: 2, standbyPackagerIds: [FIRST, SECOND] });
    expect(f.service.control()?.standbyRevision).toBe(1);
    expect(JSON.stringify(f.service.control())).not.toContain("fixture-token");
  });
  it("clears uncertain write state and never retries a mutation", async () => {
    const f = fixture(); await f.service.load("user-action"); f.service.select(FIRST, true);
    f.fetch.mockRejectedValue(new TypeError("arbitrary transport details"));
    await f.service.save(1, "user-action");
    expect(f.fetch).toHaveBeenCalledTimes(2);
    expect(f.service.control()).toBeNull();
    expect(f.service.error()).toBe("native_standby_request_failed");
    await expect(f.service.save(1, "user-action")).rejects.toThrow("invalid_native_standby_selection");
    expect(f.fetch).toHaveBeenCalledTimes(2);
  });
  for (const mode of ["scope", "reset", "identity", "device"]) {
    it(`ignores a late response after ${mode} changes`, async () => {
      const f = fixture();
      let resolve!: (response: Response) => void;
      f.fetch.mockImplementation(() => new Promise(done => { resolve = done; }));
      const task = f.service.load("user-action");
      if (mode === "scope") f.service.setScope("prg_bbbbbbbbbbbbbbbb", 3);
      if (mode === "reset") f.service.reset();
      if (mode === "identity") f.auth.authorizationHeader.mockReturnValue({ Authorization: "Bearer other" });
      if (mode === "device") f.device.fingerprint.mockReturnValue("b".repeat(43));
      resolve(Response.json(control())); await task;
      expect(f.service.control()).toBeNull(); expect(f.service.selected()).toEqual([]);
      expect(f.service.busy()).toBe(false);
    });
  }
  it("bounds requests, aborts on timeout, and rejects concurrent actions", async () => {
    vi.useFakeTimers(); const f = fixture();
    f.fetch.mockImplementation((...args: unknown[]) => new Promise((_resolve, reject) => {
      const signal = (args[1] as RequestInit).signal!;
      signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    }));
    const task = f.service.load("user-action");
    await expect(f.service.load("user-action")).rejects.toThrow("invalid_native_standby_selection");
    await vi.advanceTimersByTimeAsync(15_000); await task;
    expect(f.service.busy()).toBe(false); expect(f.service.control()).toBeNull();
    expect(f.fetch).toHaveBeenCalledOnce();
  });
  it("validates exact responses, scope, revisions and unique bounded IDs", () => {
    expect(parseNativeStandbyControl(control(), PROGRAM, 2)).toEqual(control());
    for (const invalid of [null, { ...control(), token: "canary" }, { ...control(), programEpoch: 3 },
      { ...control(), standbyRevision: -1 }, control(1, [FIRST, FIRST]), control(1, [FIRST, SECOND, FIRST])]) {
      expect(() => parseNativeStandbyControl(invalid, PROGRAM, 2)).toThrow("invalid_native_standby_control");
    }
  });
  it("rejects a successful HTTP response that did not commit the requested selection", async () => {
    const f = fixture(); await f.service.load("user-action"); f.service.select(FIRST, true);
    f.fetch.mockResolvedValue(Response.json(control(1, [SECOND])));
    await f.service.save(1, "user-action");
    expect(f.service.error()).toBe("invalid_native_standby_control"); expect(f.service.control()).toBeNull();
  });
});
