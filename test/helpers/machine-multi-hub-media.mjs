// Observation and synthetic receiver UI actions, never a Hub policy authority.
import { installMultiPublisherObservation } from "./machine-multi-publisher-observation.mjs";
import { waitFixtureValue } from "./machine-browser-wait.mjs";
import { installSpeakerFloorObservation } from "./machine-speaker-floor-observation.mjs";
import { reconnectQuietWindow } from "./machine-reconnect-quiet-window.mjs";

const red = pixel => pixel?.[0] > 170 && pixel[1] < 70 && pixel[2] < 70;
const blue = pixel => pixel?.[2] > 170 && pixel[0] < 70 && pixel[1] < 70;

export async function multiHubMedia(f) {
  await f.human.evaluate(installMultiPublisherObservation);
  let step = "idle", publisher = null, floorObservation = null, mediaObservation = null;
  return {
    diagnostic() { return { step, publisher, ...(floorObservation ? { floor: floorObservation } : {}),
      ...(mediaObservation ? { sources: mediaObservation } : {}) }; },
    async close() {
      await f.human.evaluate(async () => { await window.__speakerFloor?.close(); await window.__multiPublisher.close(); });
    },
    async command(input, peers) {
      const page = f.human;
      if (input.command === "floor-start" && Object.keys(input).length === 1) {
        await page.locator(".nav-item").filter({ hasText: /^Live/ }).click();
        await waitFixtureValue(page, peers => peers.every(peer => {
          const element = [...document.querySelectorAll('.remote-media[data-source="screen"]')]
            .find(el => el.dataset.peerId === peer);
          const video = element?.querySelector("video");
          return Boolean(video?.srcObject && video.readyState >= 2 && video.videoWidth);
        }), peers, { timeout: 5000 });
        await page.evaluate(installSpeakerFloorObservation, peers);
        return { observing: true };
      }
      if (input.command === "floor-result" && Object.keys(input).length === 1) {
        // The signed Hub reply has its own existing 25s budget. Only after
        // reply correlation can source opening (10s) and four-second fixture
        // PCM be expected to finish. Do not conflate inference and playback.
        step = "floor-answer";
        await page.locator("#chat-log").getByText("Synthetic Hub answer", { exact: false }).nth(1)
          .waitFor({ timeout: 25000 });
        step = "floor-observation";
        let result;
        await waitFixtureValue(page, () => window.__speakerFloor.snapshot(), undefined, {
          timeout: 18000, accept: value => {
            const counter = (n, max = 3000) => Number.isInteger(n) && n >= 0 && n <= max ? n : null;
            floorObservation = {
              failed: value.failed === true, samples: counter(value.samples), overlap: counter(value.overlap),
              max_gap_ms: counter(value.max_gap_ms, 60001), quiet_ms: counter(value.quiet_ms, 60001),
              counts: Array.isArray(value.counts) && value.counts.length === 2 ? value.counts.map(n => counter(n)) : [],
              active: Array.isArray(value.active) && value.active.length === 2 ? value.active.map(v => v === true) : [],
            };
            if (value.failed || value.overlap) throw new Error("test_floor_observation_failed");
            result = value;
            return value.counts.every(count => count >= 3) && value.active.every(active => !active) && value.quiet_ms >= 300;
          },
        });
        await page.evaluate(() => window.__speakerFloor.close());
        step = "idle";
        return result;
      }
      if (input.command === "consent" && Object.keys(input).length === 3
        && [0, 1].includes(input.publisher) && typeof input.enabled === "boolean") {
        // Legacy bridge command is observation only. Selective withdrawal
        // requires the owning Hub to replace/revoke the corresponding lease.
        publisher = input.publisher; step = "consent-navigation";
        if (!input.enabled) throw new Error("test_hub_receive_revocation_required");
        await page.locator("#mesh-analysis-navigation").click();
        const article = page.locator("app-machine-permissions-panel").locator("article")
          .filter({ has: page.locator("code", { hasText: peers[input.publisher] }) });
        step = "receive-policy-observation";
        await article.getByText(/Leserecht vorhanden/).waitFor();
        step = "idle"; publisher = null;
        return { consent: input.publisher, enabled: true };
      }
      if (input.command === "ask" && Object.keys(input).length === 1) {
        await page.getByRole("button", { name: "Chat", exact: true }).click();
        await page.locator("#chat-form.large").waitFor();
        await page.locator("#chat-message").fill("@ananta synthetic two-publisher question");
        await page.locator("#chat-form button").click();
        return { sent: true };
      }
      if (input.command === "answers" && Object.keys(input).length === 1) {
        await page.getByRole("button", { name: "Chat", exact: true }).click();
        const replies = page.locator("#chat-log").getByText("Synthetic Hub answer", { exact: false });
        await replies.nth(1).waitFor();
        if (await replies.count() !== 2) throw new Error("test_multi_reply_count_invalid");
        return { replies: 2 };
      }
      if (input.command === "answer-count" && Object.keys(input).length === 2 && [1, 2].includes(input.count)) {
        step = "reconnect-answer";
        await page.locator("#chat-log").getByText("Synthetic Hub answer", { exact: false }).nth(input.count - 1)
          .waitFor({ timeout: 25000 });
        step = "idle";
        return { replies: input.count };
      }
      if (input.command === "recovered-media" && Object.keys(input).length === 1) {
        await page.locator(".nav-item").filter({ hasText: /^Live/ }).click();
        await waitFixtureValue(page, () => window.__multiPublisher.quiet(), undefined, {
          timeout: 3000, accept: reconnectQuietWindow(),
        });
        return { oldAudioReplayed: false, quietMs: 300 };
      }
      if (input.command !== "media" || Object.keys(input).length !== 2
        || !["avatars", "first-speech", "both-speech", "first-revoked", "survivor"].includes(input.phase)) {
        throw new Error("test_multi_media_command_invalid");
      }
      step = "media-navigation";
      await page.locator(".nav-item").filter({ hasText: /^Live/ }).click();
      if (["first-speech", "both-speech"].includes(input.phase)) {
        let consecutive = 0;
        await waitFixtureValue(page, peers => window.__multiPublisher.active(peers), peers, {
          timeout: 12000, accept: active => {
            const good = active[0] && (input.phase !== "both-speech" || active[1]);
            consecutive = good ? consecutive + 1 : 0; return consecutive >= 3;
          },
        });
        return { audio: input.phase === "both-speech" ? "both" : "first", consecutive: 3 };
      }
      step = "media-observation";
      await waitFixtureValue(page, peers => window.__multiPublisher.snapshot(peers), peers, {
        timeout: 12000, accept: state => {
          const pixel = value => Array.isArray(value) && value.length === 3
            && value.every(n => Number.isInteger(n) && n >= 0 && n <= 255) ? value.slice() : null;
          mediaObservation = { failed: state.failed === true,
            publishers: Array.isArray(state.publishers) ? state.publishers.slice(0, 2).map(p => ({
              camera: pixel(p.camera), screen: pixel(p.screen),
            })) : [] };
          const [first, second] = state.publishers;
          return !state.failed && blue(second.camera) && second.screen !== null
            && (input.phase === "avatars" ? red(first.camera) && first.screen !== null
              : first.camera === null && (input.phase === "survivor" ? first.screen === null : first.screen !== null));
        },
      });
      return { personas: input.phase === "avatars" ? ["red", "blue"] : [null, "blue"],
        screens: input.phase === "survivor" ? [false, true] : [true, true] };
    },
  };
}
