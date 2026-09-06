export class MachineReceivePolicyError extends Error {
  constructor(code) { super(code); this.code = code; }
}
const fail = code => { throw new MachineReceivePolicyError(code); };
const fields = ["type", "trigger", "machinePeerId", "expectedRevision", "publicationIds", "chatRead", "expiresAt"];

export function parseMachineReceiveConsent(input) {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length !== fields.length
    || Object.keys(input).some(key => !fields.includes(key)) || input.type !== "machine-receive-consent"
    || input.trigger !== "user-action" || !/^[a-f0-9]{16}$/.test(input.machinePeerId || "")
    || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0
    || !Array.isArray(input.publicationIds) || input.publicationIds.length > 2
    || new Set(input.publicationIds).size !== input.publicationIds.length
    || input.publicationIds.some(id => typeof id !== "string" || !/^[A-Za-z0-9_={}:-]{1,128}$/.test(id))
    || typeof input.chatRead !== "boolean" || !Number.isSafeInteger(input.expiresAt)) fail("machine_receive_consent_invalid");
  return Object.freeze({ ...input, publicationIds: Object.freeze([...input.publicationIds]) });
}

/** Control-plane-only metadata. A publisher may release ONLY its own currently
 * published audio or own chat; a room creator cannot impersonate other sources. */
export class MachineReceivePolicy {
  #members; #clock; #rooms = new Map(); #changed;
  constructor({ members, changed = () => {}, clock = Date.now }) {
    if (typeof members !== "function" || typeof changed !== "function" || typeof clock !== "function") fail("machine_receive_config_invalid");
    this.#members = members; this.#clock = clock; this.#changed = changed;
  }
  #record(roomId) {
    let record = this.#rooms.get(roomId);
    if (!record) { record = { revision: 0, grants: new Map(), timer: null }; this.#rooms.set(roomId, record); }
    return record;
  }
  #valid(roomId, grant) {
    const members = this.#members(roomId), owner = members.find(peer => peer.id === grant.publisherPeerId);
    const target = members.find(peer => peer.id === grant.machinePeerId);
    return owner && !owner.machine && owner.authenticated === true && target?.machine === true
      && grant.expiresAt > this.#clock()
      && (!grant.chatRead || target.machineCapabilities?.includes("chat.read"))
      && (!grant.publicationIds.length || target.machineCapabilities?.includes("audio.receive"))
      && grant.publicationIds.every(id => ["microphone", "screen-audio"].includes(owner.publications.get(id)?.source));
  }
  #arm(roomId, record) {
    clearTimeout(record.timer); record.timer = null;
    if (record.grants.size) {
      const next = Math.min(...[...record.grants.values()].map(g => g.expiresAt));
      record.timer = setTimeout(() => this.prune(roomId), Math.max(1, next - this.#clock()));
      record.timer.unref?.();
    }
  }
  update(actor, raw) {
    const request = parseMachineReceiveConsent(raw), roomId = actor?.roomId;
    if (!actor || actor.machine || actor.authenticated !== true || !this.#members(roomId).includes(actor)) fail("machine_receive_actor_denied");
    this.prune(roomId);
    const record = this.#record(roomId);
    if (request.expectedRevision !== record.revision || record.revision >= Number.MAX_SAFE_INTEGER) fail("machine_receive_revision_conflict");
    const target = this.#members(roomId).find(peer => peer.id === request.machinePeerId && peer.machine === true);
    if (!target) fail("machine_receive_target_unavailable");
    const key = `${actor.id}\0${target.id}`;
    if (!request.chatRead && !request.publicationIds.length) record.grants.delete(key);
    else {
      const grant = Object.freeze({ publisherPeerId: actor.id, machinePeerId: target.id,
        publicationIds: request.publicationIds, chatRead: request.chatRead, expiresAt: request.expiresAt });
      if (request.expiresAt > this.#clock() + 600_000 || !this.#valid(roomId, grant)) fail("machine_receive_scope_denied");
      record.grants.set(key, grant);
    }
    ++record.revision; this.#arm(roomId, record);
    const state = this.snapshot(roomId); this.#changed(roomId, state); return state;
  }
  snapshot(roomId) {
    const record = this.#rooms.get(roomId);
    return Object.freeze({ type: "machine-receive-state", version: 1, roomId,
      revision: record?.revision || 0, grants: Object.freeze(record ? [...record.grants.values()] : []) });
  }
  mediaAllowed(receiver, publisherPeerId, publicationId) {
    if (!receiver || !this.#members(receiver.roomId).includes(receiver)) return false;
    if (!receiver.machine) return true;
    const grant = this.#rooms.get(receiver.roomId)?.grants.get(`${publisherPeerId}\0${receiver.id}`);
    return Boolean(grant && grant.publicationIds.includes(publicationId) && this.#valid(receiver.roomId, grant));
  }
  prune(roomId) {
    const record = this.#rooms.get(roomId);
    if (!record) return;
    if (!this.#members(roomId).length) { clearTimeout(record.timer); this.#rooms.delete(roomId); return; }
    let changed = false;
    for (const [key, grant] of record.grants) if (!this.#valid(roomId, grant)) { record.grants.delete(key); changed = true; }
    if (changed) {
      ++record.revision; this.#arm(roomId, record); this.#changed(roomId, this.snapshot(roomId));
    }
  }
  destroy() { for (const room of this.#rooms.values()) clearTimeout(room.timer); this.#rooms.clear(); }
}
