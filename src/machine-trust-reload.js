import { isAbsolute } from "node:path";
import { readMachineTrustFile } from "./machine-trust-file.js";

export function machineTrustReloadFile(env) {
  const mode = env.MACHINE_HUB_TRUST_RELOAD ?? "disabled";
  if (mode === "disabled") return "";
  const file = env.MACHINE_HUB_TRUST_PROFILE_JSON_FILE;
  if (mode !== "signal" || typeof file !== "string" || !isAbsolute(file) || file.length > 4096
    || file.includes("\0") || env.MACHINE_HUB_TRUST_PROFILE_JSON || env.MACHINE_HUB_PUBLIC_KEY
    || env.MACHINE_HUB_PUBLIC_KEY_FILE || env.MACHINE_HUB_ISSUER) throw new Error("machine_trust_reload_config_invalid");
  return file;
}

/** Operator-owned local file only. No request input, watcher or network discovery. */
export function createMachineTrustReload({ file, profile, admission, sessions, read = readMachineTrustFile }) {
  if (!file) return null;
  if (!profile || typeof file !== "string" || !isAbsolute(file) || file.length > 4096 || file.includes("\0")) {
    throw new Error("machine_trust_reload_config_invalid");
  }
  return () => {
    let status;
    try { status = admission.replaceTrustProfile(read(file)) ? "updated" : "unchanged"; }
    catch { admission.suspendTrust(); status = "blocked"; }
    // Re-evaluate pending tickets and attached machines before returning the ACK.
    sessions.prune();
    return Object.freeze({ schema: "ananta.meet-trust-reload.v1", status });
  };
}

export function bindMachineTrustReload(app, signals = process, report = value => console.info(JSON.stringify(value))) {
  if (!app.reloadMachineTrust) return;
  const reload = () => { const result = app.reloadMachineTrust(); report(result); };
  signals.on("SIGHUP", reload);
  app.server.once("close", () => signals.removeListener("SIGHUP", reload));
}
