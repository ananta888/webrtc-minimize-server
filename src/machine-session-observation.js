import { MachineLeaseError } from "./machine-session-leases.js";

const rights = { camera: "avatar.publish", microphone: "speech.publish", screen: "screen.publish",
  "screen-audio": "screen-audio.publish" };
const integer = (value, minimum) => Number.isSafeInteger(value) && value >= minimum;
const invalid = () => { throw new MachineLeaseError("machine_observation_state_invalid", 503); };

/** Current machine-owned registry metadata, never received media or Worker status. */
export function machineSessionObservation(peer, membershipEpoch) {
  if (peer.machine !== true || typeof peer.id !== "string" || !/^[a-f0-9]{16}$/.test(peer.id)
    || typeof peer.roomId !== "string" || !/^room-[a-f0-9]{18}$/.test(peer.roomId)
    || !integer(membershipEpoch, 1) || !integer(peer.publicationRevision, 0)
    || !(peer.publications instanceof Map) || peer.publications.size > 4) invalid();
  const seen = new Set(), epochs = new Set();
  const publications = [...peer.publications.entries()].map(([id, value]) => {
    if (!value || Object.keys(value).sort().join() !== "publicationEpoch,publicationId,source"
      || typeof id !== "string" || !/^[A-Za-z0-9_={}:-]{1,128}$/.test(id) || value.publicationId !== id
      || typeof value.source !== "string" || !Object.hasOwn(rights, value.source)
      || !peer.machineCapabilities?.includes(rights[value.source])
      || seen.has(value.source) || !integer(value.publicationEpoch, 1)
      || value.publicationEpoch > peer.publicationRevision || epochs.has(value.publicationEpoch)) invalid();
    seen.add(value.source); epochs.add(value.publicationEpoch);
    return Object.freeze({ publicationId: id, source: value.source, publicationEpoch: value.publicationEpoch });
  });
  publications.sort((a, b) => a.publicationId.localeCompare(b.publicationId, "en"));
  return Object.freeze({ peerId: peer.id, roomId: peer.roomId, membershipEpoch,
    publicationRevision: peer.publicationRevision, publications: Object.freeze(publications) });
}
