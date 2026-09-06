export interface MachinePeerChat {
  readonly version: 2; readonly type: "chat"; readonly roomId: string; readonly membershipEpoch: number;
  readonly messageId: string; readonly replyTo: string; readonly sentAt: number; readonly text: string;
}
export interface MachineChatEvent {
  readonly schema: "ananta.meet-chat-event.draft1"; readonly session_id: string; readonly generation: number;
  readonly room_id: string; readonly membership_epoch: number; readonly message_id: string;
  readonly sender_peer_id: string; readonly sender_kind: "human" | "machine" | "unknown";
  readonly sent_at_ms: number; readonly text: string;
}
export interface MachineChatScope {
  readonly origin: string; readonly tenant_id: string; readonly project_id: string; readonly task_id: string;
  readonly session_id: string; readonly runtime_id: string; readonly lease_id: string; readonly generation: number;
  readonly room_id: string; readonly membership_epoch: number; readonly policy_revision: number;
  readonly own_peer_id: string; readonly deadline_ms: number;
}
export const MACHINE_CHAT_SCHEMA: "ananta.meet-chat-event.draft1";
export const MACHINE_CHAT_LIMITS: Readonly<{ eventBytes: number; textBytes: number; textCharacters: number;
  ageMs: number; futureMs: number; queueEvents: number; batchEvents: number; queueBytes: number; dedupEntries: number }>;
export function parseMachineChatEvent(raw: unknown): MachineChatEvent;
export function parseMachinePeerChat(raw: unknown): MachinePeerChat;
export function validateMachineChatScope(value: unknown): MachineChatScope;
