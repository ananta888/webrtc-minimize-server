import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { TrustedSourceWorkflow, SourceWorkflowView } from "./trusted-source-workflow";
import { SourcePublisherContext, parseOwnSourcePublications, parseSourceStop, sourceIdentityReferences } from "./trusted-source-actions";
import type { SourceInvitation } from "./broadcast-source-requests.service";
import type { TrustedSourceLease } from "./trusted-source-contract";
import { createHash } from "node:crypto";

const NOW = 1800000000000;
const context: SourcePublisherContext = { roomId: "room-alpha", peerId: "0123456789abcdef", roomEpoch: 11,
  fingerprint: "a".repeat(43), identity: "fixture" };
const request: SourceInvitation = { requestId: "bsr_" + "a".repeat(24), roomId: context.roomId, programId: "prg_aaaaaaaaaaaaaaaa",
  programEpoch: 7, programRevision: 1, ownerPeerId: "fedcba9876543210", targetPeerId: context.peerId,
  packagerRef: "pkr_dddddddddddddddd", sourceKind: "camera", state: "pending", authority: "none", createdAt: NOW, expiresAt: NOW + 120000 };
const own = { publicationId: "track-camera", source: "camera" as const, publicationEpoch: 7 };
function lease(): TrustedSourceLease {
  return { version: 1, type: "trusted-source-lease", sourceLeaseId: "sls_aaaaaaaaaaaaaaaa", revision: 1,
    assignmentId: "asn_aaaaaaaaaaaaaaaa", writerLeaseId: "lea_aaaaaaaaaaaaaaaa", fencingRevision: 3,
    publisherPeerId: context.peerId, publisherDeviceRef: "dev_pppppppppppppppp", publicationId: own.publicationId, publicationEpoch: 7,
    codec: "video/vp8", frameEnvelope: "codec-prefix-v1", issuedAt: NOW, expiresAt: NOW + 4000,
    consent: { version: 1, type: "trusted-decrypt-consent", trigger: "user-action", consentId: "cns_aaaaaaaaaaaaaaaa", tenantId: "tn_aaaaaaaaaaaaaaaa",
      roomId: context.roomId, roomEpoch: 11, programId: request.programId, programEpoch: 7, grantorSubjectRef: "sub_cccccccccccccccc",
      granteePackagerRef: request.packagerRef, granteeDeviceRef: "dev_eeeeeeeeeeeeeeee", sourceId: "src_aaaaaaaaaaaaaaaa", sourceKind: "camera",
      purpose: "broadcast-program", status: "active", grantedAt: NOW, expiresAt: NOW + 60000 } };
}
const sourceResponse = () => ({ version: 1, type: "trusted-source-publications", roomId: context.roomId,
  peerId: context.peerId, roomEpoch: 11, publicationRevision: 1, publications: [own] });
const approval = () => ({ version: 1, type: "trusted-source-approved", requestId: request.requestId, consent: lease().consent });
const ready = (value = lease()) => ({ version: 1, type: "trusted-source-publisher-lease", lease: value });
function fixture() {
  let current: SourcePublisherContext | null = { ...context };
  let track = { id: own.publicationId, kind: "video", readyState: "live", stop: vi.fn() };
  let view: SourceWorkflowView;
  const publisher = { stop: vi.fn(), renew: vi.fn(), receiveSignal: vi.fn(async () => {}) };
  const ports = { context: () => current,
    references: vi.fn(async () => ({ tenantId: lease().consent.tenantId, subjectRef: lease().consent.grantorSubjectRef, deviceRef: lease().publisherDeviceRef })),
    track: vi.fn(() => track as unknown as MediaStreamTrack), send: vi.fn(), start: vi.fn(async (..._args: any[]) => publisher),
    changed: (next: SourceWorkflowView) => { view = next; } };
  const workflow = new TrustedSourceWorkflow(ports);
  const prepare = async () => { await workflow.prepare(request); workflow.receive(sourceResponse()); };
  const approve = async () => { await prepare(); workflow.approve(request.requestId, own.publicationId, 60000, "user-action"); };
  return { workflow, ports, publisher, prepare, approve, view: () => view!, track: () => track,
    changeContext: (value: SourcePublisherContext | null) => { current = value; }, replaceTrack: () => { track = { ...track, stop: vi.fn() }; } };
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("explicit browser source workflow", () => {
  it("derives the exact server public-reference hashes and rejects ambiguous control characters", async () => {
    const issuer = "https://identity.example.test/realms/test", subject = "test-subject", fingerprint = "a".repeat(43);
    const hash = (prefix: string, value: string) => prefix + createHash("sha256").update(value).digest("base64url").slice(0, 32);
    expect(await sourceIdentityReferences(issuer, subject, fingerprint)).toEqual({
      tenantId: hash("tn_", "issuer\0" + issuer), subjectRef: hash("sub_", "subject\0" + issuer + "\0" + subject),
      deviceRef: hash("dev_", "device\0" + fingerprint),
    });
    await expect(sourceIdentityReferences(issuer, "bad\0subject", fingerprint)).rejects.toThrow();
    await expect(sourceIdentityReferences(issuer, subject, "invalid")).rejects.toThrow();
  });
  it("performs no operation at construction or from an unsolicited approval/lease", () => {
    const f = fixture(); f.workflow.receive(approval()); f.workflow.receive(ready());
    expect(f.ports.start).not.toHaveBeenCalled(); expect(f.ports.send).not.toHaveBeenCalled();
  });
  it("queries current own metadata without starting a sender; requires a final local click and both ACKs", async () => {
    const f = fixture(); await f.prepare();
    expect(f.ports.send).toHaveBeenCalledExactlyOnceWith({ version: 1, type: "trusted-source-publications" });
    expect(f.view().selection?.publications).toEqual([own]); expect(f.ports.start).not.toHaveBeenCalled();
    f.workflow.approve(request.requestId, own.publicationId, 60000, "user-action");
    expect(f.ports.send.mock.calls[1][0]).toMatchObject({ type: "trusted-source-approve", approval: { expectedPublicationEpoch: 7 } });
    f.workflow.receive(approval()); expect(f.ports.start).not.toHaveBeenCalled();
    f.workflow.receive(ready()); await Promise.resolve();
    expect(f.ports.start).toHaveBeenCalledOnce(); expect(f.view().publications[0].phase).toBe("waiting-key");
    f.ports.start.mock.calls[0][4]("sending"); expect(f.view().publications[0].phase).toBe("sending");
    f.workflow.revoke(request.requestId); expect(f.publisher.stop).toHaveBeenCalledOnce();
    expect(f.track().stop).not.toHaveBeenCalled();
    expect(f.ports.send).toHaveBeenLastCalledWith({ version: 1, type: "trusted-source-revoke", consentId: lease().consent.consentId });
  });
  it("accepts receiver-before-consent ordering but never uses it as local consent", async () => {
    const f = fixture(); await f.approve(); f.workflow.receive(ready()); expect(f.ports.start).not.toHaveBeenCalled();
    f.workflow.receive(approval()); await Promise.resolve(); expect(f.ports.start).toHaveBeenCalledOnce();
  });
  it.each(["room", "peer", "identity", "fingerprint", "epoch", "track", "ended", "expiry"])("retires only its sender after %s changes", async kind => {
    const f = fixture(); await f.approve(); f.workflow.receive(approval()); f.workflow.receive(ready()); await Promise.resolve();
    if (kind === "room") f.changeContext({ ...context, roomId: "room-other" });
    if (kind === "peer") f.changeContext({ ...context, peerId: "aaaaaaaaaaaaaaaa" });
    if (kind === "identity") f.changeContext({ ...context, identity: "other" });
    if (kind === "fingerprint") f.changeContext({ ...context, fingerprint: "b".repeat(43) });
    if (kind === "epoch") f.changeContext({ ...context, roomEpoch: 12 });
    if (kind === "track") f.replaceTrack();
    if (kind === "ended") f.track().readyState = "ended";
    if (kind === "expiry") vi.setSystemTime(NOW + 4001);
    f.workflow.tick(); expect(f.publisher.stop).toHaveBeenCalledOnce(); expect(f.track().stop).not.toHaveBeenCalled();
    expect(f.view().publications[0].phase).toBe("failed");
  });
  it("rejects source replacement between selection and explicit approval", async () => {
    const f = fixture(); await f.prepare(); f.replaceTrack(); f.workflow.approve(request.requestId, own.publicationId, 60000, "user-action");
    expect(f.ports.send).toHaveBeenCalledTimes(1); expect(f.ports.start).not.toHaveBeenCalled();
  });
  it("revokes a late approval after local cancellation without starting", async () => {
    const f = fixture(); await f.approve(); f.workflow.revoke(request.requestId); f.workflow.receive(approval()); f.workflow.receive(ready());
    expect(f.ports.start).not.toHaveBeenCalled(); expect(f.ports.send).toHaveBeenLastCalledWith({ version: 1, type: "trusted-source-revoke", consentId: lease().consent.consentId });
  });
  it("closes a late publisher after cancellation without touching its room track", async () => {
    const f = fixture(); let finish!: (value: typeof f.publisher) => void;
    f.ports.start.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    await f.approve(); f.workflow.receive(approval()); f.workflow.receive(ready()); f.workflow.revoke(request.requestId);
    finish(f.publisher); await Promise.resolve(); expect(f.publisher.stop).toHaveBeenCalledOnce(); expect(f.track().stop).not.toHaveBeenCalled();
  });
  it("does not clear a fresh selection after an old identity-digest promise fails", async () => {
    const f = fixture(); let reject!: (error: Error) => void;
    f.ports.references.mockImplementationOnce(() => new Promise((_, no) => { reject = no; }));
    const old = f.workflow.prepare(request); f.workflow.cancelSelection(); await f.prepare();
    reject(new Error("old")); await old;
    expect(f.view().selection?.requestId).toBe(request.requestId);
  });
  it("honors a current renewed lease but never extends the original user consent", async () => {
    const f = fixture(); await f.approve(); f.workflow.receive(approval()); f.workflow.receive(ready()); await Promise.resolve();
    vi.setSystemTime(NOW + 1000); const renewal = { ...lease(), revision: 2, issuedAt: NOW + 1000, expiresAt: NOW + 5000 };
    f.workflow.receive(ready(renewal)); expect(f.publisher.renew).toHaveBeenCalledExactlyOnceWith(renewal);
    vi.setSystemTime(NOW + 4500); f.workflow.tick(); expect(f.publisher.stop).not.toHaveBeenCalled();
    vi.setSystemTime(NOW + 5001); f.workflow.tick(); expect(f.publisher.stop).toHaveBeenCalledOnce();
  });
  it("queues validated early SDP during sender construction and drains it after startup", async () => {
    const f = fixture(); let finish!: (value: typeof f.publisher) => void;
    f.ports.start.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    await f.approve(); f.workflow.receive(approval()); f.workflow.receive(ready());
    const value = lease(), answer = { version: 1, type: "trusted-source-agent-signal", sourceLeaseId: value.sourceLeaseId,
      consentId: value.consent.consentId, assignmentId: value.assignmentId, fencingRevision: value.fencingRevision,
      negotiationRevision: 1, sequence: 1, packagerId: value.consent.granteePackagerRef,
      packagerDeviceRef: value.consent.granteeDeviceRef, description: { type: "answer", sdp: "v=0\r\n" } };
    f.workflow.receive(answer); expect(f.publisher.receiveSignal).not.toHaveBeenCalled();
    finish(f.publisher); await Promise.resolve(); expect(f.publisher.receiveSignal).toHaveBeenCalledExactlyOnceWith(answer);
  });
  it("bounds queued early signaling and does not deliver any of it after overflow", async () => {
    const f = fixture(); let finish!: (value: typeof f.publisher) => void;
    f.ports.start.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    await f.approve(); f.workflow.receive(approval()); f.workflow.receive(ready());
    const value = lease();
    for (let sequence = 1; sequence <= 33; sequence++) f.workflow.receive({ version: 1, type: "trusted-source-agent-signal",
      sourceLeaseId: value.sourceLeaseId, consentId: value.consent.consentId, assignmentId: value.assignmentId,
      fencingRevision: value.fencingRevision, negotiationRevision: 1, sequence,
      packagerId: value.consent.granteePackagerRef, packagerDeviceRef: value.consent.granteeDeviceRef, candidate: null });
    finish(f.publisher); await Promise.resolve();
    expect(f.publisher.stop).toHaveBeenCalledOnce(); expect(f.publisher.receiveSignal).not.toHaveBeenCalled();
    expect(f.view().error).toBe("trusted_source_control_invalid");
  });
  it("replays validated contiguous early renewals after asynchronous sender construction", async () => {
    const f = fixture(); let finish!: (value: typeof f.publisher) => void;
    f.ports.start.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    await f.approve(); f.workflow.receive(approval()); f.workflow.receive(ready());
    vi.setSystemTime(NOW + 1000); const next = { ...lease(), revision: 2, issuedAt: NOW + 1000, expiresAt: NOW + 5000 };
    f.workflow.receive(ready(next)); finish(f.publisher); await Promise.resolve();
    expect(f.publisher.renew).toHaveBeenCalledExactlyOnceWith(next);
    vi.setSystemTime(NOW + 4500); f.workflow.tick(); expect(f.publisher.stop).not.toHaveBeenCalled();
  });
  it("does not grant a sender after approval timeout or a signaling write failure", async () => {
    const f = fixture(); await f.approve(); vi.setSystemTime(NOW + 5001); f.workflow.tick();
    f.workflow.receive(approval()); expect(f.ports.start).not.toHaveBeenCalled();
    expect(f.view().publications[0].phase).toBe("failed");
    vi.setSystemTime(NOW); const g = fixture(); await g.prepare();
    g.ports.send.mockImplementation(() => { throw new Error("full"); });
    g.workflow.approve(request.requestId, own.publicationId, 60000, "user-action");
    g.workflow.receive(approval()); g.workflow.receive(ready()); expect(g.ports.start).not.toHaveBeenCalled();
  });
  it.each(["tenantId", "grantorSubjectRef", "granteePackagerRef", "programId", "roomId"])("rejects a changed %s approval", async field => {
    const f = fixture(); await f.approve();
    const message = approval(); (message.consent as any)[field] += "x"; f.workflow.receive(message); f.workflow.receive(ready());
    expect(f.ports.start).not.toHaveBeenCalled(); expect(f.view().error).toBe("trusted_source_control_invalid");
  });
  it("rejects unknown fields and duplicate publications rather than treating them as source choices", () => {
    expect(() => parseOwnSourcePublications({ ...sourceResponse(), extra: true }, context)).toThrow();
    expect(() => parseOwnSourcePublications({ ...sourceResponse(), publications: [own, own] }, context)).toThrow();
    expect(() => parseOwnSourcePublications({ ...sourceResponse(), roomEpoch: 12 }, context)).toThrow();
  });
  it("matches the stop contract including numeric reason codes and rejects nonpositive metadata", async () => {
    const f = fixture(); await f.approve(); f.workflow.receive(approval()); f.workflow.receive(ready()); await Promise.resolve();
    const l = lease(), message = { version: 1, type: "trusted-source-publisher-stop", sourceLeaseId: l.sourceLeaseId,
      leaseRevision: l.revision, consentId: l.consent.consentId, assignmentId: l.assignmentId,
      fencingRevision: l.fencingRevision, expiresAt: l.expiresAt, reasonCode: "CODEC_V2_FAILED" };
    for (const field of ["leaseRevision", "fencingRevision", "expiresAt"]) expect(() => parseSourceStop({ ...message, [field]: 0 })).toThrow();
    expect(() => parseSourceStop({ ...message, leaseRevision: 1025 })).toThrow();
    expect(() => parseSourceStop({ ...message, reasonCode: "_" })).toThrow();
    f.workflow.receive({ ...message, sourceLeaseId: "sls_bbbbbbbbbbbbbbbb" }); expect(f.publisher.stop).not.toHaveBeenCalled();
    f.workflow.receive(message); expect(f.publisher.stop).toHaveBeenCalledOnce();
    expect(f.view().publications[0].phase).toBe("stopped"); expect(f.track().stop).not.toHaveBeenCalled();
  });
});
