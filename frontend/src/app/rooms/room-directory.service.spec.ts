import { beforeEach, describe, expect, it, vi } from "vitest";

import { RoomDirectoryService } from "./room-directory.service";

const room = {
  roomId: "room-0123456789abcdefab",
  title: "Offene Runde",
  visibility: "public" as const,
  participantCount: 3,
  maxParticipants: 20,
  owned: true,
  createdAt: "2026-08-31T10:00:00.000Z",
  updatedAt: "2026-08-31T10:00:00.000Z",
};

describe("RoomDirectoryService", () => {
  const auth = { authorizationHeader: vi.fn(() => ({ Authorization: "Bearer access-token" })) };

  beforeEach(() => {
    vi.restoreAllMocks();
    auth.authorizationHeader.mockClear();
  });

  it("loads separate public and owner lists through the current OIDC authorization", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      publicRooms: [room],
      ownRooms: [{ ...room, visibility: "private" }],
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const service = new RoomDirectoryService(auth as never);

    await service.load();

    expect(service.publicRooms()).toEqual([room]);
    expect(service.ownRooms()[0].visibility).toBe("private");
    expect(fetchMock).toHaveBeenCalledWith("/api/rooms", {
      headers: { Authorization: "Bearer access-token" },
    });
  });

  it("creates and owner-updates rooms with bounded contracts", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({
        roomId: room.roomId,
        title: room.title,
        visibility: "private",
        inviteUrl: `https://webrtc.test/?room=${room.roomId}&mode=room`,
      }), { status: 201, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ room }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }));
    const service = new RoomDirectoryService(auth as never);

    await service.create("Offene Runde", "private");
    const updated = await service.update(room.roomId, { visibility: "public" });

    expect(updated).toEqual(room);
    expect(service.publicRooms()).toEqual([room]);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({
      method: "POST",
      body: JSON.stringify({ mode: "room", title: "Offene Runde", visibility: "private" }),
    });
    expect(fetchMock.mock.calls[1][1]).toMatchObject({
      method: "PATCH",
      body: JSON.stringify({ visibility: "public" }),
    });
  });

  it("rejects malformed room summaries instead of trusting unknown server data", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      publicRooms: [{ ...room, participantCount: -1 }],
      ownRooms: [],
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const service = new RoomDirectoryService(auth as never);

    await service.load();

    expect(service.publicRooms()).toEqual([]);
    expect(service.error()).toBe("room_directory_invalid");
  });
});
