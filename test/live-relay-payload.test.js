import assert from "node:assert/strict";
import test from "node:test";
import { liveRelayPayload } from "../scripts/live-relay-payload.mjs";

class Target {
  listeners = new Map();
  addEventListener(name, callback) { const values = this.listeners.get(name) || new Set(); values.add(callback); this.listeners.set(name, values); }
  removeEventListener(name, callback) { this.listeners.get(name)?.delete(callback); }
  emit(name, value = {}) { for (const callback of this.listeners.get(name) || []) callback(value); }
}

function fixture(patch = {}) {
  const peers = [], channels = [], state = { localDescriptions: 0 };
  class Channel extends Target {
    label = "turn-gate";
    closes = 0;
    constructor() { super(); channels.push(this); }
    send(value) {
      if (patch.sendThrows) throw new Error("private-transport-error");
      const bytes = value instanceof Uint8Array ? value.slice().buffer : value.slice(0);
      if (patch.badEcho && this === channels[1]) new Uint8Array(bytes)[0] ^= 255;
      if (!patch.dropEcho) queueMicrotask(() => this.other.emit("message", { data: bytes }));
    }
    close() { this.closes++; }
  }
  class Peer extends Target {
    connectionState = "connected";
    iceConnectionState = "completed";
    iceGatheringState = "new";
    sctp = { state: "connected", transport: { state: "connected" } };
    closes = 0;
    constructor(config) { super(); this.config = config; peers.push(this); }
    createDataChannel() { return new Channel(); }
    async createOffer() {
      if (patch.stuckOffer) return new Promise(resolve => { state.resolveOffer = () => resolve({ type: "offer", sdp: "private-offer" }); });
      return { type: "offer", sdp: "private-offer" };
    }
    async createAnswer() { return { type: "answer", sdp: "private-answer" }; }
    async setLocalDescription(value) {
      state.localDescriptions++;
      this.localDescription = value;
      if (patch.stuckGathering) return;
      this.iceGatheringState = "complete";
      this.emit("icecandidate", { candidate: { type: "relay" } });
      this.emit("icegatheringstatechange");
    }
    async setRemoteDescription(value) {
      if (patch.stuckDescription) return new Promise(() => {});
      if (value.type !== "answer") return;
      const receiver = new Channel(); receiver.other = channels[0]; channels[0].other = receiver;
      peers[1].emit("datachannel", { channel: receiver });
      queueMicrotask(() => channels[0].emit("open"));
    }
    getConfiguration() { return { ...this.config, ...patch.config }; }
    async getStats() {
      if (patch.stuckStats) return new Promise(() => {});
      const values = [
        { id: "transport", type: "transport", dtlsState: "connected", selectedCandidatePairId: "pair", ...patch.transport },
        { id: "pair", type: "candidate-pair", state: "succeeded", bytesSent: 100, bytesReceived: 100,
          localCandidateId: "local", remoteCandidateId: "remote", ...patch.pair },
        { id: "local", type: "local-candidate", candidateType: "relay", ...patch.local },
        { id: "remote", type: "remote-candidate", candidateType: "relay", ...patch.remote },
      ];
      return new Map(values.map(value => [value.id, value]));
    }
    close() { this.closes++; if (patch.closeThrows) throw new Error("private-cleanup-detail"); }
  }
  return { peers, channels, state, options: { timeoutMs: 20, makeNonce: () => Uint8Array.from({ length: 32 }, (_, index) => index),
    makePeer: config => {
      if (patch.failSecond && peers.length === 1) throw new Error("private-constructor-error");
      const peer = new Peer(config); Object.assign(peer, patch.peer); return peer;
    } } };
}

function closed(f) {
  assert.ok(f.peers.every(peer => peer.closes === 1));
  assert.ok(f.channels.every(channel => channel.closes === 1));
  for (const target of [...f.peers, ...f.channels]) {
    assert.ok([...target.listeners.values()].every(values => values.size === 0));
  }
}

test("relay probe requires exact echo and selected bidirectional relay transports", async () => {
  for (const state of ["succeeded", "in-progress"]) {
    const f = fixture({ pair: { state } });
    const result = await liveRelayPayload([{}], f.options);
    assert.deepEqual(result, { candidateCount: 2, relayCount: 2, selectedRelayPairs: 2, payloadBytesEachDirection: 32 });
    assert.ok(f.peers.every(peer => peer.config.iceTransportPolicy === "relay"));
    assert.equal(JSON.stringify(result).includes("private"), false);
    closed(f);
  }
});

for (const [label, patch] of [
  ["host local candidate", { local: { candidateType: "host" } }],
  ["host remote candidate", { remote: { candidateType: "host" } }],
  ["nomination without selection", { transport: { selectedCandidatePairId: undefined }, pair: { nominated: true } }],
  ["wrong selection", { transport: { selectedCandidatePairId: "other" } }],
  ["failed pair", { pair: { state: "failed" } }],
  ["no bidirectional counters", { pair: { bytesReceived: 0 } }],
  ["unconnected DTLS", { transport: { dtlsState: "connecting" } }],
  ["unconnected SCTP", { peer: { sctp: { state: "connecting" } } }],
  ["nonrelay policy", { config: { iceTransportPolicy: "all" } }],
  ["wrong echo", { badEcho: true }],
  ["missing echo", { dropEcho: true }],
  ["send failure", { sendThrows: true }],
  ["stuck gathering", { stuckGathering: true }],
  ["stuck offer", { stuckOffer: true }],
  ["stuck SDP", { stuckDescription: true }],
  ["stuck stats", { stuckStats: true }],
  ["partial constructor failure", { failSecond: true }],
]) test(`relay probe rejects ${label} and closes owned resources`, { timeout: 2000 }, async () => {
  const f = fixture(patch);
  await assert.rejects(liveRelayPayload([{}], f.options), { message: "live_relay_payload_failed" });
  closed(f);
});

test("late offer cannot start description work after the probe has closed", async () => {
  const f = fixture({ stuckOffer: true });
  await assert.rejects(liveRelayPayload([{}], f.options), { message: "live_relay_payload_failed" });
  f.state.resolveOffer();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.state.localDescriptions, 0);
  closed(f);
});

test("cleanup failure cannot return passed and still attempts both peer closures", async () => {
  const f = fixture({ closeThrows: true });
  await assert.rejects(liveRelayPayload([{}], f.options), { message: "live_relay_cleanup_failed" });
  closed(f);
});

test("invalid probe configuration allocates no peers", async () => {
  for (const timeoutMs of [0, -1, 25001, "10", NaN]) {
    await assert.rejects(liveRelayPayload([{}], { timeoutMs, makePeer: () => assert.fail("no peer") }),
      { message: "live_relay_payload_invalid" });
  }
  for (const servers of [null, [], Array(17).fill({})]) {
    await assert.rejects(liveRelayPayload(servers, { makePeer: () => assert.fail("no peer") }),
      { message: "live_relay_payload_invalid" });
  }
});
