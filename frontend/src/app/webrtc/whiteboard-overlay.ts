import { decodeWhiteboardBytes, WhiteboardOperation } from "./whiteboard-contract";

export interface WhiteboardDelivery {
  readonly originPeerId: string;
  readonly trafficClass: string;
  readonly data: Uint8Array;
}

export const WHITEBOARD_OP_LIMIT = 256;

export function ingestWhiteboardDelivery(
  delivery: WhiteboardDelivery,
  context: Readonly<{ membershipEpoch: number; knownPeerIds: ReadonlySet<string>; seen: ReadonlySet<string> }>,
): WhiteboardOperation | null {
  if (delivery.trafficClass !== "event") return null;
  if (delivery.data.byteLength > 12 * 1024) return null;
  const operation = decodeWhiteboardBytes(delivery.data);
  if (!operation) return null;
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
): readonly WhiteboardOperation[] {
  if (ops.some((item) => item.opId === operation.opId)) return ops;
  const next = [...ops, operation];
  return Object.freeze(next.length > limit ? next.slice(next.length - limit) : next);
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
  maxOps = 64,
  maxBytes = 11 * 1024,
): readonly WhiteboardOperation[] {
  const result: WhiteboardOperation[] = [];
  let currentBytes = 100;
  for (let i = ops.length - 1; i >= 0 && result.length < maxOps; i--) {
    const op = ops[i];
    if (op.kind === "sync-request" || op.kind === "sync-response") continue;
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
