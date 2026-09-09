import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TrustedSourceWorkflowService } from "./trusted-source-workflow.service";
import { TrustedSourcePublisher } from "./trusted-source-publisher";
import { PeerMeshService } from "../webrtc/peer-mesh.service";
import { sourceIdentityReferences } from "./trusted-source-actions";
import type { SourceInvitation } from "./source-invitation-contract";

const NOW = 1800000000000;
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

it("connects the root service's real workflow to scoped signaling, ICE and the existing publisher factory", async () => {
  const claims = { iss: "https://identity.example.test", sub: "publisher", exp: NOW / 1000 + 300 };
  let joined = true, subscriber: (message: any) => void = () => {};
  const fingerprint = "a".repeat(43), peerId = "0123456789abcdef", roomId = "room-alpha", epoch = 3;
  const track = { id: "local-track", kind: "video", readyState: "live", stop: vi.fn() };
  const stop = vi.fn(), publisher = { stop, renew: vi.fn(), receiveSignal: vi.fn(async () => {}) };
  const start = vi.spyOn(TrustedSourcePublisher, "start").mockResolvedValue(publisher as never);
  const policy = { version: 1, directIceServers: [{ urls: "stun:fixture.invalid" }], peerRelayIceServers: [],
    infrastructureRelayIceServers: [], peerRelayAfterMs: 1, infrastructureRelayAfterMs: 2 };
  const signaling = { status: () => "connected", sendSourceControl: vi.fn(), subscribe: vi.fn((handler: typeof subscriber) => {
    subscriber = handler; return unsubscribe;
  }) }, unsubscribe = vi.fn();
  const mesh = { ownPeerId: () => peerId, membershipEpoch: () => epoch, ownPublicationTrack: vi.fn(() => track) };
  const service = new TrustedSourceWorkflowService({ claims: () => claims } as never, { fingerprint: () => fingerprint } as never,
    { joined: () => joined, machineExpiresAt: () => 0, roomId: () => roomId, peerId: () => peerId, icePolicy: () => policy } as never,
    mesh as never, signaling as never);
  try {
    expect(signaling.sendSourceControl).not.toHaveBeenCalled(); expect(start).not.toHaveBeenCalled();
    const request: SourceInvitation = { requestId: "bsr_" + "a".repeat(24), roomId, programId: "prg_aaaaaaaaaaaaaaaa",
      programEpoch: 1, programRevision: 1, ownerPeerId: "fedcba9876543210", targetPeerId: peerId,
      packagerRef: "pkr_aaaaaaaaaaaaaaaa", sourceKind: "camera", authority: "none", state: "pending", createdAt: NOW, expiresAt: NOW + 120000 };
    await service.workflow.prepare(request);
    subscriber({ version: 1, type: "trusted-source-publications", roomId, peerId, roomEpoch: epoch, publicationRevision: 1,
      publications: [{ publicationId: track.id, source: "camera", publicationEpoch: 2 }] });
    expect(service.view().selection?.publications[0].publicationId).toBe(track.id);
    service.workflow.approve(request.requestId, track.id, 60000, "user-action");
    const refs = await sourceIdentityReferences(claims.iss, claims.sub, fingerprint);
    const consent = { version: 1, type: "trusted-decrypt-consent", trigger: "user-action", consentId: "cns_aaaaaaaaaaaaaaaa",
      tenantId: refs.tenantId, roomId, roomEpoch: epoch, programId: request.programId, programEpoch: 1,
      grantorSubjectRef: refs.subjectRef, granteePackagerRef: request.packagerRef, granteeDeviceRef: "dev_aaaaaaaaaaaaaaaa",
      sourceId: "src_aaaaaaaaaaaaaaaa", sourceKind: "camera", purpose: "broadcast-program", status: "active", grantedAt: NOW, expiresAt: NOW + 60000 };
    const lease = { version: 1, type: "trusted-source-lease", sourceLeaseId: "sls_aaaaaaaaaaaaaaaa", revision: 1,
      assignmentId: "asn_aaaaaaaaaaaaaaaa", writerLeaseId: "lea_aaaaaaaaaaaaaaaa", fencingRevision: 1,
      publisherPeerId: peerId, publisherDeviceRef: refs.deviceRef, publicationId: track.id, publicationEpoch: 2,
      codec: "video/vp8", frameEnvelope: "codec-prefix-v1", issuedAt: NOW, expiresAt: NOW + 4000, consent };
    subscriber({ version: 1, type: "trusted-source-approved", requestId: request.requestId, consent });
    subscriber({ version: 1, type: "trusted-source-publisher-lease", lease }); await Promise.resolve();
    expect(start).toHaveBeenCalledOnce();
    const [actual, borrowed, config, ports] = start.mock.calls[0];
    expect(actual).toEqual(lease); expect(borrowed).toBe(track); expect(config.iceServers).toEqual(policy.directIceServers);
    expect(ports.authorized(lease as never)).toBe(true);
    joined = false; await vi.advanceTimersByTimeAsync(250);
    expect(ports.authorized(lease as never)).toBe(false); expect(stop).toHaveBeenCalledOnce();
    expect(track.stop).not.toHaveBeenCalled();
  } finally { service.ngOnDestroy(); }
  expect(unsubscribe).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
});

it("borrows only a matching live own track under stable authoritative membership", () => {
  const track = { id: "local", readyState: "live" }, publication = { local: true, source: "camera", track };
  const mesh = { publications: new Map([[track.id, publication]]), membershipStable: true };
  const borrow = (source = "camera") => PeerMeshService.prototype.ownPublicationTrack.call(mesh as never, track.id, source);
  expect(borrow()).toBe(track); expect(borrow("screen")).toBeNull();
  publication.local = false; expect(borrow()).toBeNull(); publication.local = true;
  mesh.membershipStable = false; expect(borrow()).toBeNull(); mesh.membershipStable = true;
  track.readyState = "ended"; expect(borrow()).toBeNull();
});
