import fs from "node:fs/promises";
import path from "node:path";

const marker = "\tclient := &client{cfg: cfg, identity: identity, capability: capability, api: api}";
export function instrumentSceneMain(source, observer) {
  if (source.split(marker).length !== 2 || source.includes("observeSceneFixture(")
    || !observer.includes("func observeSceneFixture(")) throw new Error("scene_observer_overlay_shape");
  return source.replace(marker, `${marker}\n\tobserveSceneFixture(ctx, client)`) + observer;
}

export function instrumentSceneClock(source) {
  const expiry = "\t\tc.failLocked(3)", report = "func (c *sourceMediaClock) SourceSenderReport(report sourceSenderReport) error {";
  if (source.split(expiry).length !== 2 || source.split(report).length !== 2 || source.includes("observeSceneClock")) {
    throw new Error("scene_clock_observer_overlay_shape");
  }
  return source.replace(expiry, `\t\tobserveSceneClockExpiry(c, now, deadline)\n${expiry}`)
    .replace(report, `${report}\n\tobserveSceneClockOffered(c)`);
}

export async function sceneObserverOverlay(module, directory, localGo) {
  const source = await fs.readFile(path.join(module, "main.go"), "utf8");
  const clock = await fs.readFile(path.join(module, "source_clock.go"), "utf8");
  const observer = await fs.readFile(new URL("./native-scene-observer.go.txt", import.meta.url), "utf8");
  const main = path.join(directory, "observed-main.go"), overlay = path.join(directory, "observer-overlay.json");
  await fs.writeFile(main, instrumentSceneMain(source, observer), { mode: 0o600, flag: "wx" });
  const observedClock = path.join(directory, "observed-clock.go");
  await fs.writeFile(observedClock, instrumentSceneClock(clock), { mode: 0o600, flag: "wx" });
  await fs.writeFile(overlay, JSON.stringify({ Replace: {
    [localGo ? path.join(module, "main.go") : "/src/main.go"]: localGo ? main : "/out/observed-main.go",
    [localGo ? path.join(module, "source_clock.go") : "/src/source_clock.go"]:
      localGo ? observedClock : "/out/observed-clock.go",
  } }), { mode: 0o600, flag: "wx" });
  return localGo ? overlay : "/out/observer-overlay.json";
}

/** Deterministic synthetic expiry tests use the same private overlay hooks. */
export async function sceneClockExpiryProbeOverlay(module, directory, localGo) {
  const result = await sceneObserverOverlay(module, directory, localGo);
  const probe = path.join(directory, "expiry-probe_test.go"), overlay = path.join(directory, "observer-overlay.json");
  const source = await fs.readFile(new URL("./native-scene-clock-expiry-probe.go.txt", import.meta.url), "utf8");
  await fs.writeFile(probe, source, { mode: 0o600, flag: "wx" });
  const value = JSON.parse(await fs.readFile(overlay, "utf8"));
  value.Replace[localGo ? path.join(module, "expiry_probe_test.go") : "/src/expiry_probe_test.go"] =
    localGo ? probe : "/out/expiry-probe_test.go";
  await fs.writeFile(overlay, JSON.stringify(value));
  return result;
}

const booleans = ["lazyAvailable", "closed", "observed", "pending", "decoder", "needKey", "waitingClock",
  "clockAvailable", "clockClosed", "clockBound", "uncertain", "decoderAvailable", "decoderClosed", "decoderStarted",
  "mixerAvailable", "mixerClosed", "mixerStarted", "current"];
const bounds = { reports: 65535, clockFailure: 7, queued: 2, timestamps: 8, pendingFrames: 8 };
const expiryBooleans = ["clockExpiryAvailable", "clockReportExpired", "clockQuarantineExpired"];
const expiryBounds = { clockAcceptedAtExpiry: 65535, clockOfferedReports: 65535 };
const exactKeys = (value, keys) => value && typeof value === "object" && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
export function parseSceneObservation(line) {
  if (typeof line !== "string" || Buffer.byteLength(line) > 65536) return null;
  try {
    const value = JSON.parse(line);
    if (!exactKeys(value, ["fixture", "available", "programClosed", "sources"])
      || !["source-state-v1", "source-state-v2"].includes(value.fixture)
      || typeof value.available !== "boolean" || typeof value.programClosed !== "boolean"
      || !Array.isArray(value.sources) || value.sources.length > 80) return null;
    for (const row of value.sources) {
      const flags = value.fixture === "source-state-v2" ? [...booleans, ...expiryBooleans] : booleans;
      const limits = value.fixture === "source-state-v2" ? { ...bounds, ...expiryBounds } : bounds;
      if (!exactKeys(row, ["kind", ...flags, ...Object.keys(limits)])
        || !["unknown", "camera", "screen", "microphone", "screen-audio"].includes(row.kind)
        || !flags.every(key => typeof row[key] === "boolean")
        || !Object.entries(limits).every(([key, max]) => Number.isSafeInteger(row[key]) && row[key] >= 0 && row[key] <= max)) return null;
    }
    return value;
  } catch { return null; }
}

// Only stdout from the owned, explicitly instrumented binary. Never stderr,
// logs, arbitrary objects or unsolicited lines. At most two bounded requests.
export function sceneProcessObserver(child, timeoutMs = 1000) {
  let attempts = 0, pending = null, buffer = "", bytes = 0;
  const fail = () => { attempts = 2; pending?.(null); };
  child.once("close", fail);
  child.stdout.on("error", fail);
  child.stdout.on("data", chunk => {
    if (!pending) return;
    bytes += chunk.length;
    if (bytes > 65536) { fail(); return; }
    buffer += chunk.toString("utf8");
    const end = buffer.indexOf("\n");
    if (end < 0) return;
    const parsed = parseSceneObservation(buffer.slice(0, end));
    if (!parsed || buffer.slice(end + 1).trim()) { fail(); return; }
    pending(parsed);
  });
  return () => {
    if (attempts >= 2 || pending) return Promise.resolve(null);
    attempts++;
    return new Promise(resolve => {
      buffer = ""; bytes = 0;
      const timer = setTimeout(() => { attempts = 2; fail(); }, timeoutMs);
      pending = value => { clearTimeout(timer); pending = null; buffer = ""; resolve(value); };
      try { if (!child.kill("SIGUSR1")) { attempts = 2; fail(); } }
      catch { attempts = 2; fail(); }
    });
  };
}
