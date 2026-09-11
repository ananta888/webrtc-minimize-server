export type ParticipantRoleFilter = "all" | "owner" | "participant";
export type ParticipantHandFilter = "all" | "raised";
export type MediaObservationKind = "local" | "received" | "none";

export interface ParticipantListRow {
  readonly peerId: string;
  readonly name: string;
  readonly own: boolean;
  readonly role: "owner" | "participant";
  readonly hand: "none" | "raised";
  readonly queuePosition: number;
  readonly mediaKind: MediaObservationKind;
  readonly mediaSources: readonly string[];
}

const SOURCE_LABEL: Record<string, string> = {
  microphone: "Mikrofon",
  camera: "Kamera",
  screen: "Bildschirm",
  "screen-audio": "Bildschirmton",
};

export function mediaObservationLabel(source: string): string {
  return SOURCE_LABEL[source] || source;
}

export function participantListRows(input: {
  readonly ownPeerId: string;
  readonly ownName: string;
  readonly participants: readonly { peerId: string; role: "owner" | "participant"; hand: "none" | "raised" }[];
  readonly queue: readonly string[];
  readonly peerNames: readonly { id: string; name: string }[];
  readonly localSources: readonly string[];
  readonly remoteSources: readonly { peerId: string; source: string }[];
}): readonly ParticipantListRow[] {
  const names = new Map(input.peerNames.map((peer) => [peer.id, peer.name]));
  const remote = new Map<string, string[]>();
  for (const item of input.remoteSources) {
    const current = remote.get(item.peerId) || [];
    if (!current.includes(item.source)) current.push(item.source);
    remote.set(item.peerId, current);
  }
  return Object.freeze(input.participants.map((participant) => {
    const own = participant.peerId === input.ownPeerId;
    const mediaSources = own ? [...input.localSources] : [...(remote.get(participant.peerId) || [])];
    const queuePosition = participant.hand === "raised" ? input.queue.indexOf(participant.peerId) + 1 : 0;
    return Object.freeze({
      peerId: participant.peerId,
      name: own ? input.ownName || "Du" : names.get(participant.peerId) || "Teilnehmer",
      own,
      role: participant.role,
      hand: participant.hand,
      queuePosition,
      mediaKind: mediaSources.length === 0 ? "none" as const : own ? "local" as const : "received" as const,
      mediaSources: Object.freeze(mediaSources),
    });
  }));
}
