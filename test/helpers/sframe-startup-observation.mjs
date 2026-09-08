import { transformFailureCounts } from "./machine-transform-observation.mjs";

// Serialized as a browser init script. No media, context IDs or key messages
// enter the diagnostic buffer, and normal Worker events are not intercepted.
export function installSFrameStartupObservation() {
  const codes = ["media_frame_type", "media_codec_unsupported", "media_frame_too_short",
    "media_envelope_version", "media_key_budget_exhausted"];
  globalThis.__sframeStartupErrors = [];
  const record = code => {
    if (globalThis.__sframeStartupErrors.length < 129) globalThis.__sframeStartupErrors.push(code);
  };
  const Native = globalThis.Worker;
  if (typeof Native !== "function") return;
  globalThis.Worker = new Proxy(Native, { construct(Target, args) {
    const worker = Reflect.construct(Target, args);
    if (args[1]?.name === "sframe-media") {
      worker.addEventListener("message", ({ data }) => {
        if (data?.type === "transform-error") record(codes.includes(data.code) ? data.code : "unknown");
      });
      worker.addEventListener("error", () => record("worker_load_or_runtime_error"));
    }
    return worker;
  } });
}

// Serialized callback: exact numeric fields only; at most two connections and
// eight RTP rows. The outer Node deadline bounds a stuck renderer/getStats.
export async function sframeStartupSnapshot() {
  const label = document.querySelector("#sframe-status")?.textContent?.trim();
  const state = ["disabled", "unsupported", "pending", "active"].includes(label) ? label : "unknown";
  const result = { state, errors: globalThis.__sframeStartupErrors, connections: [] };
  for (const pc of (globalThis.__peerConnections || []).slice(0, 2)) {
    const entry = { connected: pc.connectionState === "connected", rtp: [] };
    for (const row of (await pc.getStats()).values()) {
      if (row.type !== "inbound-rtp" && row.type !== "outbound-rtp") continue;
      if (entry.rtp.length === 8) break;
      const item = { inbound: row.type === "inbound-rtp" };
      for (const key of ["framesDecoded", "framesEncoded", "framesReceived", "framesSent", "keyFramesDecoded",
        "keyFramesEncoded", "packetsReceived", "packetsSent", "pliCount", "firCount", "nackCount"]) {
        if (Number.isSafeInteger(row[key]) && row[key] >= 0) item[key] = row[key];
      }
      entry.rtp.push(item);
    }
    result.connections.push(entry);
  }
  return result;
}

export async function collectSFrameStartup(page, timeoutMs = 1000) {
  let timer;
  try {
    const snapshot = await Promise.race([page.evaluate(sframeStartupSnapshot),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error()), timeoutMs); })]);
    const { errors, ...status } = snapshot;
    return { available: true, ...status, transforms: transformFailureCounts(errors) };
  } catch { return { available: false }; }
  finally { clearTimeout(timer); }
}
