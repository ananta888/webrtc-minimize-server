import { ReceiveQualityProfile, isReceiveQualityProfile } from "./receive-quality-policy";

export const MAX_CHAT_BYTES = 8_192;
export const MAX_CONTROL_BYTES = 2_048;
export const CHAT_BUFFER_LIMIT = 256_000;
export const CONTROL_BUFFER_LIMIT = 32_000;

export type PeerControlMessage = Readonly<
  | { version: 1; type: "activity"; sequence: number; level: number }
  | { version: 1; type: "quality"; sequence: number; linkClass: "unknown" | "good" | "constrained" | "critical" }
  | { version: 1; type: "receive-quality"; sequence: number; profile: ReceiveQualityProfile }
>;

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
