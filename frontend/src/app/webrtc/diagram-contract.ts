export type DiagramTool = "bpmn" | "drawio";
export type DiagramKind = "snapshot" | "tool" | "lock" | "sync-request" | "sync-response";

export interface DiagramOperation {
  readonly version: 1;
  readonly type: "diagram-op";
  readonly opId: string;
  readonly membershipEpoch: number;
  readonly authorPeerId: string;
  readonly kind: DiagramKind;
  readonly payload: Readonly<Record<string, unknown>>;
}

const PEER_ID = /^[a-f0-9]{16}$/;
const OP_ID = /^[a-f0-9]{32}$/;
const ELEMENT_ID = /^[A-Za-z0-9_.:-]{1,64}$/;
const TOOLS = new Set<DiagramTool>(["bpmn", "drawio"]);
const KINDS = new Set<DiagramKind>(["snapshot", "tool", "lock", "sync-request", "sync-response"]);
const MAX_XML_BYTES = 256 * 1024;
const MAX_ENCODED_BYTES = 260 * 1024;
const MAX_REVISION = 9_007_199_254_740_991;
const LOCK_TTL_MS = 60_000;

export const DIAGRAM_CONSTANTS = Object.freeze({
  maxXmlBytes: MAX_XML_BYTES,
  maxEncodedBytes: MAX_ENCODED_BYTES,
  maxRevision: MAX_REVISION,
  lockTtlMs: LOCK_TTL_MS,
});

function exact(value: unknown, fields: readonly string[]): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value as object).length === fields.length
    && fields.every((field) => Object.hasOwn(value as object, field));
}

function revision(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= MAX_REVISION;
}

function tool(value: unknown): value is DiagramTool {
  return typeof value === "string" && TOOLS.has(value as DiagramTool);
}

function xml(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  return new TextEncoder().encode(value).byteLength <= MAX_XML_BYTES;
}

export function parseDiagramOperation(value: unknown): DiagramOperation | null {
  if (!exact(value, ["version", "type", "opId", "membershipEpoch", "authorPeerId", "kind", "payload"])) return null;
  if (value["version"] !== 1 || value["type"] !== "diagram-op") return null;
  if (typeof value["opId"] !== "string" || !OP_ID.test(value["opId"])) return null;
  if (!Number.isSafeInteger(value["membershipEpoch"]) || (value["membershipEpoch"] as number) < 1) return null;
  if (typeof value["authorPeerId"] !== "string" || !PEER_ID.test(value["authorPeerId"])) return null;
  if (typeof value["kind"] !== "string" || !KINDS.has(value["kind"] as DiagramKind)) return null;
  const payload = parsePayload(value["kind"] as DiagramKind, value["payload"]);
  if (!payload) return null;
  return Object.freeze({
    version: 1,
    type: "diagram-op",
    opId: value["opId"],
    membershipEpoch: value["membershipEpoch"] as number,
    authorPeerId: value["authorPeerId"],
    kind: value["kind"] as DiagramKind,
    payload,
  });
}

function parsePayload(kind: DiagramKind, payload: unknown): Readonly<Record<string, unknown>> | null {
  if (kind === "sync-request") {
    return exact(payload, []) ? Object.freeze({}) : null;
  }
  if (kind === "tool") {
    if (!exact(payload, ["tool", "revision"]) || !tool(payload["tool"]) || !revision(payload["revision"])) return null;
    return Object.freeze({ tool: payload["tool"], revision: payload["revision"] });
  }
  if (kind === "lock") {
    if (!exact(payload, ["elementId", "locked"])) return null;
    if (typeof payload["elementId"] !== "string" || !ELEMENT_ID.test(payload["elementId"])) return null;
    if (typeof payload["locked"] !== "boolean") return null;
    return Object.freeze({ elementId: payload["elementId"], locked: payload["locked"] });
  }
  if (kind === "snapshot" || kind === "sync-response") {
    const fields = kind === "snapshot" ? ["tool", "xml", "revision"] : ["tool", "xml", "revision", "docAuthor"];
    if (!exact(payload, fields)) return null;
    if (!tool(payload["tool"]) || !xml(payload["xml"]) || !revision(payload["revision"])) return null;
    if (kind === "snapshot") {
      return Object.freeze({ tool: payload["tool"], xml: payload["xml"], revision: payload["revision"] });
    }
    if (typeof payload["docAuthor"] !== "string" || !PEER_ID.test(payload["docAuthor"])) return null;
    return Object.freeze({
      tool: payload["tool"],
      xml: payload["xml"],
      revision: payload["revision"],
      docAuthor: payload["docAuthor"],
    });
  }
  return null;
}

export function decodeDiagramBytes(data: Uint8Array): DiagramOperation | null {
  if (data.byteLength > MAX_ENCODED_BYTES) return null;
  try {
    return parseDiagramOperation(JSON.parse(new TextDecoder().decode(data)));
  } catch {
    return null;
  }
}

export function encodeDiagramOperation(operation: DiagramOperation): Uint8Array {
  const parsed = parseDiagramOperation(operation);
  if (!parsed) throw new Error("invalid_diagram_operation");
  const bytes = new TextEncoder().encode(JSON.stringify(parsed));
  if (bytes.byteLength > MAX_ENCODED_BYTES) throw new Error("invalid_diagram_operation");
  return bytes;
}
