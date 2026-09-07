import assert from "node:assert/strict";
import fs from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";

const validate = new Ajv2020({ strict: true }).compile(JSON.parse(fs.readFileSync(
  new URL("../contracts/native-packager/standby-control.v1.schema.json", import.meta.url), "utf8")));

export function verifyStandbySnapshot(value, previous, programId, expectedIds) {
  assert.ok(validate(value), "invalid standby control response");
  assert.equal(value.programId === programId, true, "standby program scope changed");
  assert.equal(JSON.stringify(value.standbyPackagerIds) === JSON.stringify(expectedIds), true, "standby selection was not committed");
  if (previous) {
    assert.equal(value.programEpoch, previous.programEpoch, "standby must not change the program epoch");
    assert.equal(value.programRevision, previous.programRevision, "standby must not change the program revision");
    assert.equal(value.standbyRevision, previous.standbyRevision + 1, "standby CAS revision did not advance exactly once");
  }
  return value;
}

async function commitStandbySelection(owner, programId, origin) {
  const button = owner.locator("#broadcast-standby-save:not([disabled])");
  // Keyboard press does not have click's enabled-state auto-wait. Angular may
  // render the enabled button after the checkbox's native checked state changes.
  await button.waitFor({ state: "visible", timeout: 5_000 });
  const matches = request => request.method() === "PUT" && new URL(request.url()).origin === origin
    && new URL(request.url()).pathname === `/api/broadcasts/${programId}/native-standbys`;
  let requestObserved = false, dialogObserved = false, transport = "none";
  const requested = request => { if (matches(request)) requestObserved = true; };
  const failed = request => {
    if (!matches(request)) return;
    const code = request.failure()?.errorText;
    transport = ["net::ERR_NETWORK_CHANGED", "net::ERR_ABORTED", "net::ERR_FAILED", "net::ERR_CONNECTION_CLOSED"].includes(code)
      ? code : "unclassified";
  };
  const confirm = dialog => { dialogObserved = true; return dialog.accept(); };
  owner.on("request", requested); owner.on("requestfailed", failed);
  const saved = owner.waitForResponse(response => matches(response.request()), { timeout: 30_000 });
  void saved.catch(() => undefined);
  try {
    owner.once("dialog", confirm);
    await button.focus(); await button.press("Enter");
    return await saved;
  } catch {
    const raw = await owner.locator("#broadcast-standby-error").allTextContents().catch(() => []);
    const codes = raw.flatMap(text => text.match(/\b(?:native|invalid|stale)_[a-z0-9_-]{1,80}\b/g) || []).slice(0, 3);
    throw new Error(`native_standby_commit_unobserved:request=${requestObserved}:dialog=${dialogObserved}:transport=${transport}:ui=${codes.join(",") || "none"}`);
  } finally {
    owner.off("request", requested); owner.off("requestfailed", failed); owner.off("dialog", confirm);
  }
}

export async function verifyProductionStandby({ owner, targetId, programCreates, report = console.log }) {
  assert.match(targetId, /^pkr_[A-Za-z0-9_-]{16,64}$/);
  const origin = new URL(owner.url()).origin;
  const baseline = await owner.evaluate(() => ({ capture: [...window.__captureCalls],
    connections: window.__broadcastGateConnections.length }));
  const creates = programCreates();
  const read = owner.waitForResponse(response => response.request().method() === "POST"
    && new URL(response.url()).origin === origin
    && /^\/api\/broadcasts\/prg_[A-Za-z0-9_-]{16,64}\/native-standby-control$/.test(new URL(response.url()).pathname), { timeout: 30_000 });
  void read.catch(() => undefined);
  await owner.locator("#broadcast-standby-load").focus();
  await owner.locator("#broadcast-standby-load").press("Enter");
  const response = await read;
  assert.equal(response.status(), 200, "standby read failed");
  const programId = new URL(response.url()).pathname.split("/")[3];
  let current = verifyStandbySnapshot(await response.json(), null, programId, []);
  for (const selected of [true, false, true]) {
    const checkbox = owner.locator(`[data-standby-id="${targetId}"]`);
    await checkbox.focus(); await checkbox.press("Space");
    assert.equal(await checkbox.isChecked(), selected, "keyboard checkbox selection failed");
    const committed = await commitStandbySelection(owner, programId, origin);
    assert.equal(committed.status(), 200, "standby save failed");
    current = verifyStandbySnapshot(await committed.json(), current, programId, selected ? [targetId] : []);
    await owner.locator("#broadcast-standby-status").filter({ hasText: `Serverstand ${current.standbyRevision}:` }).waitFor();
  }
  assert.equal(programCreates(), creates, "standby must not create a program");
  assert.deepEqual(await owner.evaluate(() => ({ capture: [...window.__captureCalls],
    connections: window.__broadcastGateConnections.length })), baseline,
    "standby selection must not capture or establish a publication connection");
  report("PASS production standby keyboard selection: set, remove, set; same program and no capture or connection changes");
}
