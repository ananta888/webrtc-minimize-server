import { describe, expect, it } from "vitest";

import {
  BrowserWhipBroadcastRuntimeService,
  ExplicitBroadcastConsentService,
} from "./broadcast-browser-runtime.service";

const program = {
  tenantId: "tn_aaaaaaaaaaaaaaaa",
  roomId: "room-alpha",
  programId: "prg_bbbbbbbbbbbbbbbb",
  programRevision: 2,
  programEpoch: 3,
};

describe("broadcast browser runtime adapters", () => {
  it("grants only a short-lived explicit decision for local active sources", async () => {
    const service = new ExplicitBroadcastConsentService();
    const source = {
      sourceId: "src_aaaaaaaaaaaaaaaa",
      ownerSubjectRef: "sub_cccccccccccccccc",
      kind: "camera" as const,
      local: true,
      active: true,
    };
    const before = Date.now();
    const decision = await service.authorize(program, [source], new AbortController().signal);
    expect(decision.programEpoch).toBe(3);
    expect(decision.sourceIds).toEqual([source.sourceId]);
    expect(decision.expiresAt).toBeGreaterThan(before);
    expect(decision.expiresAt).toBeLessThanOrEqual(before + 45_100);
    await expect(service.authorize(
      program,
      [{ ...source, local: false }],
      new AbortController().signal,
    )).rejects.toMatchObject({ code: "broadcast_own_source_consent_required" });
  });

  it("advertises WHIP as unavailable until validated runtime configuration is loaded", async () => {
    const service = new BrowserWhipBroadcastRuntimeService(
      { value: () => null } as never,
      {} as never,
      {} as never,
    );
    expect(service.capability).toMatchObject({
      adapterId: "whip-browser",
      available: false,
      reasonCode: "whip-not-configured",
    });
    await expect(service.start({
      requestVersion: 1,
      program,
      composition: { compositionId: "composition-1", sourceIds: ["src_aaaaaaaaaaaaaaaa"] },
    }, new AbortController().signal)).rejects.toMatchObject({ code: "whip-not-configured" });
  });
});
