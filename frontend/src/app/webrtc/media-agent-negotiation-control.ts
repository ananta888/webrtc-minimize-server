export const MEDIA_AGENT_NEGOTIATION_CONTROL_MAX_BYTES = 256;

export type MediaAgentNegotiationControl = Readonly<{
  version: 1;
  type: "media-agent-negotiation-request" | "media-agent-negotiation-grant";
  routeEpoch: number;
  sequence: number;
}>;

function exact(value: Record<string, unknown>, fields: readonly string[]): boolean {
  return Object.keys(value).length === fields.length
    && fields.every((field) => Object.hasOwn(value, field));
}

export function parseMediaAgentNegotiationControl(raw: string): MediaAgentNegotiationControl | null {
  if (new TextEncoder().encode(raw).byteLength > MEDIA_AGENT_NEGOTIATION_CONTROL_MAX_BYTES) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return null; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const value = parsed as Record<string, unknown>;
  if (!exact(value, ["version", "type", "routeEpoch", "sequence"])
    || value["version"] !== 1
    || !new Set(["media-agent-negotiation-request", "media-agent-negotiation-grant"])
      .has(String(value["type"] || ""))
    || !Number.isSafeInteger(value["routeEpoch"]) || Number(value["routeEpoch"]) < 1
    || !Number.isSafeInteger(value["sequence"]) || Number(value["sequence"]) < 1) return null;
  return Object.freeze({
    version: 1,
    type: value["type"] as MediaAgentNegotiationControl["type"],
    routeEpoch: Number(value["routeEpoch"]),
    sequence: Number(value["sequence"]),
  });
}

export function encodeMediaAgentNegotiationControl(message: MediaAgentNegotiationControl): string {
  const encoded = JSON.stringify(message);
  if (!parseMediaAgentNegotiationControl(encoded)) throw new Error("invalid_media_agent_negotiation_control");
  return encoded;
}
