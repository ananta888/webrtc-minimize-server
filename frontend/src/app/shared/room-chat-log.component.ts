import { ChangeDetectionStrategy, Component, Input } from "@angular/core";

/** Display data only. Membership classification is owned by PeerMeshService. */
export interface RoomChatEntry {
  readonly id: number;
  readonly author: string;
  readonly text: string;
  readonly system: boolean;
  readonly machine?: boolean;
  readonly replyTo?: string;
}

export function machineChatMessage(entry: RoomChatEntry): boolean {
  return entry.system === false && entry.machine === true;
}

export function chatReplyReference(entry: RoomChatEntry): boolean {
  return entry.system === false && typeof entry.replyTo === "string" && /^[a-f0-9]{32}$/.test(entry.replyTo);
}

@Component({
  selector: "app-room-chat-log", standalone: true, changeDetection: ChangeDetectionStrategy.OnPush,
  template: `@for (entry of entries; track entry.id) {
    <div class="chat-entry" [class.system]="entry.system" [attr.data-machine-message]="isMachine(entry) ? 'true' : null">
      <div class="chat-author"><strong>{{ entry.author }}</strong>
        @if (isMachine(entry)) { <span class="chat-kind" title="Nachricht eines als Maschine zugelassenen Teilnehmers">KI-Nachricht</span> }
        @if (hasReply(entry)) { <span class="chat-reference" title="Vom Absender angegebener Bezug auf einen Chatbeitrag; keine Bestätigung der inhaltlichen Verarbeitung">Antwort</span> }
      </div>
      <span>{{ entry.text }}</span>
    </div>
  } @empty {
    @if (showEmpty) { <div class="list-empty"><span aria-hidden="true">···</span><strong>Noch keine Nachrichten</strong><p>Nach dem Beitritt verbindet sich der Peer-Chat automatisch.</p></div> }
  }`,
  styles: [`.chat-author { display: flex; flex-wrap: wrap; align-items: baseline; gap: .45rem; }
    .chat-entry .chat-kind { border: 1px solid currentColor; border-radius: .3rem; padding: 0 .3rem; font-size: .66rem; color: #d8c9ff; }
    .chat-entry .chat-reference { color: var(--muted); font-size: .68rem; }`],
})
export class RoomChatLogComponent {
  @Input() entries: readonly RoomChatEntry[] = [];
  @Input() showEmpty = false;
  readonly isMachine = machineChatMessage;
  readonly hasReply = chatReplyReference;
}
