import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { mediaObservationLabel, participantListRows } from "./room-participant-list";

const component = readFileSync("frontend/src/app/shared/room-participant-list.component.ts", "utf8");

describe("RoomParticipantListComponent", () => {
  it("joins server roles with local names and media observations without deriving authority", () => {
    const rows = participantListRows({
      ownPeerId: "aaaaaaaaaaaaaaaa",
      ownName: "Ada",
      participants: [
        { peerId: "aaaaaaaaaaaaaaaa", role: "owner", hand: "none" },
        { peerId: "bbbbbbbbbbbbbbbb", role: "participant", hand: "raised" },
      ],
      queue: ["bbbbbbbbbbbbbbbb"],
      peerNames: [{ id: "bbbbbbbbbbbbbbbb", name: "Grace" }],
      localSources: ["microphone"],
      remoteSources: [{ peerId: "bbbbbbbbbbbbbbbb", source: "camera" }],
    });
    expect(rows[0]).toMatchObject({
      name: "Ada", own: true, role: "owner", mediaKind: "local", mediaSources: ["microphone"], queuePosition: 0,
    });
    expect(rows[1]).toMatchObject({
      name: "Grace", own: false, role: "participant", mediaKind: "received", mediaSources: ["camera"], queuePosition: 1,
    });
    expect(mediaObservationLabel("microphone")).toBe("Mikrofon");
  });

  it("keeps owner-clear and search in the list without capture APIs", () => {
    expect(component).toContain('id="participant-list"');
    expect(component).toContain('id="hand-queue"');
    expect(component).toContain('id="participant-filter"');
    expect(component).toContain("moderation.clear(item.peerId)");
    expect(component).toContain("moderation.remove");
    expect(component).toContain('id="peer-remove-confirm"');
    expect(component).toContain("Raumrolle");
    expect(component).toContain("Lokal gemessen");
    expect(component).toContain("Empfangen");
    expect(component).not.toContain("getUserMedia");
    expect(component).not.toContain("getDisplayMedia");
    expect(component).not.toContain("toggle(");
  });
});
