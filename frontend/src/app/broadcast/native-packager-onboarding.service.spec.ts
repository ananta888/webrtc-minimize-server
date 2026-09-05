import { beforeEach, describe, expect, it, vi } from "vitest";

import { NativePackagerOnboardingService } from "./native-packager-onboarding.service";

describe("NativePackagerOnboardingService", () => {
  const auth = { authorizationHeader: () => ({ authorization: "Bearer test" }) };

  beforeEach(() => {
    vi.restoreAllMocks();
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn(() => "blob:installer") });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
  });

  it("loads only a closed account-bound packager projection", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ packagers: [{
      id: "pkr_0123456789abcdef", label: "Mini-PC", platform: "linux", keyFingerprint: "A".repeat(43),
      createdAt: 1, lastAuthenticatedAt: 2, revokedAt: 0, online: true,
      consentedRoomIds: ["room-1234"], confirmedRoomIds: ["room-1234"],
      capability: { ffmpegVersion: "8.1", health: "healthy", maximumRenditions: 3 }, heartbeat: null,
    }], assignments: [{
      assignmentId: "asn_0123456789abcdef", packagerId: "pkr_0123456789abcdef", roomId: "room-1234",
      programId: "prg_0123456789abcdef", programEpoch: 2, fencingRevision: 3,
      profileId: "h264-aac-720p-v1", renditionIds: ["low", "medium"], state: "ready",
      reasonCode: "CAPABILITY_READY", createdAt: 1, updatedAt: 2, expiresAt: 3,
    }] }), { status: 200, headers: { "content-type": "application/json" } })));
    const service = new NativePackagerOnboardingService(auth as never);
    await service.load();
    expect(service.packagers()[0]).toMatchObject({ label: "Mini-PC", online: true });
    expect(service.assignments()[0]).toMatchObject({ state: "ready", renditionIds: ["low", "medium"] });
    expect(service.eligible("room-1234")).toHaveLength(1);
    expect(service.select("pkr_0123456789abcdef")).toBe(true);
    expect(service.selectedPackagerId()).toBe("pkr_0123456789abcdef");
  });

  it("sends room consent only to the exact encoded resource", async () => {
    const fetchMock = vi.fn(async (url: string) => new Response(JSON.stringify(url.includes("room-consents")
      ? { enabled: true }
      : { packagers: [{
        id: "pkr_0123456789abcdef", label: "Mini-PC", platform: "linux", keyFingerprint: "A".repeat(43),
        createdAt: 1, lastAuthenticatedAt: 2, revokedAt: 0, online: true,
        consentedRoomIds: ["room-1234"], confirmedRoomIds: ["room-1234"],
        capability: { ffmpegVersion: "8.1", health: "healthy", maximumRenditions: 3 }, heartbeat: null,
      }], assignments: [] }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const service = new NativePackagerOnboardingService(auth as never);
    await service.setRoomConsent("pkr_0123456789abcdef", "room-1234", true);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/native-packagers/pkr_0123456789abcdef/room-consents/room-1234");
    expect(JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body))).toEqual({ enabled: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not offer requested consent until the agent confirms it", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ packagers: [{
      id: "pkr_0123456789abcdef", label: "Mini-PC", platform: "linux", keyFingerprint: "A".repeat(43),
      createdAt: 1, lastAuthenticatedAt: 2, revokedAt: 0, online: true,
      consentedRoomIds: ["room-1234"], confirmedRoomIds: [],
      capability: { ffmpegVersion: "8.1", health: "healthy", maximumRenditions: 3 }, heartbeat: null,
    }], assignments: [] }), { status: 200, headers: { "content-type": "application/json" } })));
    const service = new NativePackagerOnboardingService(auth as never);
    await service.load();
    expect(service.eligible("room-1234")).toEqual([]);
  });

  it("stops only an exact owned assignment resource", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ packagers: [], assignments: [] }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const service = new NativePackagerOnboardingService(auth as never);
    await service.stopAssignment("pkr_0123456789abcdef", "asn_0123456789abcdef");
    expect(fetchMock.mock.calls[0][0]).toBe("/api/native-packagers/pkr_0123456789abcdef/assignments/asn_0123456789abcdef");
    expect((fetchMock.mock.calls[0][1] as RequestInit).method).toBe("DELETE");
  });

  it("rejects malformed IDs before network access", async () => {
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    const service = new NativePackagerOnboardingService(auth as never);
    await expect(service.setRoomConsent("../other", "room-1234", true)).rejects.toThrow("invalid");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
