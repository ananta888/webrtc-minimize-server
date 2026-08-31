import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeRoomTitle,
  normalizeRoomVisibility,
  RoomDirectory,
  RoomDirectoryError,
} from "../src/room-directory.js";

test("RoomDirectory separates public and owner views without exposing principals", () => {
  const directory = new RoomDirectory({ idleTtlMs: 60_000, maxParticipants: 20 });
  directory.create({
    roomId: "room-public",
    title: "  Offene   Runde ",
    visibility: "public",
    ownerPrincipal: "issuer|owner",
  }, 1_000);
  directory.create({
    roomId: "room-private",
    title: "Intern",
    visibility: "private",
    ownerPrincipal: "issuer|owner",
  }, 2_000);

  const anonymous = directory.list({ participantCount: (roomId) => roomId === "room-public" ? 4 : 0 });
  assert.deepEqual(anonymous.publicRooms.map((room) => room.roomId), ["room-public"]);
  assert.equal(anonymous.publicRooms[0].participantCount, 4);
  assert.equal(anonymous.publicRooms[0].owned, false);
  assert.deepEqual(anonymous.ownRooms, []);

  const owner = directory.list({ principal: "issuer|owner" });
  assert.deepEqual(owner.ownRooms.map((room) => room.roomId), ["room-private", "room-public"]);
  assert.ok(owner.ownRooms.every((room) => room.owned));
  assert.equal(JSON.stringify(owner).includes("issuer|owner"), false);
});

test("RoomDirectory permits only its exact owner to change title or visibility", () => {
  const directory = new RoomDirectory({ idleTtlMs: 60_000 });
  directory.create({
    roomId: "room-owned",
    title: "Privat",
    visibility: "private",
    ownerPrincipal: "issuer|owner",
  }, 1_000);

  assert.throws(
    () => directory.update("room-owned", "issuer|other", { visibility: "public" }),
    (error) => error instanceof RoomDirectoryError
      && error.code === "room_owner_required"
      && error.status === 403,
  );
  directory.update("room-owned", "issuer|owner", { title: "Offene Runde", visibility: "public" }, 2_000);
  assert.deepEqual(directory.list().publicRooms.map(({ title, visibility }) => ({ title, visibility })), [
    { title: "Offene Runde", visibility: "public" },
  ]);
});

test("RoomDirectory validates metadata and prunes only idle entries", () => {
  assert.equal(normalizeRoomTitle("  Team   Sync "), "Team Sync");
  assert.equal(normalizeRoomVisibility(undefined), "private");
  assert.throws(() => normalizeRoomTitle("bad\nroom"), /invalid_room_title/);
  assert.throws(() => normalizeRoomTitle("x".repeat(81)), /invalid_room_title/);
  assert.throws(() => normalizeRoomTitle({ title: "object" }), /invalid_room_title/);
  assert.throws(() => normalizeRoomVisibility("listed"), /invalid_room_visibility/);
  assert.throws(() => normalizeRoomVisibility(true), /invalid_room_visibility/);

  const directory = new RoomDirectory({ idleTtlMs: 1_000 });
  directory.create({
    roomId: "room-idle",
    title: "Idle",
    visibility: "public",
    ownerPrincipal: "issuer|owner",
  }, 1_000);
  directory.create({
    roomId: "room-active",
    title: "Active",
    visibility: "public",
    ownerPrincipal: "issuer|owner",
  }, 1_000);
  assert.equal(directory.prune(2_000, (roomId) => roomId === "room-active"), 1);
  assert.deepEqual(directory.list().publicRooms.map((room) => room.roomId), ["room-active"]);
});
