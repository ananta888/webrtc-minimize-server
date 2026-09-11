import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TrustedSourceWorkflow, type SourceWorkflowView } from "./trusted-source-workflow";
import type { SourcePublisherContext, OwnSourcePublication } from "./trusted-source-actions";
import type { SourceInvitation } from "./source-invitation-contract";
import type { TrustedSourceLease } from "./trusted-source-contract";

const NOW = 1800000000000;
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

function fixture() {
  const context: SourcePublisherContext = { roomId: "room-alpha", peerId: "0123456789abcdef", roomEpoch: 11,
    fingerprint: "a".repeat(43), identity: "fixture" };
  const rows = (["camera", "microphone", "screen"] as const).map((source, index) => {
    const id = ["a", "b", "c"][index];
    const own: OwnSourcePublication = { publicationId: `track-${source}`, source, publicationEpoch: 7 };
    const request: SourceInvitation = { requestId: "bsr_" + id.repeat(24), roomId: context.roomId, programId: "prg_aaaaaaaaaaaaaaaa",
      programEpoch: 7, programRevision: 1, ownerPeerId: "fedcba9876543210", targetPeerId: context.peerId,
      packagerRef: "pkr_dddddddddddddddd", sourceKind: source, state: "pending", authority: "none", createdAt: NOW, expiresAt: NOW + 120000 };
    const lease: TrustedSourceLease = { version: 1, type: "trusted-source-lease", sourceLeaseId: "sls_" + id.repeat(16), revision: 1,
      assignmentId: "asn_aaaaaaaaaaaaaaaa", writerLeaseId: "lea_aaaaaaaaaaaaaaaa", fencingRevision: 3,
      publisherPeerId: context.peerId, publisherDeviceRef: "dev_pppppppppppppppp", publicationId: own.publicationId, publicationEpoch: 7,
      codec: source === "microphone" ? "audio/opus" : "video/vp8", frameEnvelope: "codec-prefix-v1", issuedAt: NOW, expiresAt: NOW + 4000,
      consent: { version: 1, type: "trusted-decrypt-consent", trigger: "user-action", consentId: "cns_" + id.repeat(16), tenantId: "tn_aaaaaaaaaaaaaaaa",
        roomId: context.roomId, roomEpoch: 11, programId: request.programId, programEpoch: 7, grantorSubjectRef: "sub_cccccccccccccccc",
        granteePackagerRef: request.packagerRef, granteeDeviceRef: "dev_eeeeeeeeeeeeeeee", sourceId: "src_" + id.repeat(16), sourceKind: source,
        purpose: "broadcast-program", status: "active", grantedAt: NOW, expiresAt: NOW + 60000 } };
    return { own, request, lease, track: { id: own.publicationId, kind: source === "microphone" ? "audio" : "video", readyState: "live", stop: vi.fn() },
      publisher: { stop: vi.fn(), renew: vi.fn(), receiveSignal: vi.fn(async () => {}) } };
  });
  let view!: SourceWorkflowView;
  const send = vi.fn(), start = vi.fn(async (lease: TrustedSourceLease, _track: MediaStreamTrack, _signal: AbortSignal,
    _authorized: unknown, state: (value: "sending") => void) => {
    state("sending"); return rows.find(row => row.lease.sourceLeaseId === lease.sourceLeaseId)!.publisher;
  });
  const workflow = new TrustedSourceWorkflow({ context: () => context,
    references: async () => ({ tenantId: rows[0].lease.consent.tenantId, subjectRef: rows[0].lease.consent.grantorSubjectRef, deviceRef: rows[0].lease.publisherDeviceRef }),
    track: own => rows.find(row => row.own.publicationId === own.publicationId)?.track as unknown as MediaStreamTrack,
    send, start, changed: value => { view = value; } });
  const response = { version: 1, type: "trusted-source-publications", roomId: context.roomId,
    peerId: context.peerId, roomEpoch: 11, publicationRevision: 1, publications: rows.map(row => row.own) };
  const prepare = async (index: number) => { await workflow.prepare(rows[index].request); workflow.receive(response); };
  const approve = async (index: number) => {
    const row = rows[index]; await prepare(index);
    workflow.approve(row.request.requestId, row.own.publicationId, 60000, "user-action");
    workflow.receive({ version: 1, type: "trusted-source-approved", requestId: row.request.requestId, consent: row.lease.consent });
    workflow.receive({ version: 1, type: "trusted-source-publisher-lease", lease: row.lease });
    await Promise.resolve();
  };
  const receiveLease = (value: object) => workflow.receive({ version: 1, type: "trusted-source-publisher-lease", lease: value });
  return { workflow, rows, approve, prepare, receiveLease, response, send, start, view: () => view };
}

it("late expired lease of one source cannot stop an independently renewed source or clear a fresh selection", async () => {
  const f = fixture(); await f.approve(0); await f.approve(1);
  vi.setSystemTime(NOW + 3000);
  const renewed = { ...f.rows[1].lease, revision: 2, issuedAt: NOW + 3000, expiresAt: NOW + 7000 };
  f.receiveLease(renewed);
  vi.setSystemTime(NOW + 4500); f.workflow.tick();
  expect(f.rows[0].publisher.stop).toHaveBeenCalledOnce();
  expect(f.rows[1].publisher.stop).not.toHaveBeenCalled();
  await f.prepare(2);
  f.receiveLease(f.rows[0].lease);
  expect(f.rows[1].publisher.stop).not.toHaveBeenCalled();
  expect(f.view().selection?.requestId).toBe(f.rows[2].request.requestId);
  expect(f.view().publications[1].phase).toBe("sending");
  expect(f.rows[1].publisher.renew).toHaveBeenCalledExactlyOnceWith(renewed);
  expect(f.start).toHaveBeenCalledTimes(2);
  expect(f.rows.every(row => row.track.stop.mock.calls.length === 0)).toBe(true);
});

it("malformed renewal fails its own live source without changing another current source", async () => {
  const f = fixture(); await f.approve(0); await f.approve(1);
  f.receiveLease({ ...f.rows[0].lease, extra: true });
  expect(f.rows[0].publisher.stop).toHaveBeenCalledOnce();
  expect(f.rows[1].publisher.stop).not.toHaveBeenCalled();
  expect(f.view().error).toBe("trusted_source_control_invalid");
  expect(f.rows[1].publisher.renew).not.toHaveBeenCalled();
});

it("invalid source-choice metadata closes only the editor, never existing approved publishers", async () => {
  const f = fixture(); await f.approve(0); await f.approve(1);
  await f.workflow.prepare(f.rows[2].request);
  f.workflow.receive({ ...f.response, extra: true });
  expect(f.view().selection).toBeNull(); expect(f.view().error).toBe("trusted_source_control_invalid");
  expect(f.rows[0].publisher.stop).not.toHaveBeenCalled();
  expect(f.rows[1].publisher.stop).not.toHaveBeenCalled();
  expect(f.start).toHaveBeenCalledTimes(2);
});

it.each(["approval", "signal", "stop", "revoked"])("rejects malformed %s only within its known source bindings", async kind => {
  const f = fixture(); await f.approve(0); await f.approve(1);
  const a = f.rows[0];
  const scope = { sourceLeaseId: a.lease.sourceLeaseId, consentId: a.lease.consent.consentId,
    assignmentId: a.lease.assignmentId, fencingRevision: a.lease.fencingRevision };
  const message = kind === "approval" ? { type: "trusted-source-approved", requestId: a.request.requestId, consent: a.lease.consent }
    : kind === "signal" ? { type: "trusted-source-agent-signal", ...scope, negotiationRevision: 1, sequence: 1,
      packagerId: a.lease.consent.granteePackagerRef, packagerDeviceRef: a.lease.consent.granteeDeviceRef, candidate: null }
    : kind === "stop" ? { type: "trusted-source-publisher-stop", ...scope, leaseRevision: 1, expiresAt: a.lease.expiresAt, reasonCode: "SOURCE_AUTHORITY_LOST" }
    : { type: "trusted-source-revoked", consentId: a.lease.consent.consentId };
  f.workflow.receive({ version: 1, ...message, extra: true });
  expect(a.publisher.stop).toHaveBeenCalledOnce();
  expect(f.rows[1].publisher.stop).not.toHaveBeenCalled();
  expect(a.publisher.receiveSignal).not.toHaveBeenCalled();
  expect(f.rows[1].publisher.renew).not.toHaveBeenCalled();
  expect(f.start).toHaveBeenCalledTimes(2);
});

it("rejects an expired late approval without reviving its source or revoking a later valid consent", async () => {
  const f = fixture();
  f.rows[0].lease = { ...f.rows[0].lease, expiresAt: NOW + 1500,
    consent: { ...f.rows[0].lease.consent, expiresAt: NOW + 2000 } };
  await f.approve(0); await f.approve(1);
  vi.setSystemTime(NOW + 2500); f.workflow.tick();
  f.workflow.receive({ version: 1, type: "trusted-source-approved", requestId: f.rows[0].request.requestId, consent: f.rows[0].lease.consent });
  expect(f.rows[0].publisher.stop).toHaveBeenCalledOnce();
  expect(f.rows[1].publisher.stop).not.toHaveBeenCalled();
  expect(f.view().publications[1].phase).toBe("sending");
  expect(f.start).toHaveBeenCalledTimes(2);
});

it("routing an initial expired lease to a pending approval cannot authorize or start it", async () => {
  const f = fixture(); await f.approve(1); await f.prepare(0);
  const a = f.rows[0];
  f.workflow.approve(a.request.requestId, a.own.publicationId, 60000, "user-action");
  f.workflow.receive({ version: 1, type: "trusted-source-approved", requestId: a.request.requestId, consent: a.lease.consent });
  vi.setSystemTime(NOW + 2000);
  f.receiveLease({ ...a.lease, expiresAt: NOW + 1500 });
  expect(f.rows[1].publisher.stop).not.toHaveBeenCalled();
  expect(f.start).toHaveBeenCalledOnce(); expect(a.publisher.renew).not.toHaveBeenCalled();
  expect(f.view().publications.find(row => row.requestId === a.request.requestId)?.phase).toBe("failed");
  expect(f.send).toHaveBeenLastCalledWith({ version: 1, type: "trusted-source-revoke", consentId: a.lease.consent.consentId });
});

it.each(["unknown-type", "changed-binding", "malformed-consent"])("keeps conservative global failure for ambiguous %s", async kind => {
  const f = fixture(); await f.approve(0); await f.approve(1);
  if (kind === "unknown-type") f.workflow.receive({ version: 1, type: "trusted-source-unknown" });
  if (kind === "changed-binding") f.receiveLease({ ...f.rows[0].lease, publisherDeviceRef: "dev_zzzzzzzzzzzzzzzz", extra: true });
  if (kind === "malformed-consent") f.receiveLease({ ...f.rows[0].lease, consent: null });
  expect(f.rows[0].publisher.stop).toHaveBeenCalledOnce(); expect(f.rows[1].publisher.stop).toHaveBeenCalledOnce();
  expect(f.start).toHaveBeenCalledTimes(2);
  expect(f.rows.every(row => row.track.stop.mock.calls.length === 0)).toBe(true);
});
