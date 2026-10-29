import { machineCapabilityCeiling, machineReceiveCapability } from "./machine-capabilities.js";

/** Compatibility projection of verified Hub receive capabilities onto current
 * authenticated human publications. Never issues a lease or send permission. */
export function machineReceiveAuthorization(receiver, members, revision, lease, publication, now = Date.now()) {
  if (!receiver?.machine || receiver.authenticated !== true || typeof receiver.roomId !== "string" || !Array.isArray(members) || members.length > 20 || !members.includes(receiver)
    || !Number.isSafeInteger(revision) || revision < 0 || !Number.isSafeInteger(now)
    || !Number.isSafeInteger(lease?.expiresAt) || lease.expiresAt <= now || lease.expiresAt > now + 600_000
    || !Array.isArray(receiver.machineCapabilities) || typeof publication !== "function") {
    throw new Error("machine_receive_authorization_invalid");
  }
  machineCapabilityCeiling(receiver.machineCapabilities);
  if (new Set(members.map(owner => owner.id)).size !== members.length) throw new Error("machine_receive_authorization_invalid");
  const grants = [], publications = [];
  for (const owner of members) {
    if (owner === receiver || owner.roomId !== receiver.roomId || owner.machine || owner.authenticated !== true) continue;
    if (!(owner.publications instanceof Map) || owner.publications.size > 4) throw new Error("machine_receive_authorization_invalid");
    const selected = [];
    for (const id of owner.publications.keys()) {
      const current = publication(owner.id, id, receiver.roomId);
      const capability = machineReceiveCapability(current?.source);
      if (capability === null || !receiver.machineCapabilities.includes(capability)) continue;
      if (current.publicationId !== id || !Number.isSafeInteger(current.publicationEpoch) || current.publicationEpoch < 1)
        throw new Error("machine_receive_authorization_invalid");
      selected.push(id);
      publications.push(Object.freeze({ peerId: owner.id, ...current }));
    }
    const chatRead = receiver.machineCapabilities.includes("chat.read");
    if (chatRead || selected.length) grants.push(Object.freeze({ publisherPeerId: owner.id, machinePeerId: receiver.id,
      publicationIds: Object.freeze(selected), chatRead, expiresAt: lease.expiresAt }));
  }
  return Object.freeze({ receiveRevision: Math.max(1, revision), grants: Object.freeze(grants),
    publications: Object.freeze(publications) });
}
