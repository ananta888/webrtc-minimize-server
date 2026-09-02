import { ReceiveQualityProfile, isReceiveQualityProfile } from "./receive-quality-policy";

export const MAX_CHAT_BYTES = 8_192;
export const MAX_CONTROL_BYTES = 4_096;
export const CHAT_BUFFER_LIMIT = 256_000;
export const CONTROL_BUFFER_LIMIT = 32_000;
export const MAX_MESH_TELEMETRY_LINKS = 22;

const PEER_ID = /^[a-f0-9]{16}$/;
const AGENT_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
const MAX_MESH_BITRATE_BPS = 1_000_000_000;

export type MeshTelemetryRates = readonly [
  outgoingBps: number,
  incomingBps: number,
  audioOutgoingBps: number,
  audioIncomingBps: number,
  videoOutgoingBps: number,
  videoIncomingBps: number,
  screenOutgoingBps: number,
  screenIncomingBps: number,
  dataOutgoingBps: number,
  dataIncomingBps: number,
];

export interface MeshTelemetryMessage {
  readonly version: 1;
  readonly type: "mesh-telemetry";
  readonly sequence: number;
  readonly links: readonly Readonly<{
    targetKind: "peer" | "media-agent";
    targetId: string;
    rates: MeshTelemetryRates;
  }>[];
}

export type PeerControlMessage = Readonly<
  | { version: 1; type: "activity"; sequence: number; level: number }
  | { version: 1; type: "quality"; sequence: number; linkClass: "unknown" | "good" | "constrained" | "critical" }
  | { version: 1; type: "receive-quality"; sequence: number; profile: ReceiveQualityProfile }
  | { version: 1; type: "mesh-analysis-interest"; sequence: number; active: boolean }
  | MeshTelemetryMessage
>;

function parseMeshTelemetry(value: Record<string, unknown>, sequence: number): MeshTelemetryMessage | null {
  if (Object.keys(value).length !== 4
    || !["version", "type", "sequence", "links"].every((field) => Object.hasOwn(value, field))
    || !Array.isArray(value["links"]) || value["links"].length > MAX_MESH_TELEMETRY_LINKS) return null;
  const links: MeshTelemetryMessage["links"][number][] = [];
  const targets = new Set<string>();
  for (const rawLink of value["links"]) {
    if (!rawLink || typeof rawLink !== "object" || Array.isArray(rawLink)) return null;
    const link = rawLink as Record<string, unknown>;
    const targetKind = link["targetKind"];
    const targetId = String(link["targetId"] || "");
    const rates = link["rates"];
    if (Object.keys(link).length !== 3
      || !["targetKind", "targetId", "rates"].every((field) => Object.hasOwn(link, field))
      || (targetKind !== "peer" && targetKind !== "media-agent")
      || (targetKind === "peer" ? !PEER_ID.test(targetId) : !AGENT_ID.test(targetId))
      || !Array.isArray(rates) || rates.length !== 10
      || rates.some((rate) => !Number.isSafeInteger(rate) || rate < 0 || rate > MAX_MESH_BITRATE_BPS)
      || Number(rates[2]) + Number(rates[4]) + Number(rates[6]) + Number(rates[8]) > Number(rates[0])
      || Number(rates[3]) + Number(rates[5]) + Number(rates[7]) + Number(rates[9]) > Number(rates[1])
      || targets.has(`${targetKind}:${targetId}`)) return null;
    targets.add(`${targetKind}:${targetId}`);
    links.push(Object.freeze({
      targetKind,
      targetId,
      rates: Object.freeze([...rates]) as unknown as MeshTelemetryRates,
    }));
  }
  return Object.freeze({ version: 1, type: "mesh-telemetry", sequence, links: Object.freeze(links) });
}

export function parsePeerControl(raw: unknown): PeerControlMessage | null {
  if (typeof raw !== "string" || new TextEncoder().encode(raw).byteLength > MAX_CONTROL_BYTES) return null;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (value["version"] !== 1 || !Number.isSafeInteger(value["sequence"])) return null;
    const sequence = Number(value["sequence"]);
    if (sequence < 0 || sequence > Number.MAX_SAFE_INTEGER) return null;
    if (value["type"] === "activity") {
      if (Object.keys(value).some((key) => !new Set(["version", "type", "sequence", "level"]).has(key))) return null;
      const level = Number(value["level"]);
      if (!Number.isFinite(level) || level < 0 || level > 1) return null;
      return { version: 1, type: "activity", sequence, level };
    }
    if (value["type"] === "receive-quality") {
      if (Object.keys(value).some((key) => !new Set(["version", "type", "sequence", "profile"]).has(key))) return null;
      if (!isReceiveQualityProfile(value["profile"])) return null;
      return { version: 1, type: "receive-quality", sequence, profile: value["profile"] };
    }
    if (value["type"] === "mesh-analysis-interest") {
      if (Object.keys(value).some((key) => !new Set(["version", "type", "sequence", "active"]).has(key))
        || typeof value["active"] !== "boolean") return null;
      return { version: 1, type: "mesh-analysis-interest", sequence, active: value["active"] };
    }
    if (value["type"] === "mesh-telemetry") return parseMeshTelemetry(value, sequence);
    const linkClass = String(value["linkClass"]);
    if (value["type"] === "quality" && new Set(["unknown", "good", "constrained", "critical"]).has(linkClass)) {
      if (Object.keys(value).some((key) => !new Set(["version", "type", "sequence", "linkClass"]).has(key))) return null;
      return { version: 1, type: "quality", sequence, linkClass } as PeerControlMessage;
    }
  } catch { /* invalid peer control */ }
  return null;
}

export function parsePeerChat(raw: unknown): Readonly<{ version: 1; type: "chat"; text: string }> | null {
  if (typeof raw !== "string" || new TextEncoder().encode(raw).byteLength > MAX_CHAT_BYTES) return null;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (Object.keys(value).some((key) => !new Set(["version", "type", "text"]).has(key))) return null;
    if (value["version"] !== 1 || value["type"] !== "chat" || typeof value["text"] !== "string") return null;
    if (!value["text"].trim() || value["text"].length > 2_000) return null;
    return { version: 1, type: "chat", text: value["text"] };
  } catch { /* invalid peer chat */ }
  return null;
}
