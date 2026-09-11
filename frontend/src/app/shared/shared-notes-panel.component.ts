import {
  ChangeDetectionStrategy,
  Component,
  OnDestroy,
} from "@angular/core";
import { FormsModule } from "@angular/forms";

import { RoomSessionService } from "../webrtc/room-session.service";
import { SharedNotesService } from "../webrtc/shared-notes.service";

@Component({
  selector: "app-shared-notes-panel",
  standalone: true,
  imports: [FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="shared-notes-panel" aria-labelledby="shared-notes-heading">
      <div class="surface-heading small">
        <span class="feature-icon amber" aria-hidden="true">
          <svg viewBox="0 0 24 24">
            <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" fill="none" stroke="currentColor" stroke-width="2"/>
            <polyline points="14 2 14 8 20 8" fill="none" stroke="currentColor" stroke-width="2"/>
            <line x1="16" y1="13" x2="8" y2="13" stroke="currentColor" stroke-width="2"/>
            <line x1="16" y1="17" x2="8" y2="17" stroke="currentColor" stroke-width="2"/>
            <polyline points="10 9 9 9 8 9" stroke="currentColor" stroke-width="2"/>
          </svg>
        </span>
        <div>
          <p class="eyebrow">Data Plane</p>
          <h2 id="shared-notes-heading">Geteilte Notizen</h2>
        </div>
      </div>

      <p class="hint">
        Flüchtiges kollaboratives Textpad. Verschlüsselt über den Data-Overlay; der Server speichert keine Inhalte.
      </p>

      <div class="notes-status-row">
        <span class="notes-counter" [class.warn]="notes.charCount() > 28000" [class.error]="notes.isOverLimit()">
          {{ notes.charCount() }} / {{ notes.maxCharCount }} Zeichen
        </span>
        @if (notes.revision() > 0) {
          <span class="notes-badge">Revision {{ notes.revision() }}</span>
        }
      </div>

      <textarea
        id="shared-notes-textarea"
        class="notes-textarea"
        [value]="notes.text()"
        (input)="onInput($event)"
        [disabled]="!session.joined()"
        [attr.maxlength]="notes.maxCharCount"
        placeholder="Hier gemeinsame Notizen eingeben (Markdown unterstützt)…"
        rows="8"
        aria-label="Gemeinsame Notizen"
      ></textarea>

      <div class="notes-actions">
        <div class="export-group">
          <button
            id="notes-export-md"
            type="button"
            class="button ghost compact"
            [disabled]="!session.joined() || notes.charCount() === 0"
            (click)="notes.export('md')"
            title="Notizen als Markdown herunterladen"
          >
            Export .md
          </button>
          <button
            id="notes-export-txt"
            type="button"
            class="button ghost compact"
            [disabled]="!session.joined() || notes.charCount() === 0"
            (click)="notes.export('txt')"
            title="Notizen als Plaintext herunterladen"
          >
            Export .txt
          </button>
        </div>
        <button
          id="notes-clear"
          type="button"
          class="button ghost compact danger"
          [disabled]="!session.joined() || notes.charCount() === 0"
          (click)="clear()"
          title="Notizen für alle leeren"
        >
          Leeren
        </button>
      </div>
    </section>
  `,
  styles: [`
    .shared-notes-panel { display: grid; gap: .55rem; }
    .notes-status-row { display: flex; justify-content: space-between; align-items: center; font-size: .8rem; }
    .notes-counter { color: var(--muted); font-feature-settings: "tnum"; }
    .notes-counter.warn { color: #f59e0b; }
    .notes-counter.error { color: #ef4444; font-weight: bold; }
    .notes-badge { background: rgba(56, 189, 248, 0.15); color: #38bdf8; border: 1px solid rgba(56, 189, 248, 0.3); border-radius: .3rem; padding: .1rem .35rem; font-size: .75rem; }
    .notes-textarea {
      width: 100%;
      box-sizing: border-box;
      resize: vertical;
      min-height: 120px;
      padding: .6rem;
      border-radius: .4rem;
      border: 1px solid var(--border, rgba(255, 255, 255, 0.1));
      background: var(--surface-subtle, rgba(0, 0, 0, 0.2));
      color: inherit;
      font-family: monospace;
      font-size: .85rem;
      line-height: 1.4;
    }
    .notes-textarea:focus { outline: 2px solid var(--accent, #38bdf8); }
    .notes-actions { display: flex; justify-content: space-between; align-items: center; gap: .5rem; }
    .export-group { display: flex; gap: .4rem; }
    .danger { color: #ef4444; }
  `],
})
export class SharedNotesPanelComponent implements OnDestroy {
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    readonly notes: SharedNotesService,
    readonly session: RoomSessionService,
  ) {}

  onInput(event: Event): void {
    const value = (event.target as HTMLTextAreaElement).value;
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.notes.updateText(value);
      this.debounceTimer = null;
    }, 250);
  }

  clear(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.notes.clearNotes();
  }

  ngOnDestroy(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }
}
