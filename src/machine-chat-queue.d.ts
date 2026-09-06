import { MachineChatScope, MachineChatEvent } from "./machine-chat-contract.js";
export interface MachineChatAuthority { readonly chatRead: boolean; readonly chatSend: boolean; readonly scope: MachineChatScope }
export interface MachineChatBatch {
  readonly schema: "ananta.meet-chat-batch.draft1"; readonly acknowledged: number;
  readonly events: readonly Readonly<{ cursor: number; event: MachineChatEvent }>[];
}
export class MachineChatQueue {
  constructor(ports: { authority: () => MachineChatAuthority | null; clock?: () => number });
  push(raw: unknown): boolean;
  poll(): MachineChatBatch;
  ack(cursor: number): void;
  check(): void;
  close(): void;
}
