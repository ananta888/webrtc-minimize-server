import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { chromium } from "playwright";

test("keyboard activation needs an explicit enabled-state barrier unlike a native checkbox's checked state", { timeout: 15_000 }, async t => {
  if (!fs.existsSync(chromium.executablePath())) { t.skip("Install Playwright Chromium for the keyboard readiness fixture"); return; }
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent('<input id="choice" type="checkbox"><button id="save" disabled type="button">Save</button>');
  await page.evaluate(() => {
    window.fixtureCommits = 0;
    document.querySelector("#save").addEventListener("click", () => window.fixtureCommits++);
  });
  await page.locator("#choice").focus(); await page.locator("#choice").press("Space");
  assert.equal(await page.locator("#choice").isChecked(), true);
  await page.locator("#save").focus(); await page.locator("#save").press("Enter");
  assert.equal(await page.evaluate(() => window.fixtureCommits), 0, "press does not wait for the disabled button to become enabled");
  await page.evaluate(() => { document.querySelector("#save").disabled = false; });
  const ready = page.locator("#save:not([disabled])");
  await ready.waitFor({ state: "visible" }); await ready.focus(); await ready.press("Enter");
  assert.equal(await page.evaluate(() => window.fixtureCommits), 1);
});
