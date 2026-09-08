import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TrustedDecryptKeyLifecycle } from "./trusted-decrypt-key-lifecycle";
import * as keyLifecycle from "./trusted-decrypt-key-lifecycle";
import { parseTrustedSourceChannel, parseTrustedSourceLease, parseTrustedSourceSignal, TrustedSourceLease, TrustedSourceSignal } from "./trusted-source-contract";
import { TrustedSourcePublisher, TRUSTED_SOURCE_KEY_CHANNEL } from "./trusted-source-publisher";

const NOW = 1_800_000_000_000;
function fixture(): TrustedSourceLease {
  return { version: 1, type: "trusted-source-lease", sourceLeaseId: "sls_aaaaaaaaaaaaaaaa", revision: 1,
    assignmentId: "asn_aaaaaaaaaaaaaaaa", writerLeaseId: "lea_aaaaaaaaaaaaaaaa", fencingRevision: 3,
    publisherPeerId: "0123456789abcdef", publisherDeviceRef: "dev_pppppppppppppppp", publicationId: "track-camera", publicationEpoch: 7,
    codec: "video/vp8", frameEnvelope: "codec-prefix-v1", issuedAt: NOW, expiresAt: NOW+4000,
    consent: { version: 1, type: "trusted-decrypt-consent", trigger: "user-action", consentId: "cns_aaaaaaaaaaaaaaaa", tenantId: "tn_aaaaaaaaaaaaaaaa",
      roomId: "room-alpha", roomEpoch: 11, programId: "prg_aaaaaaaaaaaaaaaa", programEpoch: 7, grantorSubjectRef: "sub_cccccccccccccccc",
      granteePackagerRef: "pkr_dddddddddddddddd", granteeDeviceRef: "dev_eeeeeeeeeeeeeeee", sourceId: "src_aaaaaaaaaaaaaaaa", sourceKind: "camera",
      purpose: "broadcast-program", status: "active", grantedAt: NOW, expiresAt: NOW+120000 } };
}
class Track extends EventTarget {
  id = "track-camera"; kind = "video"; readyState = "live"; stop = vi.fn();
}
class Channel {
  readyState = "open"; bufferedAmount = 0;
  onmessage: ((event: {data: unknown}) => void) | null = null; onclose: (() => void) | null = null; onerror: (() => void) | null = null;
  send = vi.fn(); close = vi.fn(() => { this.readyState = "closed"; });
  emit(value: unknown) { this.onmessage?.({data: typeof value === "string" ? value : JSON.stringify(value)}); }
}
class Peer {
  connectionState = "new";
  onicecandidate: ((event: {candidate: null | {toJSON(): RTCIceCandidateInit}}) => void) | null = null;
  onconnectionstatechange = null; ondatachannel = null; ontrack = null;
  channel = new Channel();
  parameters = { encodings: [{ active: false }] };
  sender = { getParameters: vi.fn(() => structuredClone(this.parameters)), setParameters: vi.fn(async (value) => { this.parameters = value; }) };
  preferences = vi.fn();
  addTransceiver = vi.fn(() => ({ sender: this.sender, setCodecPreferences: this.preferences }));
  createDataChannel = vi.fn(() => this.channel);
  createOffer = vi.fn(async () => ({ type: "offer" as const, sdp: "v=0\r\n" }));
  setLocalDescription = vi.fn(async () => {
    this.onicecandidate?.({ candidate: { toJSON: () => ({ candidate: "candidate:synthetic" }) } });
    this.onicecandidate?.({ candidate: null });
  });
  setRemoteDescription = vi.fn(async () => undefined);
  addIceCandidate = vi.fn(async () => undefined);
  close = vi.fn(() => { this.connectionState = "closed"; });
}
function encryption() {
  return { supported: true, attachSender: vi.fn(() => true), setSenderKey: vi.fn((_context: string, _kid: string, _key: Uint8Array) => true), destroy: vi.fn() };
}
const cleanup: (() => void)[] = [];
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(NOW);
  vi.stubGlobal("MediaStream", class {});
  vi.stubGlobal("RTCRtpSender", { getCapabilities: () => ({ codecs: [{ mimeType: "video/VP8" }, { mimeType: "audio/opus" }] }) });
});
afterEach(() => { cleanup.splice(0).forEach(close => close()); vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllGlobals(); });
async function setup(options: {lease?: TrustedSourceLease; supported?: boolean} = {}) {
  let allowed = true;
  const lease = options.lease || fixture(), peer = new Peer(), track = new Track(), crypt = encryption(), messages: TrustedSourceSignal[] = [], states: string[] = [];
  crypt.supported = options.supported ?? true;
  const controller = new AbortController();
  const sender = await TrustedSourcePublisher.start(lease, track as unknown as MediaStreamTrack, {}, {
    signal: controller.signal,
    authorized: () => allowed, sendSignal: message => messages.push(message), onState: state => states.push(state),
    createPeerConnection: () => peer as unknown as RTCPeerConnection, createEncryption: () => crypt,
  });
  cleanup.push(() => sender.stop());
  const incoming = (extra: object = {}) => ({ version: 1, type: "trusted-source-agent-signal", sourceLeaseId: lease.sourceLeaseId,
    consentId: lease.consent.consentId, assignmentId: lease.assignmentId, fencingRevision: lease.fencingRevision, negotiationRevision: 1,
    sequence: 1, packagerId: lease.consent.granteePackagerRef, packagerDeviceRef: lease.consent.granteeDeviceRef,
    description: {type: "answer", sdp: "v=0\r\n"}, ...extra });
  await sender.receiveSignal(incoming());
  const native = new TrustedDecryptKeyLifecycle(() => {});
  cleanup.push(() => native.destroy());
  const announcement = await native.authorize(lease.consent, Date.now());
  async function envelope() {
    peer.channel.emit(announcement);
    await vi.waitFor(() => expect(peer.channel.send).toHaveBeenCalled(), { interval: 1, timeout: 200 });
    return JSON.parse(peer.channel.send.mock.calls.at(-1)![0]);
  }
  const ack = (value: Record<string, unknown>, extra: object = {}) => ({ version: 1, type: "trusted-source-key-ack", sourceLeaseId: lease.sourceLeaseId,
    leaseRevision: lease.revision, consentId: lease.consent.consentId, agreementKeyId: value["agreementKeyId"], envelopeId: value["envelopeId"],
    keyId: value["keyId"], state: "key-installed", expiresAt: Math.min(lease.expiresAt, Number(value["expiresAt"])), ...extra });
  return { sender, lease, peer, track, crypt, messages, states, incoming, envelope, ack, native, announcement, controller, deny: () => { allowed = false; } };
}

describe("TrustedSourcePublisher", () => {
  it("orders SDP before ICE and activates only after a bound ACK with the genuinely wrapped key", async () => {
    const f = await setup();
    expect(f.peer.addTransceiver.mock.calls[0][1]).toMatchObject({ sendEncodings: [{active: false}] });
    expect(f.peer.createDataChannel).toHaveBeenCalledWith(TRUSTED_SOURCE_KEY_CHANNEL, {ordered: true, protocol: TRUSTED_SOURCE_KEY_CHANNEL});
    expect(f.messages.map(m => m.sequence)).toEqual([1,2,3]);
    expect(f.messages[0].description?.type).toBe("offer");
    expect(f.peer.preferences).toHaveBeenCalledWith([{mimeType: "video/VP8"}]);
    const value = await f.envelope();
    expect(f.crypt.setSenderKey).not.toHaveBeenCalled();
    expect(f.peer.sender.setParameters).not.toHaveBeenCalled();
    let nativeKey: Uint8Array | null = null;
    await f.native.install(value, f.lease.consent, "fixture", (_context, _kid, key) => { nativeKey = Uint8Array.from(key); return true; }, Date.now());
    const copies: Uint8Array[] = [], borrowed: Uint8Array[] = [];
    f.crypt.setSenderKey.mockImplementation((_context, _kid, key) => { copies.push(Uint8Array.from(key)); borrowed.push(key); return true; });
    f.peer.channel.emit(f.ack(value));
    await vi.waitFor(() => expect(f.states).toContain("sending"), { interval: 1, timeout: 200 });
    expect(copies[0]).toEqual(nativeKey);
    expect(borrowed[0]).toEqual(new Uint8Array(16));
    expect(f.peer.parameters.encodings[0].active).toBe(true);
    expect(JSON.stringify(f.messages)).not.toContain("ciphertext");
    expect(JSON.stringify(f.messages)).not.toContain(value.keyId);
    f.sender.stop(); f.sender.stop();
    expect(f.peer.close).toHaveBeenCalledTimes(1);
    expect(f.crypt.destroy).toHaveBeenCalledTimes(1);
    expect(f.track.stop).not.toHaveBeenCalled();
    f.native.destroy();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["keyId", "envelopeId", "agreementKeyId", "consentId", "sourceLeaseId", "leaseRevision", "expiresAt", "extra"])("rejects wrong ACK %s without activating", async field => {
    const f = await setup(), value = await f.envelope();
    f.peer.channel.emit(f.ack(value, {[field]: field === "leaseRevision" ? 2 : field === "expiresAt" ? NOW : "wrong"}));
    await vi.waitFor(() => expect(f.states).toContain("failed"), { interval: 1, timeout: 200 });
    expect(f.peer.sender.setParameters).not.toHaveBeenCalled();
    expect(f.crypt.setSenderKey).not.toHaveBeenCalled();
    expect(f.track.stop).not.toHaveBeenCalled();
  });

  it("rejects key replay, binary and duplicate-field messages before cryptographic work", async () => {
    for (const raw of [new ArrayBuffer(8), '{"version":1,"version":1}', "x".repeat(8193)]) {
      const f = await setup();
      f.peer.channel.onmessage?.({data: raw});
      expect(f.states.at(-1)).toBe("failed");
      expect(f.peer.channel.send).not.toHaveBeenCalled();
    }
    const f = await setup(), value = await f.envelope();
    f.peer.channel.emit(f.ack(value));
    await vi.waitFor(() => expect(f.states).toContain("sending"), { interval: 1, timeout: 200 });
    f.peer.channel.emit(f.ack(value));
    await vi.waitFor(() => expect(f.states.at(-1)).toBe("failed"), { interval: 1, timeout: 200 });
  });

  it("renews only the same live source, preserves receiver ACK proof and never resurrects on renewal", async () => {
    const f = await setup(), value = await f.envelope();
    f.peer.channel.emit(f.ack(value));
    await vi.waitFor(() => expect(f.states).toContain("sending"), { interval: 1, timeout: 200 });
    await vi.advanceTimersByTimeAsync(1000);
    const next = {...f.lease, revision: 2, issuedAt: Date.now(), expiresAt: Date.now()+5000};
    f.sender.renew(next);
    await vi.advanceTimersByTimeAsync(3000);
    expect(f.peer.close).not.toHaveBeenCalled();
    expect(f.crypt.setSenderKey).toHaveBeenCalledTimes(1);
    f.sender.renew(next); // replay does not extend its timer.
    await vi.advanceTimersByTimeAsync(2001);
    expect(f.peer.close).toHaveBeenCalledTimes(1);
    f.sender.renew({...next, revision: 3, issuedAt: Date.now(), expiresAt: Date.now()+5000});
    expect(f.states.at(-1)).toBe("failed");
  });

  it("enforces ACK timeout independently of renewed leases and does not expose a stale asynchronous key", async () => {
    const f = await setup();
    await f.envelope();
    await vi.advanceTimersByTimeAsync(1000);
    f.sender.renew({...f.lease, revision: 2, issuedAt: Date.now(), expiresAt: Date.now()+5000});
    await vi.advanceTimersByTimeAsync(2100);
    expect(f.states.at(-1)).toBe("failed");
    expect(f.crypt.setSenderKey).not.toHaveBeenCalled();
  });

  it("erases a key immediately when stopped during asynchronous wrapping", async () => {
    const f = await setup(), original = keyLifecycle.sealTrustedDecryptKey;
    let release!: () => void, borrowed: Uint8Array | null = null;
    const gate = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(keyLifecycle, "sealTrustedDecryptKey").mockImplementation(async input => {
      borrowed = input.baseKey; await gate; return original(input);
    });
    f.peer.channel.emit(f.announcement);
    await vi.waitFor(() => expect(borrowed).not.toBeNull(), {interval: 1, timeout: 200});
    f.sender.stop();
    expect(borrowed).toEqual(new Uint8Array(16));
    release();
    await vi.advanceTimersByTimeAsync(20);
    expect(f.peer.channel.send).not.toHaveBeenCalled();
    expect(f.crypt.setSenderKey).not.toHaveBeenCalled();
  });

  it("keeps an activation deadline while sender parameters are pending", async () => {
    const f = await setup(), value = await f.envelope();
    let release!: () => void;
    f.peer.sender.setParameters.mockImplementation(() => new Promise<void>(resolve => { release = resolve; }));
    f.peer.channel.emit(f.ack(value));
    await vi.waitFor(() => expect(f.peer.sender.setParameters).toHaveBeenCalled(), {interval: 1, timeout: 200});
    await vi.advanceTimersByTimeAsync(1000);
    f.sender.renew({...f.lease, revision: 2, issuedAt: Date.now(), expiresAt: Date.now()+5000});
    await vi.advanceTimersByTimeAsync(2100);
    expect(f.states.at(-1)).toBe("failed");
    release(); await vi.advanceTimersByTimeAsync(1);
    expect(f.states).not.toContain("sending");
  });

  it("rotates a separate fresh source key only after its new ACK while leases renew", async () => {
    const f = await setup(), first = await f.envelope();
    f.peer.channel.emit(f.ack(first));
    await vi.waitFor(() => expect(f.states).toContain("sending"), {interval: 1, timeout: 200});
    let current = f.lease;
    for (let n=0; n<45; n++) {
      await vi.advanceTimersByTimeAsync(1000);
      current = {...current, revision: current.revision+1, issuedAt: Date.now(), expiresAt: Date.now()+5000};
      f.sender.renew(current);
    }
    await vi.waitFor(() => expect(f.peer.channel.send).toHaveBeenCalledTimes(2), {interval: 1, timeout: 200});
    const second = JSON.parse(f.peer.channel.send.mock.calls[1][0]);
    expect(second.keyId).not.toBe(first.keyId);
    expect(f.crypt.setSenderKey).toHaveBeenCalledTimes(1);
    f.peer.channel.emit(f.ack(second, {leaseRevision: current.revision, expiresAt: current.expiresAt}));
    await vi.waitFor(() => expect(f.crypt.setSenderKey).toHaveBeenCalledTimes(2), {interval: 1, timeout: 200});
    expect(f.peer.close).not.toHaveBeenCalled();
  });

  it.each(["scope", "revision", "policy", "track", "signal", "backlog"])("closes deterministically on %s loss", async mode => {
    const f = await setup();
    if (mode === "scope") f.sender.renew({...f.lease, assignmentId: "asn_bbbbbbbbbbbbbbbb"});
    if (mode === "revision") f.sender.renew({...f.lease, revision: 4});
    if (mode === "policy") { f.deny(); f.sender.renew(f.lease); }
    if (mode === "track") f.track.dispatchEvent(new Event("ended"));
    if (mode === "signal") await f.sender.receiveSignal(f.incoming()); // replay
    if (mode === "backlog") { f.peer.channel.bufferedAmount = 16385; await f.envelope().catch(() => {}); }
    expect(f.peer.close).toHaveBeenCalledTimes(1);
    expect(f.track.stop).not.toHaveBeenCalled();
  });

  it("requires E2EE, real local permission and the exact borrowed publication before networking", async () => {
    const lease = fixture(), track = new Track(), factory = vi.fn();
    const signal = new AbortController().signal;
    await expect(TrustedSourcePublisher.start(lease, track as unknown as MediaStreamTrack, {}, {signal, authorized: () => false, sendSignal: () => {}, createPeerConnection: factory})).rejects.toThrow();
    track.id = "other";
    await expect(TrustedSourcePublisher.start(lease, track as unknown as MediaStreamTrack, {}, {signal, authorized: () => true, sendSignal: () => {}, createPeerConnection: factory})).rejects.toThrow();
    expect(factory).not.toHaveBeenCalled();
    await expect(setup({supported: false})).rejects.toThrow();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("aborts immediately without another key, signal or lease tick and preserves room capture", async () => {
    const f = await setup();
    f.controller.abort();
    expect(f.peer.close).toHaveBeenCalledTimes(1);
    expect(f.crypt.destroy).toHaveBeenCalledTimes(1);
    expect(f.states.at(-1)).toBe("stopped");
    expect(f.track.stop).not.toHaveBeenCalled();
  });
});

describe("Trusted source contracts", () => {
  it("rejects missing/unknown lease fields, codec mismatch, changed scope and overlong TTL", () => {
    const raw = fixture();
    expect(parseTrustedSourceLease(raw, NOW)).toEqual(raw);
    for (const key of Object.keys(raw)) {
      const bad = {...raw} as Record<string, unknown>; delete bad[key];
      expect(() => parseTrustedSourceLease(bad, NOW)).toThrow();
    }
    for (const patch of [{extra: 1}, {codec: "video/h264"}, {expiresAt: NOW+5001}, {publicationEpoch: 0}, {frameEnvelope: "other"}]) {
      expect(() => parseTrustedSourceLease({...raw, ...patch}, NOW)).toThrow();
    }
    expect(() => parseTrustedSourceChannel('{"x":{"a":1,"\\u0061":2}}')).toThrow();
    expect(parseTrustedSourceChannel('{"x":"a:b{", "y":[{"a":1},{"a":2}]}')).toEqual({x:"a:b{",y:[{a:1},{a:2}]});
  });
  it("rejects wrong target, unknown fields, candidate and negotiation limits", () => {
    const l = fixture();
    const raw = { version: 1, type: "trusted-source-agent-signal", sourceLeaseId:l.sourceLeaseId, consentId:l.consent.consentId,
      assignmentId:l.assignmentId, fencingRevision:l.fencingRevision, negotiationRevision:1, sequence:1,
      packagerId:l.consent.granteePackagerRef, packagerDeviceRef:l.consent.granteeDeviceRef, description:{type:"answer",sdp:"v=0\r\n"} };
    expect(parseTrustedSourceSignal(raw,l)).toEqual(raw);
    for (const patch of [{extra:1},{packagerDeviceRef:"dev_zzzzzzzzzzzzzzzz"},{sequence:130},{negotiationRevision:17},
      {description:{type:"offer",sdp:"v=0\r\n"}},{description:{type:"answer",sdp:"x".repeat(16385)}},{candidate:null}]) {
      expect(() => parseTrustedSourceSignal({...raw,...patch},l)).toThrow();
    }
    const {description: _, ...candidate} = raw;
    expect(parseTrustedSourceSignal({...candidate,candidate:null},l).candidate).toBeNull();
    for (const c of [{candidate:"x".repeat(4097)},{candidate:"",sdpMLineIndex:16},{candidate:"",usernameFragment:"x".repeat(65)}]) {
      expect(() => parseTrustedSourceSignal({...candidate,candidate:c},l)).toThrow();
    }
  });
});
