import { decodeWhiteboardBytes, WhiteboardOperation } from "./whiteboard-contract";

export interface WhiteboardDelivery {
  readonly originPeerId: string;
  readonly trafficClass: string;
  readonly data: Uint8Array;
}

export const WHITEBOARD_OP_LIMIT = 2048;
export const WHITEBOARD_HISTORY_BYTES = 500 * 1024;
export const WHITEBOARD_OP_MAX_BYTES = 12 * 1024;
export const WHITEBOARD_SYNC_MAX_BYTES = 512 * 1024;

export function ingestWhiteboardDelivery(
  delivery: WhiteboardDelivery,
  context: Readonly<{ membershipEpoch: number; knownPeerIds: ReadonlySet<string>; seen: ReadonlySet<string> }>,
): WhiteboardOperation | null {
  const bulk = delivery.trafficClass === "bulk";
  if (!bulk && delivery.trafficClass !== "event") return null;
  const operation = decodeWhiteboardBytes(delivery.data);
  if (!operation) return null;
  const syncResponse = operation.kind === "sync-response";
  if (syncResponse) {
    if (delivery.data.byteLength > WHITEBOARD_SYNC_MAX_BYTES) return null;
  } else {
    if (bulk) return null;
    if (delivery.data.byteLength > WHITEBOARD_OP_MAX_BYTES) return null;
  }
  if (operation.membershipEpoch !== context.membershipEpoch) return null;
  if (operation.authorPeerId !== delivery.originPeerId) return null;
  if (!context.knownPeerIds.has(operation.authorPeerId)) return null;
  if (context.seen.has(operation.opId)) return null;
  return operation;
}

export function appendWhiteboardOperation(
  ops: readonly WhiteboardOperation[],
  operation: WhiteboardOperation,
  limit = WHITEBOARD_OP_LIMIT,
  maxBytes = WHITEBOARD_HISTORY_BYTES,
): readonly WhiteboardOperation[] {
  if (operation.kind === "laser") return ops;
  if (ops.some((item) => item.opId === operation.opId)) return ops;
  let next = [...ops, operation];
  if (next.length > limit) next = next.slice(next.length - limit);
  let bytes = JSON.stringify(next).length;
  while (next.length > 1 && bytes > maxBytes) {
    bytes -= JSON.stringify(next[0]).length;
    next = next.slice(1);
  }
  return Object.freeze(next);
}

export function undoOwnWhiteboardOperations(
  ops: readonly WhiteboardOperation[],
  ownPeerId: string,
): readonly WhiteboardOperation[] {
  const next = [...ops];
  while (next.length > 0 && next[next.length - 1].authorPeerId === ownPeerId) {
    const last = next.pop()!;
    if (
      last.kind === "stroke-begin" ||
      last.kind === "erase" ||
      last.kind === "clear" ||
      last.kind === "shape" ||
      last.kind === "text"
    ) {
      break;
    }
  }
  return Object.freeze(next);
}

export function boundSyncOps(
  ops: readonly WhiteboardOperation[],
  maxOps = WHITEBOARD_OP_LIMIT,
  maxBytes = WHITEBOARD_HISTORY_BYTES,
): readonly WhiteboardOperation[] {
  const result: WhiteboardOperation[] = [];
  let currentBytes = 100;
  for (let i = ops.length - 1; i >= 0 && result.length < maxOps; i--) {
    const op = ops[i];
    if (op.kind === "sync-request" || op.kind === "sync-response" || op.kind === "laser") continue;
    const opBytes = JSON.stringify(op).length;
    if (currentBytes + opBytes > maxBytes) break;
    result.unshift(op);
    currentBytes += opBytes;
  }
  return Object.freeze(result);
}



export function ownerPeerIds(participants: readonly { peerId: string; role: string }[]): ReadonlySet<string> {
  return new Set(participants.filter((item) => item.role === "owner").map((item) => item.peerId));
}

export function authorizedDrawerPeerIds(
  participants: readonly { peerId: string; role: string }[],
  presenterPeerId: string,
  policy: "open" | "presenter-only",
  knownPeerIds: ReadonlySet<string>,
): ReadonlySet<string> {
  if (policy === "open") return knownPeerIds;
  const set = new Set<string>();
  for (const p of participants) {
    if (p.role === "owner") set.add(p.peerId);
  }
  if (presenterPeerId && knownPeerIds.has(presenterPeerId)) set.add(presenterPeerId);
  return set;
}

export function authorizedClearPeerIds(
  participants: readonly { peerId: string; role: string }[],
  presenterPeerId: string,
): ReadonlySet<string> {
  const set = new Set(participants.filter((item) => item.role === "owner").map((item) => item.peerId));
  if (presenterPeerId) set.add(presenterPeerId);
  return set;
}

