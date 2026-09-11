import { afterEach, describe, expect, it, vi } from "vitest";
import { nativePackagerDigestCommand, nativePackagerUpdateCommand, nativePackagerVerificationCommand, parseNativePackagerRelease } from "./native-packager-release";
import { NativePackagerReleaseService } from "./native-packager-release.service";
import { NativePackagerMigrationService } from "./native-packager-migration.service";
import { OidcAuthService } from "../auth/oidc-auth.service";

const fixture = () => ({ version: 1, type: "native-packager-release", repository: "ananta888/webrtc-minimize-server",
  workflow: "ananta888/webrtc-minimize-server/.github/workflows/ci.yml", revision: "a".repeat(40),
  builtAt: "2026-09-06T10:00:00Z", agentVersion: "0.7.0", goVersion: "go1.24.13",
  artifacts: ["linux-amd64", "linux-arm64", "macos-amd64", "macos-arm64", "windows-amd64"].map(target => ({
    target, filename: `native-broadcast-packager-${target}${target.startsWith("windows") ? ".exe" : ""}`, sha256: "b".repeat(64), bytes: 1234,
  })) });
describe("native packager release trust boundary", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
  it("accepts only closed metadata with exact targets and immutable records", () => {
    const release = parseNativePackagerRelease(fixture());
    expect(Object.isFrozen(release.artifacts[0])).toBe(true);
    for (const invalid of [{ ...fixture(), verified: true }, { ...fixture(), revision: "abc;execute" },
      { ...fixture(), builtAt: "2026-02-30T10:00:00Z" }, { ...fixture(), workflow: "other/repo/workflow" },
      { ...fixture(), artifacts: fixture().artifacts.reverse() }]) expect(() => parseNativePackagerRelease(invalid)).toThrow("invalid");
    const invalid = fixture(); invalid.artifacts[0].filename = "../injected.ps1";
    expect(() => parseNativePackagerRelease(invalid)).toThrow("invalid");
  });
  it("constructs fixed provenance policy and device-bound platform-matching commands", () => {
    const release = parseNativePackagerRelease(fixture()), id = "pkr_0123456789abcdef";
    const verify = nativePackagerVerificationCommand(release, release.artifacts[0]);
    expect(verify).toContain("--source-ref refs/heads/main --deny-self-hosted-runners");
    expect(verify).toContain(`--source-digest ${release.revision}`);
    expect(verify).toContain("--signer-workflow ananta888/webrtc-minimize-server/.github/workflows/ci.yml");
    expect(nativePackagerVerificationCommand(release)).toContain("./native-packager-release.v1.json");
    expect(nativePackagerUpdateCommand(id, "windows", release.artifacts[4])).toContain(`NativePackager\\${id}\\update-${id}.ps1`);
    expect(nativePackagerUpdateCommand(id, "linux", release.artifacts[0])).toContain(`${id}/update-${id}`);
    expect(() => nativePackagerUpdateCommand(id, "linux", release.artifacts[4])).toThrow("invalid");
    expect(() => nativePackagerUpdateCommand("../other", "linux", release.artifacts[0])).toThrow("invalid");
    expect(() => nativePackagerVerificationCommand(release, { ...release.artifacts[0], filename: "injected" })).toThrow("invalid");
    expect(nativePackagerDigestCommand(release.artifacts[0], "linux")).toContain(release.artifacts[0].sha256);
    expect(nativePackagerDigestCommand(release.artifacts[0], "linux")).toContain("sha256sum -c");
    expect(nativePackagerDigestCommand(release.artifacts[4], "windows")).toContain("Get-FileHash");
    expect(() => nativePackagerDigestCommand(release.artifacts[0], "windows")).toThrow("invalid");
  });
  it("loads only on an explicit call, without tokens, capture, enrollment or redirects", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(fixture()), { headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const service = new NativePackagerReleaseService();
    expect(fetchMock).not.toHaveBeenCalled(); await service.load();
    expect(service.release()?.artifacts).toHaveLength(5);
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith("/downloads/native-packager/release.json", expect.objectContaining({ credentials: "omit", cache: "no-store", redirect: "error" }));
    expect(service.busy()).toBe(false);
  });
  it("clears stale metadata on malformed, missing and streamed oversize responses", async () => {
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    const service = new NativePackagerReleaseService();
    for (const response of [new Response("{}", { status: 503 }), new Response("{}"),
      new Response(" ".repeat(32769), { headers: { "content-type": "application/json" } })]) {
      service.release.set(parseNativePackagerRelease(fixture())); fetchMock.mockResolvedValueOnce(response);
      await service.load(); expect(service.release()).toBe(null); expect(service.error()).toContain("Kein Update"); expect(service.busy()).toBe(false);
    }
  });
  it("bounds an interrupted streaming response and excludes concurrent refreshes", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn(async (_url, options: RequestInit) => new Response(new ReadableStream({
      start(controller) { options.signal?.addEventListener("abort", () => controller.error(new Error("aborted"))); },
    }), { headers: { "content-type": "application/json" } })));
    const service = new NativePackagerReleaseService();
    const pending = service.load(); await service.load();
    await vi.advanceTimersByTimeAsync(15001); await pending;
    expect(fetch).toHaveBeenCalledTimes(1); expect(service.busy()).toBe(false); expect(service.release()).toBe(null);
  });
});

describe("native packager migration download boundary", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });
  const id = "pkr_0123456789abcdef";
  const create = () => new NativePackagerMigrationService({ authorizationHeader: () => ({ Authorization: "Bearer synthetic" }) } as OidcAuthService);
  it("does nothing until explicitly called and rejects foreign, platform or metadata inputs before fetching", async () => {
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    const service = create(), release = parseNativePackagerRelease(fixture());
    expect(fetchMock).not.toHaveBeenCalled();
    for (const [agent, artifact] of [["../foreign", release.artifacts[0]], [id, release.artifacts[4]], [id, { ...release.artifacts[0] }]] as const) {
      await service.download(agent, release, artifact); expect(service.error()).not.toBe("");
      expect(service.filename()).toBe(""); expect(service.busy()).toBe(false);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("fails closed on stale bindings, unknown fields, malformed and oversized responses", async () => {
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    const service = create(), release = parseNativePackagerRelease(fixture()), artifact = release.artifacts[0];
    const body = { version: 1, type: "native-packager-migration", packagerId: id, target: artifact.target,
      revision: release.revision, artifactSha256: artifact.sha256, filename: `migrate-${id}.sh`, script: `#!/bin/sh\n#${"x".repeat(100)}` };
    for (const value of [{ ...body, packagerId: "pkr_fedcba9876543210" }, { ...body, revision: "c".repeat(40) },
      { ...body, artifactSha256: "d".repeat(64) }, { ...body, filename: "../other.sh" }, { ...body, verified: true },
      { ...body, script: "#!/bin/sh\nshort" }, { ...body, script: "x".repeat(262145) }]) {
      fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } }));
      service.filename.set("stale.sh"); await service.download(id, release, artifact);
      expect(service.filename()).toBe(""); expect(service.error()).not.toBe(""); expect(service.busy()).toBe(false);
    }
    expect(fetchMock).toHaveBeenCalledWith(`/api/native-packagers/${id}/migration`, expect.objectContaining({
      method: "POST", cache: "no-store", redirect: "error", body: JSON.stringify({ target: artifact.target, revision: release.revision, sha256: artifact.sha256 }),
    }));
  });
  it("bounds a stalled response and refuses concurrent downloads", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn(async (_url, options: RequestInit) => new Response(new ReadableStream({
      start(controller) { options.signal?.addEventListener("abort", () => controller.error(new Error("aborted"))); },
    }), { headers: { "content-type": "application/json" } })));
    const service = create(), release = parseNativePackagerRelease(fixture());
    const pending = service.download(id, release, release.artifacts[0]); await service.download(id, release, release.artifacts[0]);
    await vi.advanceTimersByTimeAsync(15001); await pending;
    expect(fetch).toHaveBeenCalledTimes(1); expect(service.busy()).toBe(false); expect(service.filename()).toBe("");
  });
});
