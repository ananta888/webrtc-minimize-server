export interface MediaAgentRemoteTrackBinding {
  readonly publisherPeerId: string;
  readonly publicationId: string;
  readonly kind: "audio" | "video";
}

const PEER_ID = /^[a-f0-9]{16}$/;
const PUBLICATION_ID = /^[A-Za-z0-9_={}:-]{1,128}$/;
const MID = /^[A-Za-z0-9_-]{1,64}$/;
const MAXIMUM_SDP_BYTES = 1_048_576;
const MAXIMUM_MEDIA_SECTIONS = 128;

interface MediaSection {
  readonly kind: "audio" | "video" | "other";
  readonly rejected: boolean;
  mid: string;
  publisherPeerId: string;
  publicationId: string;
  direction: "sendrecv" | "sendonly" | "recvonly" | "inactive";
  invalid: boolean;
}

export function parseMediaAgentRemoteTrackBindings(
  sdp: string,
): ReadonlyMap<string, MediaAgentRemoteTrackBinding> | null {
  if (!sdp || sdp.length > MAXIMUM_SDP_BYTES) return null;
  const bindings = new Map<string, MediaAgentRemoteTrackBinding>();
  const seenMids = new Set<string>();
  let section: MediaSection | null = null;
  let sectionCount = 0;

  const finishSection = (): void => {
    if (!section || !MID.test(section.mid)) return;
    if (seenMids.has(section.mid)) {
      bindings.delete(section.mid);
      return;
    }
    seenMids.add(section.mid);
    if (section.kind === "other" || section.rejected
      || section.direction === "recvonly" || section.direction === "inactive"
      || !section.publisherPeerId || !section.publicationId || section.invalid
      || !PEER_ID.test(section.publisherPeerId)
      || !PUBLICATION_ID.test(section.publicationId)) return;
    const binding = Object.freeze({
      publisherPeerId: section.publisherPeerId,
      publicationId: section.publicationId,
      kind: section.kind,
    });
    bindings.set(section.mid, binding);
  };

  for (const rawLine of sdp.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith("m=")) {
      finishSection();
      sectionCount += 1;
      if (sectionCount > MAXIMUM_MEDIA_SECTIONS) return null;
      const fields = line.slice(2).split(/\s+/);
      const kind = fields[0] === "audio" || fields[0] === "video" ? fields[0] : "other";
      section = {
        kind,
        rejected: fields[1] === "0",
        mid: "",
        publisherPeerId: "",
        publicationId: "",
        direction: "sendrecv",
        invalid: fields.length < 2,
      };
      continue;
    }
    if (!section) continue;
    if (line.startsWith("a=mid:")) {
      const mid = line.slice(6);
      if (section.mid && section.mid !== mid) section.invalid = true;
      section.mid = mid;
      continue;
    }
    if (line.startsWith("a=msid:")) {
      const fields = line.slice(7).split(/\s+/);
      if (fields.length !== 2) {
        section.invalid = true;
        continue;
      }
      const [publisherPeerId, publicationId] = fields;
      if ((section.publisherPeerId && section.publisherPeerId !== publisherPeerId)
        || (section.publicationId && section.publicationId !== publicationId)) section.invalid = true;
      section.publisherPeerId = publisherPeerId;
      section.publicationId = publicationId;
      continue;
    }
    if (line === "a=sendrecv" || line === "a=sendonly" || line === "a=recvonly" || line === "a=inactive") {
      section.direction = line.slice(2) as MediaSection["direction"];
    }
  }
  finishSection();
  return bindings;
}
