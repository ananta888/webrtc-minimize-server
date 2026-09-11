import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import { chromium } from "playwright";

import { createAppServer } from "../src/server.js";

test("two browser contexts verify whiteboard ACL, shared notes sync and in-meeting polling without capture", async (context) => {
  try {
    await fs.access(chromium.executablePath());
  } catch {
    context.skip("Playwright Chromium is not installed");
    return;
  }

  const app = createAppServer({
    config: {
      host: "127.0.0.1",
      port: 0,
      publicOrigin: "",
      stunUrls: [],
      turnServers: [],
      maxRoomParticipants: 20,
      roomIdleTtlMs: 60_000,
      signalRateLimit: 120,
      pairWorkspaceEnabled: false,
      mediaE2eeMode: "required",
    },
  });

  await new Promise((resolve, reject) => {
    app.server.once("error", reject);
    app.server.listen(0, "127.0.0.1", resolve);
  });

  const origin = `http://127.0.0.1:${app.server.address().port}`;
  const browser = await chromium.launch({
    headless: true,
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
    ],
  });

  context.after(async () => {
    await browser.close().catch(() => {});
    for (const socket of app.webSocketServer.clients) socket.terminate();
    await new Promise((resolve) => app.server.close(resolve));
  });

  const addCaptureTrap = async (ctx) => {
    await ctx.addInitScript(() => {
      window.__captureCalls = [];
      for (const method of ["getUserMedia", "getDisplayMedia"]) {
        navigator.mediaDevices[method] = async () => {
          window.__captureCalls.push(method);
          throw new Error("unexpected capture invocation");
        };
      }
    });
  };

  const aliceContext = await browser.newContext({ permissions: [] });
  const bobContext = await browser.newContext({ permissions: [] });
  await addCaptureTrap(aliceContext);
  await addCaptureTrap(bobContext);

  const alice = await aliceContext.newPage();
  const bob = await bobContext.newPage();
  const pageErrors = [];
  for (const page of [alice, bob]) {
    page.on("pageerror", (error) => pageErrors.push(error.message));
  }

  // 1. Alice creates room and joins
  await alice.goto(`${origin}/`);
  await alice.locator("#display-name").fill("Alice");
  await alice.locator("#create-room").click();
  await alice.waitForFunction(() => document.querySelector("#room-id")?.value?.startsWith("room-"));
  const roomId = await alice.locator("#room-id").inputValue();
  await alice.locator("#join-room").click();
  await alice.locator("#connection-status", { hasText: "Signaling verbunden" }).waitFor();

  // 2. Bob joins the same room
  await bob.goto(`${origin}/?room=${roomId}`);
  await bob.locator("#display-name").fill("Bob");
  await bob.locator("#join-room").click();
  await bob.locator("#connection-status", { hasText: "Signaling verbunden" }).waitFor();

  // Wait for peer data channel to establish between Alice and Bob
  await bob.locator("#participant-count", { hasText: "2 / 20" }).waitFor({ timeout: 15_000 });
  await alice.locator("#participant-count", { hasText: "2 / 20" }).waitFor({ timeout: 15_000 });
  await alice.locator("#chat-log").getByText("Bob: Peer-Chat verbunden").waitFor({ timeout: 15_000 });

  // 3. Verify Whiteboard ACL
  // Default is "open": both Alice and Bob have enabled tools
  assert.equal(await alice.locator("#whiteboard-tool-select").isDisabled(), false);
  assert.equal(await bob.locator("#whiteboard-tool-select").isDisabled(), false);

  // Alice toggles policy to "presenter-only"
  await alice.locator("#whiteboard-toggle-policy").click();
  // Bob sees read-only badge and tool select is disabled
  await bob.locator("#whiteboard-read-only-badge").waitFor({ timeout: 5_000 });
  assert.equal(await bob.locator("#whiteboard-tool-select").isDisabled(), true);
  // Alice (owner) still has active tools
  assert.equal(await alice.locator("#whiteboard-tool-select").isDisabled(), false);

  // Alice toggles back to "open"
  await alice.locator("#whiteboard-toggle-policy").click();
  await bob.waitForFunction(() => !document.querySelector("#whiteboard-read-only-badge"), { timeout: 5_000 });
  assert.equal(await bob.locator("#whiteboard-tool-select").isDisabled(), false);

  // 4. Verify Shared Notes
  // Alice types in shared notes textarea
  await alice.locator("#shared-notes-textarea").fill("Agenda Item 1: Launch Plan");
  // Allow debounce and overlay delivery to propagate to Bob
  await bob.waitForFunction(
    () => (document.querySelector("#shared-notes-textarea")?.value || "").includes("Agenda Item 1"),
    { timeout: 8_000 }
  );
  assert.equal(await bob.locator("#shared-notes-textarea").inputValue(), "Agenda Item 1: Launch Plan");

  // Verify export buttons are enabled when text exists
  assert.equal(await bob.locator("#notes-export-md").isDisabled(), false);
  assert.equal(await bob.locator("#notes-export-txt").isDisabled(), false);

  // 5. Verify In-Meeting Polling
  // Alice (owner) sees the poll creation form
  await alice.locator("#poll-question-input").fill("Release heute starten?");
  // Bob (participant) should not see the create button
  assert.equal(await bob.locator("#poll-start-button").count(), 0);

  // Alice starts the poll
  await alice.locator("#poll-start-button").click();

  // Both should now see the active poll
  await alice.locator(".poll-question", { hasText: "Release heute starten?" }).waitFor({ timeout: 5_000 });
  await bob.locator(".poll-question", { hasText: "Release heute starten?" }).waitFor({ timeout: 5_000 });

  // Bob casts vote for first option ("Ja")
  const bobVoteBtn = bob.locator(".option-vote-button", { hasText: "Ja" });
  await bobVoteBtn.click();
  await bob.locator(".voted-confirmation").waitFor({ timeout: 5_000 });

  // Alice (creator) receives vote count
  await alice.waitForFunction(
    () => document.querySelector(".creator-preview")?.textContent?.includes("1 Stimmen"),
    { timeout: 8_000 }
  );

  // Alice publishes results
  await alice.locator("#poll-publish-results").click();

  // Bob sees published results and export button
  await bob.locator(".poll-results-box").waitFor({ timeout: 5_000 });
  assert.equal(await bob.locator("#poll-export-results").count(), 1);

  // 6. Verify zero capture calls were made
  assert.deepEqual(await alice.evaluate(() => window.__captureCalls), []);
  assert.deepEqual(await bob.evaluate(() => window.__captureCalls), []);
  assert.deepEqual(pageErrors, []);
});
