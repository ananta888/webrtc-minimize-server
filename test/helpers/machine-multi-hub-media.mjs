// Observation and synthetic receiver UI actions, never a Hub policy authority.
import { installMultiPublisherObservation } from "./machine-multi-publisher-observation.mjs";
import { waitFixtureValue } from "./machine-browser-wait.mjs";

const red = pixel => pixel?.[0] > 170 && pixel[1] < 70 && pixel[2] < 70;
const blue = pixel => pixel?.[2] > 170 && pixel[0] < 70 && pixel[1] < 70;

export async function multiHubMedia(f) {
  await f.human.evaluate(installMultiPublisherObservation);
  let step = "idle", publisher = null;
  return {
    diagnostic() { return { step, publisher }; },
    async close() { await f.human.evaluate(() => window.__multiPublisher.close()); },
    async command(input, peers) {
      const page = f.human;
      if (input.command === "consent" && Object.keys(input).length === 3
        && [0, 1].includes(input.publisher) && typeof input.enabled === "boolean") {
        publisher = input.publisher; step = "consent-navigation";
        await page.locator("#mesh-analysis-navigation").click();
        const panel = page.locator("app-machine-permissions-panel");
        const article = panel.locator("article").filter({ has: page.locator("code", { hasText: peers[input.publisher] }) });
        step = "consent-target";
        await article.getByRole("button", { name: "Für diese KI einstellen" }).click();
        // A click is not a render barrier: the old target's checked DOM can
        // coexist briefly with the new target's reset model. Observe both
        // bindings before another input event, without changing application state.
        step = "consent-render";
        await waitFixtureValue(page, peer => {
          const panel = document.querySelector("app-machine-permissions-panel");
          const target = [...panel.querySelectorAll("article")].find(el => el.querySelector("code")?.textContent === peer);
          const label = [...panel.querySelectorAll("fieldset label")].find(el => el.textContent.trim() === "Meine neuen Chatbeiträge");
          return Boolean(target?.querySelector('button[aria-pressed="true"]'))
            && label?.querySelector("input")?.checked === false;
        }, peers[input.publisher], { timeout: 5000 });
        step = "consent-checkbox";
        await panel.getByLabel("Meine neuen Chatbeiträge", { exact: true }).uncheck();
        await panel.getByLabel("Meine neuen Chatbeiträge", { exact: true }).setChecked(input.enabled);
        step = "consent-submit";
        await panel.getByRole("button", { name: "Auswahl ausdrücklich freigeben" }).click();
        step = "consent-confirmation";
        await panel.getByText("Serverbestätigung erhalten.", { exact: true }).waitFor();
        step = "consent-target-proof";
        if (input.enabled) await article.getByText(/Chat: ja/).waitFor();
        step = "idle"; publisher = null;
        return { consent: input.publisher, enabled: input.enabled };
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
      if (input.command !== "media" || Object.keys(input).length !== 2
        || !["avatars", "first-speech", "both-speech", "first-revoked", "survivor"].includes(input.phase)) {
        throw new Error("test_multi_media_command_invalid");
      }
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
      await waitFixtureValue(page, peers => window.__multiPublisher.snapshot(peers), peers, {
        timeout: 12000, accept: state => {
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
