import { decodeDiagramBytes, DIAGRAM_CONSTANTS, DiagramOperation, DiagramTool } from "./diagram-contract";

export interface DiagramDelivery {
  readonly originPeerId: string;
  readonly trafficClass: string;
  readonly data: Uint8Array;
}

export interface DiagramDoc {
  readonly tool: DiagramTool;
  readonly xml: string;
  readonly revision: number;
  readonly authorPeerId: string;
}

export interface DiagramToolState {
  readonly tool: DiagramTool;
  readonly revision: number;
  readonly authorPeerId: string;
}

export interface DiagramLockEntry {
  readonly ownerPeerId: string;
  readonly expiresAt: number;
}

const BULK_KINDS = new Set(["snapshot", "sync-response"]);

export function winsDiagramLww(
  current: { revision: number; authorPeerId: string } | null | undefined,
  incoming: { revision: number; authorPeerId: string },
): boolean {
  if (!current) return true;
  if (incoming.revision !== current.revision) return incoming.revision > current.revision;
  return incoming.authorPeerId > current.authorPeerId;
}

export function diagramDocFromOperation(operation: DiagramOperation): DiagramDoc | null {
  if (operation.kind !== "snapshot" && operation.kind !== "sync-response") return null;
  return {
    tool: operation.payload["tool"] as DiagramTool,
    xml: operation.payload["xml"] as string,
    revision: operation.payload["revision"] as number,
    authorPeerId: operation.kind === "sync-response"
      ? operation.payload["docAuthor"] as string
      : operation.authorPeerId,
  };
}

export function diagramToolStateFromOperation(operation: DiagramOperation): DiagramToolState | null {
  if (operation.kind !== "tool") return null;
  return {
    tool: operation.payload["tool"] as DiagramTool,
    revision: operation.payload["revision"] as number,
    authorPeerId: operation.authorPeerId,
  };
}

export function ingestDiagramDelivery(
  delivery: DiagramDelivery,
  context: Readonly<{ membershipEpoch: number; knownPeerIds: ReadonlySet<string>; seen: ReadonlySet<string> }>,
): DiagramOperation | null {
  const bulk = delivery.trafficClass === "bulk";
  if (!bulk && delivery.trafficClass !== "event") return null;
  const operation = decodeDiagramBytes(delivery.data);
  if (!operation) return null;
  if (BULK_KINDS.has(operation.kind) !== bulk) return null;
  if (operation.membershipEpoch !== context.membershipEpoch) return null;
  if (operation.authorPeerId !== delivery.originPeerId) return null;
  if (!context.knownPeerIds.has(operation.authorPeerId)) return null;
  if (context.seen.has(operation.opId)) return null;
  return operation;
}

export function applyDiagramLock(
  locks: ReadonlyMap<string, DiagramLockEntry>,
  operation: DiagramOperation,
  now: number,
): ReadonlyMap<string, DiagramLockEntry> {
  const elementId = operation.payload["elementId"] as string;
  const locked = operation.payload["locked"] as boolean;
  const next = new Map(locks);
  const current = next.get(elementId);
  if (locked) {
    if (!current || current.ownerPeerId === operation.authorPeerId || current.expiresAt <= now) {
      next.set(elementId, { ownerPeerId: operation.authorPeerId, expiresAt: now + DIAGRAM_CONSTANTS.lockTtlMs });
    }
    return next;
  }
  if (current && current.ownerPeerId === operation.authorPeerId) next.delete(elementId);
  return next;
}

export function pruneDiagramLocks(
  locks: ReadonlyMap<string, DiagramLockEntry>,
  now: number,
): ReadonlyMap<string, DiagramLockEntry> {
  const next = new Map<string, DiagramLockEntry>();
  for (const [elementId, entry] of locks) {
    if (entry.expiresAt > now) next.set(elementId, entry);
  }
  return next;
}

export function authorizedDiagramEditorPeerIds(
  participants: readonly { peerId: string; role: string }[],
  presenterPeerId: string,
  policy: "open" | "presenter-only",
  knownPeerIds: ReadonlySet<string>,
): ReadonlySet<string> {
  if (policy === "open") return knownPeerIds;
  const set = new Set<string>();
  for (const item of participants) {
    if (item.role === "owner") set.add(item.peerId);
  }
  if (presenterPeerId && knownPeerIds.has(presenterPeerId)) set.add(presenterPeerId);
  return set;
}
