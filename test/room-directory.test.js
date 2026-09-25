import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  normalizePinnedRooms,
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

function temporaryDatabase() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "room-directory-"));
  return { filename: path.join(directory, "nested", "room-directory.sqlite"), cleanup: () => fs.rmSync(directory, { recursive: true, force: true }) };
}

test("RoomDirectory keeps a public entry and its room id across a restart when a store is configured", (t) => {
  const { filename, cleanup } = temporaryDatabase();
  t.after(cleanup);
  const first = new RoomDirectory({ idleTtlMs: 60_000, filename, now: 1_000 });
  first.create({
    roomId: "room-f83fb2149cf761cbee",
    title: "Ananta ai-snake",
    visibility: "public",
    ownerPrincipal: "issuer|ananta-meet-bot",
  }, 1_000);
  first.create({ roomId: "room-private", title: "Intern", visibility: "private", ownerPrincipal: "issuer|other" }, 1_500);
  first.update("room-private", "issuer|other", { title: "Umbenannt" }, 1_600);
  first.close();

  const restarted = new RoomDirectory({ idleTtlMs: 60_000, filename, now: 500_000 });
  t.after(() => restarted.close());
  const listed = restarted.list({ principal: "issuer|ananta-meet-bot" });
  assert.deepEqual(listed.publicRooms.map(({ roomId, title }) => ({ roomId, title })), [
    { roomId: "room-f83fb2149cf761cbee", title: "Ananta ai-snake" },
  ]);
  assert.equal(listed.ownRooms[0].owned, true);
  assert.equal(listed.ownRooms[0].createdAt, new Date(1_000).toISOString());
  assert.equal(restarted.ownerPrincipal("room-f83fb2149cf761cbee"), "issuer|ananta-meet-bot");
  assert.equal(restarted.list({ principal: "issuer|other" }).ownRooms[0].title, "Umbenannt");
  assert.throws(
    () => restarted.create({ roomId: "room-f83fb2149cf761cbee", title: "x", ownerPrincipal: "issuer|x" }),
    /room_already_registered/,
  );
});

test("RoomDirectory restarts the idle clock on restore and persists prune removals", (t) => {
  const { filename, cleanup } = temporaryDatabase();
  t.after(cleanup);
  const first = new RoomDirectory({ idleTtlMs: 1_000, filename, now: 0 });
  first.create({ roomId: "room-old", title: "Alt", visibility: "public", ownerPrincipal: "issuer|owner" }, 0);
  first.close();

  // Restored long after its last activity, yet not pruned on first sight:
  // members need the idle window to reconnect after a restart.
  const restarted = new RoomDirectory({ idleTtlMs: 1_000, filename, now: 100_000 });
  assert.equal(restarted.prune(100_500), 0);
  assert.deepEqual(restarted.list().publicRooms.map((room) => room.roomId), ["room-old"]);
  assert.equal(restarted.prune(101_000), 1);
  restarted.close();

  const again = new RoomDirectory({ idleTtlMs: 1_000, filename, now: 200_000 });
  t.after(() => again.close());
  assert.equal(again.roomCount, 0);
});

test("RoomDirectory skips tampered rows and refuses a newer store schema", (t) => {
  const { filename, cleanup } = temporaryDatabase();
  t.after(cleanup);
  new RoomDirectory({ filename }).close();
  const database = new DatabaseSync(filename);
  const insert = database.prepare(`INSERT INTO room_directory
    (room_id, title, visibility, owner_principal, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`);
  insert.run("room-good", "Gut", "public", "issuer|owner", 1, 1);
  insert.run("room-bad-visibility", "Schlecht", "listed", "issuer|owner", 1, 1);
  insert.run("room bad id", "Schlecht", "public", "issuer|owner", 1, 1);
  insert.run("room-bad-title", "a\nb", "public", "issuer|owner", 1, 1);
  insert.run("room-no-owner", "Schlecht", "public", "", 1, 1);
  database.close();

  const restored = new RoomDirectory({ filename, now: 10 });
  assert.deepEqual(restored.list().publicRooms.map((room) => room.roomId), ["room-good"]);
  restored.close();
  const check = new DatabaseSync(filename);
  assert.equal(check.prepare("SELECT COUNT(*) AS count FROM room_directory").get().count, 1);
  check.exec("PRAGMA user_version = 99");
  check.close();
  assert.throws(() => new RoomDirectory({ filename }), /room_directory_schema_unsupported/);
});

test("RoomDirectory bounds registrations per owner and room id shape", (t) => {
  const { filename, cleanup } = temporaryDatabase();
  t.after(cleanup);
  const directory = new RoomDirectory({ maxEntriesPerOwner: 2, filename });
  t.after(() => directory.close());
  directory.create({ roomId: "room-a", title: "A", ownerPrincipal: "issuer|owner" });
  directory.create({ roomId: "room-b", title: "B", ownerPrincipal: "issuer|owner" });
  assert.throws(
    () => directory.create({ roomId: "room-c", title: "C", ownerPrincipal: "issuer|owner" }),
    (error) => error instanceof RoomDirectoryError && error.code === "room_directory_owner_limit" && error.status === 429,
  );
  directory.create({ roomId: "room-c", title: "C", ownerPrincipal: "issuer|second" });
  assert.throws(
    () => directory.create({ roomId: "../room", title: "X", ownerPrincipal: "issuer|second" }),
    /invalid_room_id/,
  );
  assert.throws(() => new RoomDirectory({ maxEntriesPerOwner: 0 }), RangeError);
  assert.throws(() => new RoomDirectory({ maxEntriesPerOwner: 1_001 }), RangeError);
  assert.equal(directory.roomCount, 3);
});

test("RoomDirectory without a store stays memory-only", () => {
  const directory = new RoomDirectory();
  directory.create({ roomId: "room-volatile", title: "V", visibility: "public", ownerPrincipal: "issuer|owner" });
  directory.close();
  assert.equal(new RoomDirectory().roomCount, 0);
});

const PIN = {
  roomId: "room-f83fb2149cf761cbee",
  title: "Ananta ai-snake",
  visibility: "public",
  ownerPrincipal: "https://keycloak.test/realms/ananta|bot-subject",
};

test("RoomDirectory restores an operator-pinned room id and never idle-prunes it", (t) => {
  const { filename, cleanup } = temporaryDatabase();
  t.after(cleanup);
  const first = new RoomDirectory({ idleTtlMs: 1_000, filename, pinned: [PIN], now: 0 });
  assert.deepEqual(first.list().publicRooms.map((room) => room.roomId), [PIN.roomId]);
  assert.equal(first.prune(1_000_000), 0);
  first.update(PIN.roomId, PIN.ownerPrincipal, { title: "Umbenannt" }, 2_000);
  first.close();

  const restarted = new RoomDirectory({ idleTtlMs: 1_000, filename, pinned: [PIN], now: 5_000 });
  t.after(() => restarted.close());
  const listed = restarted.list({ principal: PIN.ownerPrincipal });
  assert.deepEqual(listed.publicRooms.map(({ roomId, title }) => ({ roomId, title })), [
    { roomId: PIN.roomId, title: "Umbenannt" },
  ]);
  assert.equal(listed.ownRooms[0].owned, true);

  // Without a store the pin alone still recreates the entry after a restart.
  const memoryOnly = new RoomDirectory({ pinned: [PIN] });
  assert.equal(memoryOnly.ownerPrincipal(PIN.roomId), PIN.ownerPrincipal);
});

test("RoomDirectory pins are operator-owned and strictly validated", () => {
  const { roomId, ownerPrincipal } = PIN;
  const directory = new RoomDirectory({ pinned: [PIN] });
  assert.throws(() => directory.create({ roomId, title: "x", ownerPrincipal: "issuer|other" }), /room_already_registered/);
  assert.equal(normalizePinnedRooms([{ roomId, title: "T", ownerPrincipal }])[0].visibility, "public");
  for (const pins of [
    {},
    [{ ...PIN, roomId: "room-short" }],
    [{ ...PIN, ownerPrincipal: "no-separator" }],
    [{ ...PIN, ownerPrincipal: "issuer|" }],
    [{ ...PIN, title: "a\nb" }],
    [{ ...PIN, visibility: "listed" }],
    [{ ...PIN, extra: true }],
    [PIN, PIN],
    Array.from({ length: 17 }, (_, index) => ({ ...PIN, roomId: `room-${index.toString(16).padStart(18, "0")}` })),
  ]) {
    assert.throws(() => normalizePinnedRooms(pins), /room_directory_pins_invalid/);
  }
});
