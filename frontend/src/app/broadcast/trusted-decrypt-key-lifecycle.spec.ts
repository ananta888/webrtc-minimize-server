import { describe, expect, it, vi } from "vitest";

import { OpaqueDataOverlay } from "../webrtc/opaque-data-overlay";
import {
  TrustedDecryptConsent,
  TrustedDecryptKeyLifecycle,
  parseTrustedDecryptConsent,
  sealTrustedDecryptKey,
} from "./trusted-decrypt-key-lifecycle";

const NOW = 1_800_000_000_000;

function consent(overrides: Partial<TrustedDecryptConsent> = {}): TrustedDecryptConsent {
  return {
    version: 1,
    type: "trusted-decrypt-consent",
    trigger: "user-action",
    consentId: "cns_aaaaaaaaaaaaaaaa",
    tenantId: "tn_aaaaaaaaaaaaaaaa",
    roomId: "room-alpha",
    roomEpoch: 11,
    programId: "prg_aaaaaaaaaaaaaaaa",
    programEpoch: 7,
    grantorSubjectRef: "sub_cccccccccccccccc",
    granteePackagerRef: "pkr_dddddddddddddddd",
    granteeDeviceRef: "dev_eeeeeeeeeeeeeeee",
    sourceId: "src_aaaaaaaaaaaaaaaa",
    sourceKind: "camera",
    purpose: "broadcast-program",
    status: "active",
    grantedAt: NOW - 1_000,
    expiresAt: NOW + 120_000,
    ...overrides,
  };
}

const sourceKey = () => Uint8Array.from({ length: 16 }, (_, index) => index + 1);

describe("TrustedDecryptKeyLifecycle", () => {
  it("wraps a source key only for the explicitly consented packager device and clears it after install", async () => {
    const cleared: string[] = [];
    const lifecycle = new TrustedDecryptKeyLifecycle((contextId) => cleared.push(contextId));
    const authorization = consent();
    const announcement = await lifecycle.authorize(authorization, NOW);
    expect(announcement.publicKey).toMatchObject({ kty: "EC", crv: "P-256", ext: true, key_ops: [] });

    const envelope = await sealTrustedDecryptKey({
      consent: authorization,
      announcement,
      keyId: "0011223344556677",
      baseKey: sourceKey(),
      now: NOW,
    });
    let installed: Uint8Array | null = null;
    let transientReference: Uint8Array | null = null;
    await lifecycle.install(envelope, authorization, "broadcast:camera", (contextId, keyId, key) => {
      expect(contextId).toBe("broadcast:camera");
      expect(keyId).toBe("0011223344556677");
      transientReference = key;
      installed = Uint8Array.from(key);
      return true;
    }, NOW);
    expect(installed).toEqual(sourceKey());
    expect(transientReference).toEqual(new Uint8Array(16));
    expect(lifecycle.activeConsentIds()).toEqual([authorization.consentId]);

    lifecycle.revoke(authorization.consentId);
    expect(cleared).toEqual(["broadcast:camera"]);
    expect(lifecycle.activeConsentIds()).toEqual([]);
  });

  it("rejects replay and authenticated changes to source, target, room, epoch or purpose", async () => {
    const lifecycle = new TrustedDecryptKeyLifecycle(() => undefined);
    const authorization = consent();
    const announcement = await lifecycle.authorize(authorization, NOW);
    const envelope = await sealTrustedDecryptKey({
      consent: authorization, announcement, keyId: "0011223344556677", baseKey: sourceKey(), now: NOW,
    });
    await lifecycle.install(envelope, authorization, "broadcast:camera", () => true, NOW);
    await expect(lifecycle.install(envelope, authorization, "broadcast:camera", () => true, NOW))
      .rejects.toThrow("replayed_trusted_decrypt_key");

    for (const patch of [
      { sourceId: "src_bbbbbbbbbbbbbbbb" },
      { granteeDeviceRef: "dev_ffffffffffffffff" },
      { roomId: "room-other" },
      { roomEpoch: 12 },
      { programEpoch: 8 },
      { purpose: "record-media" },
    ]) {
      await expect(lifecycle.install({ ...envelope, ...patch }, authorization, "broadcast:camera", () => true, NOW))
        .rejects.toThrow("invalid_trusted_decrypt_key");
    }
  });

  it("authenticates all envelope fields and cannot be opened by another device key", async () => {
    const first = new TrustedDecryptKeyLifecycle(() => undefined);
    const second = new TrustedDecryptKeyLifecycle(() => undefined);
    const authorization = consent();
    const firstAnnouncement = await first.authorize(authorization, NOW);
    const secondAnnouncement = await second.authorize(authorization, NOW);
    const envelope = await sealTrustedDecryptKey({
      consent: authorization,
      announcement: firstAnnouncement,
      keyId: "0011223344556677",
      baseKey: sourceKey(),
      now: NOW,
    });
    await expect(second.install({
      ...envelope,
      agreementKeyId: secondAnnouncement.agreementKeyId,
    }, authorization, "broadcast:camera", () => true, NOW)).rejects.toThrow(
      "trusted_decrypt_key_authentication_failed",
    );
    await expect(first.install({ ...envelope, keyId: "7766554433221100" }, authorization,
      "broadcast:camera", () => true, NOW)).rejects.toThrow("trusted_decrypt_key_authentication_failed");
  });

  it("requires fresh user-action consent and rejects silent source extension", () => {
    expect(() => parseTrustedDecryptConsent({ ...consent(), trigger: "remote-signal" }, NOW))
      .toThrow("invalid_trusted_decrypt_consent");
    expect(() => parseTrustedDecryptConsent({ ...consent(), sourceIds: ["src_aaaaaaaaaaaaaaaa"] }, NOW))
      .toThrow("invalid_trusted_decrypt_consent");
    expect(() => parseTrustedDecryptConsent({ ...consent(), expiresAt: NOW }, NOW))
      .toThrow("invalid_trusted_decrypt_consent");
    expect(() => parseTrustedDecryptConsent({ ...consent(), expiresAt: NOW + 11 * 60_000 }, NOW))
      .toThrow("invalid_trusted_decrypt_consent");
  });

  it("drops every context on epoch change, handoff, leave and destroy without retaining raw keys", async () => {
    const clear = vi.fn();
    const lifecycle = new TrustedDecryptKeyLifecycle(clear);
    const firstConsent = consent();
    const announcement = await lifecycle.authorize(firstConsent, NOW);
    const envelope = await sealTrustedDecryptKey({
      consent: firstConsent, announcement, keyId: "0011223344556677", baseKey: sourceKey(), now: NOW,
    });
    await lifecycle.install(envelope, firstConsent, "broadcast:camera", () => true, NOW);
    lifecycle.retainEpochs(firstConsent.roomId, firstConsent.roomEpoch + 1,
      firstConsent.programId, firstConsent.programEpoch);
    expect(clear).toHaveBeenCalledWith("broadcast:camera");

    const handoffConsent = consent({ consentId: "cns_bbbbbbbbbbbbbbbb", programEpoch: 8 });
    await lifecycle.authorize(handoffConsent, NOW);
    lifecycle.revokeProgram(handoffConsent.programId);
    expect(lifecycle.activeConsentIds()).toEqual([]);

    const leaveConsent = consent({ consentId: "cns_cccccccccccccccc", programEpoch: 9 });
    await lifecycle.authorize(leaveConsent, NOW);
    lifecycle.revokeRoom(leaveConsent.roomId);
    expect(lifecycle.activeConsentIds()).toEqual([]);

    const destroyConsent = consent({ consentId: "cns_dddddddddddddddd", programEpoch: 10 });
    await lifecycle.authorize(destroyConsent, NOW);
    lifecycle.destroy();
    expect(lifecycle.activeConsentIds()).toEqual([]);
    await expect(lifecycle.authorize(destroyConsent, NOW)).rejects.toThrow("trusted_decrypt_lifecycle_destroyed");
  });

  it("projects only bounded UI metadata and emits content-free audit events including automatic expiry", async () => {
    const clear = vi.fn();
    const cancel = vi.fn();
    const events: unknown[] = [];
    let expire = () => undefined;
    const lifecycle = new TrustedDecryptKeyLifecycle(
      clear,
      (callback) => {
        expire = callback;
        return 1 as unknown as ReturnType<typeof setTimeout>;
      },
      cancel,
      (event) => events.push(event),
    );
    const authorization = consent();
    const announcement = await lifecycle.authorize(authorization, NOW);
    expect(lifecycle.view()).toEqual([expect.objectContaining({
      consentId: authorization.consentId,
      granteePackagerRef: authorization.granteePackagerRef,
      granteeDeviceRef: authorization.granteeDeviceRef,
      sourceId: authorization.sourceId,
      sourceKind: "camera",
      state: "waiting-key",
    })]);
    const envelope = await sealTrustedDecryptKey({
      consent: authorization, announcement, keyId: "0011223344556677", baseKey: sourceKey(), now: NOW,
    });
    await lifecycle.install(envelope, authorization, "broadcast:camera", () => true, NOW);
    expect(lifecycle.view()[0].state).toBe("active");
    expire();
    expect(lifecycle.view()).toEqual([]);
    expect(clear).toHaveBeenCalledWith("broadcast:camera");
    expect(events).toEqual([
      expect.objectContaining({ eventType: "consent-authorized", reasonCode: "user-action" }),
      expect.objectContaining({ eventType: "key-installed", reasonCode: "source-key-installed" }),
      expect.objectContaining({ eventType: "consent-revoked", reasonCode: "expired" }),
    ]);
    for (const event of events as Record<string, unknown>[]) {
      expect(event).not.toHaveProperty("keyId");
      expect(event).not.toHaveProperty("publicKey");
      expect(event).not.toHaveProperty("ciphertext");
      expect(event).not.toHaveProperty("token");
    }
    expect(cancel).toHaveBeenCalled();
  });

  it("crosses a blind overlay relay only as target-bound ciphertext", async () => {
    const publisherPeer = "aaaaaaaaaaaaaaaa";
    const relayPeer = "bbbbbbbbbbbbbbbb";
    const packagerPeer = "cccccccccccccccc";
    const publisherOverlay = new OpaqueDataOverlay();
    const relayOverlay = new OpaqueDataOverlay();
    const packagerOverlay = new OpaqueDataOverlay();
    const publisherPublic = await publisherOverlay.initialize(publisherPeer);
    await relayOverlay.initialize(relayPeer);
    const packagerPublic = await packagerOverlay.initialize(packagerPeer);
    await publisherOverlay.setPeerKey(packagerPeer, packagerPublic);
    await packagerOverlay.setPeerKey(publisherPeer, publisherPublic);

    const lifecycle = new TrustedDecryptKeyLifecycle(() => undefined);
    const authorization = consent({ roomEpoch: 2 });
    const announcement = await lifecycle.authorize(authorization, NOW);
    const envelope = await sealTrustedDecryptKey({
      consent: authorization, announcement, keyId: "0011223344556677", baseKey: sourceKey(), now: NOW,
    });
    const cleartext = new TextEncoder().encode(JSON.stringify(envelope));
    const [packet] = await publisherOverlay.encrypt(packagerPeer, cleartext, {
      membershipEpoch: 2,
      routeEpoch: 4,
      trafficClass: "rekey",
      path: [publisherPeer, relayPeer, packagerPeer],
    }, NOW);
    expect(packet.ciphertext).not.toContain(envelope.consentId);
    const overlayContext = {
      membershipEpoch: 2, routeEpoch: 4, memberPeerIds: new Set([publisherPeer, relayPeer, packagerPeer]),
    };
    const forwarded = await relayOverlay.receive(packet, publisherPeer, overlayContext, NOW + 1);
    expect(forwarded.action).toBe("forward");
    if (forwarded.action !== "forward") throw new Error("expected_forward");
    const delivered = await packagerOverlay.receive(forwarded.packet, relayPeer, overlayContext, NOW + 2);
    expect(delivered.action).toBe("delivered");
    if (delivered.action !== "delivered") throw new Error("expected_delivery");
    let installed: Uint8Array | null = null;
    await lifecycle.install(JSON.parse(new TextDecoder().decode(delivered.data)), authorization,
      "broadcast:camera", (_contextId, _keyId, key) => {
        installed = Uint8Array.from(key);
        return true;
      }, NOW + 2);
    expect(installed).toEqual(sourceKey());
    lifecycle.destroy();
    publisherOverlay.destroy();
    relayOverlay.destroy();
    packagerOverlay.destroy();
  });
});
