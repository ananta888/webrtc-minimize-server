import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { PairWorkspaceStore } from "../src/pair-workspace-store.js";

test("PairWorkspaceStore persists membership, idempotent events, cursor and presence", (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pair-workspace-"));
  const filename = path.join(directory, "workspace.sqlite");
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const owner = "https://issuer.test|owner";
  const editor = "https://issuer.test|editor";
  const store = new PairWorkspaceStore({ filename });
  const created = store.create({ roomId: "pair-persist1", title: "  Shared   Work  ", ownerPrincipal: owner, now: 100 });
  assert.equal(created.title, "Shared Work");
  assert.deepEqual(store.admit(created.roomId, editor, created.inviteToken, 101), {
    workspaceId: created.workspaceId,
    role: "editor",
  });
  assert.equal(store.get(created.workspaceId, owner).members.length, 2);
  const event = store.appendEvent(created.workspaceId, editor, {
    eventId: "event-0001",
    kind: "decision",
    payload: { text: "Use WebRTC", order: 1 },
  }, 102);
  assert.equal(event.idempotent, false);
  assert.equal(store.appendEvent(created.workspaceId, editor, {
    eventId: "event-0001",
    kind: "decision",
    payload: { order: 1, text: "Use WebRTC" },
  }, 103).idempotent, true);
  assert.throws(() => store.appendEvent(created.workspaceId, editor, {
    eventId: "event-0001", kind: "note", payload: { text: "conflict" },
  }), /event_id_conflict/);
  assert.equal(store.setCursor(created.workspaceId, editor, event.sequence, 104).sequence, event.sequence);
  assert.throws(() => store.setCursor(created.workspaceId, editor, 0, 105), /cursor_regression/);
  assert.equal(store.setPresence(created.workspaceId, editor, {
    state: "active", documentId: "README.md", line: 12, column: 4,
    leaseId: "presence-0001", epoch: 1, ttlMs: 30_000,
  }, 106).documentId, "README.md");
  assert.throws(() => store.setPresence(created.workspaceId, editor, {
    state: "away", documentId: "README.md", line: 12, column: 4,
    leaseId: "presence-0001", epoch: 1, ttlMs: 30_000,
  }, 107), /stale_presence_epoch/);
  store.close();

  const reopened = new PairWorkspaceStore({ filename });
  assert.equal(reopened.list(editor)[0].workspaceId, created.workspaceId);
  assert.deepEqual(reopened.timeline(created.workspaceId, owner)[0].payload, {
    order: 1, text: "Use WebRTC",
  });
  assert.deepEqual(reopened.setRole(created.workspaceId, owner, editor, "viewer", 2), {
    principal: editor, role: "viewer", membershipRevision: 3,
  });
  assert.throws(() => reopened.appendEvent(created.workspaceId, editor, {
    eventId: "event-0002", kind: "note", payload: { text: "denied" },
  }), /workspace_write_denied/);
  reopened.close();
});

test("PairWorkspaceStore consumes a bounded invite and hides workspaces from outsiders", () => {
  const store = new PairWorkspaceStore();
  const created = store.create({ roomId: "pair-persist2", ownerPrincipal: "issuer|owner" });
  store.admit(created.roomId, "issuer|editor", created.inviteToken);
  assert.throws(() => store.admit(created.roomId, "issuer|third", created.inviteToken), /invalid_workspace_invite/);
  assert.throws(() => store.get(created.workspaceId, "issuer|outsider"), /workspace_not_found/);
  store.close();
});
