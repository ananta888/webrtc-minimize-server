import { ChangeDetectionStrategy, Component, signal } from "@angular/core";
import { FormsModule } from "@angular/forms";

import { POLL_CONSTANTS } from "../webrtc/poll-contract";
import { PollService } from "../webrtc/poll.service";
import { RoomSessionService } from "../webrtc/room-session.service";

@Component({
  selector: "app-poll-panel",
  standalone: true,
  imports: [FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="poll-panel" aria-labelledby="poll-heading">
      <div class="surface-heading small">
        <span class="feature-icon violet" aria-hidden="true">
          <svg viewBox="0 0 24 24">
            <path d="M18 20V10M12 20V4M6 20v-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
          </svg>
        </span>
        <div>
          <p class="eyebrow">Data Plane</p>
          <h2 id="poll-heading">Umfragen</h2>
        </div>
      </div>

      <p class="hint">
        Flüchtige Abstimmungen zwischen Browsern. Verschlüsselt über den Data-Overlay; der Server sieht oder speichert keine Antworten.
      </p>

      @if (poll.status() === 'none') {
        @if (poll.canCreatePoll()) {
          <div class="poll-create-box">
            <label class="field-label">Frage
              <input
                id="poll-question-input"
                type="text"
                class="poll-input"
                maxlength="120"
                placeholder="Frage formulieren (max. 120 Zeichen)…"
                [ngModel]="questionInput()"
                (ngModelChange)="questionInput.set($event)"
              />
            </label>

            <div class="options-list">
              <span class="field-label">Antwortoptionen (2 bis 6)</span>
              @for (opt of optionInputs(); track $index) {
                <div class="option-row">
                  <input
                    type="text"
                    class="poll-input compact"
                    maxlength="60"
                    placeholder="Option {{ $index + 1 }}"
                    [ngModel]="opt"
                    (ngModelChange)="updateOption($index, $event)"
                  />
                  @if (optionInputs().length > minOptions) {
                    <button
                      type="button"
                      class="button ghost compact danger"
                      (click)="removeOption($index)"
                      aria-label="Option entfernen"
                    >×</button>
                  }
                </div>
              }
            </div>

            <div class="create-actions">
              @if (optionInputs().length < maxOptions) {
                <button
                  id="poll-add-option"
                  type="button"
                  class="button ghost compact"
                  (click)="addOption()"
                >+ Option hinzufügen</button>
              }
              <button
                id="poll-start-button"
                type="button"
                class="button primary compact"
                [disabled]="!canSubmitPoll()"
                (click)="startPoll()"
              >Umfrage starten</button>
            </div>
          </div>
        } @else {
          <p class="poll-empty-hint">Aktuell läuft keine Umfrage im Raum.</p>
        }
      }

      @if (poll.status() === 'active' && poll.poll()) {
        <div class="poll-active-box" role="region" aria-label="Aktive Umfrage">
          <div class="poll-badge-row">
            <span class="poll-status-badge active">Aktiv</span>
            @if (poll.poll()?.anonymous) {
              <span class="poll-anon-badge">Anonym</span>
            }
          </div>

          <h3 class="poll-question">{{ poll.poll()?.question }}</h3>

          @if (!poll.hasVoted()) {
            <div class="vote-options-group" role="group" aria-label="Abstimmungsoptionen">
              @for (opt of poll.poll()?.options; track $index) {
                <button
                  type="button"
                  class="button ghost option-vote-button"
                  (click)="poll.vote($index)"
                >
                  <span class="opt-num">{{ $index + 1 }}.</span> {{ opt }}
                </button>
              }
            </div>
          } @else {
            <div class="voted-confirmation">
              <span class="voted-icon" aria-hidden="true">✓</span>
              <span>Deine Stimme wurde anonym abgegeben.</span>
            </div>
          }

          @if (poll.isCreator()) {
            <div class="creator-preview">
              <div class="creator-preview-heading">
                <span>Zwischenstand (nur Moderator):</span>
                <span>{{ poll.totalVotes() }} Stimmen</span>
              </div>
              <div class="results-bars">
                @for (opt of poll.poll()?.options; track $index) {
                  <div class="result-bar-item">
                    <div class="result-bar-labels">
                      <span>{{ opt }}</span>
                      <span>{{ poll.counts()[$index] || 0 }} ({{ getPercent($index) }}%)</span>
                    </div>
                    <div class="progress-track">
                      <div class="progress-fill" [style.width.%]="getPercent($index)"></div>
                    </div>
                  </div>
                }
              </div>
              <div class="creator-actions">
                <button
                  id="poll-publish-results"
                  type="button"
                  class="button ghost compact"
                  (click)="poll.publishResults()"
                >Ergebnisse veröffentlichen</button>
                <button
                  id="poll-close-poll"
                  type="button"
                  class="button ghost compact danger"
                  (click)="poll.closePoll()"
                >Beenden</button>
              </div>
            </div>
          }
        </div>
      }

      @if ((poll.status() === 'published' || poll.status() === 'closed') && poll.poll()) {
        <div class="poll-results-box" role="region" aria-label="Umfrage-Ergebnisse">
          <div class="poll-badge-row">
            <span class="poll-status-badge" [class.closed]="poll.status() === 'closed'">
              {{ poll.status() === 'published' ? 'Ergebnis veröffentlicht' : 'Umfrage beendet' }}
            </span>
            <span class="poll-total-badge">{{ poll.totalVotes() }} Stimmen gesamt</span>
          </div>

          <h3 class="poll-question">{{ poll.poll()?.question }}</h3>

          <div class="results-bars">
            @for (opt of poll.poll()?.options; track $index) {
              <div class="result-bar-item">
                <div class="result-bar-labels">
                  <span>{{ opt }}</span>
                  <span>{{ poll.counts()[$index] || 0 }} ({{ getPercent($index) }}%)</span>
                </div>
                <div class="progress-track">
                  <div class="progress-fill" [style.width.%]="getPercent($index)"></div>
                </div>
              </div>
            }
          </div>

          <div class="results-actions">
            <button
              id="poll-export-results"
              type="button"
              class="button ghost compact"
              (click)="poll.exportResults()"
            >Ergebnisse herunterladen</button>

            @if (poll.canCreatePoll()) {
              <button
                id="poll-new-poll"
                type="button"
                class="button ghost compact"
                (click)="resetFormAndStartNew()"
              >Neue Umfrage</button>
            }
          </div>
        </div>
      }
    </section>
  `,
  styles: [`
    .poll-panel { display: grid; gap: .6rem; }
    .poll-create-box, .poll-active-box, .poll-results-box {
      display: grid; gap: .65rem; background: var(--surface-subtle, rgba(0, 0, 0, 0.2));
      border: 1px solid var(--border, rgba(255, 255, 255, 0.08));
      border-radius: .45rem; padding: .65rem;
    }
    .field-label { display: grid; gap: .25rem; font-size: .8rem; color: var(--muted); font-weight: 500; }
    .poll-input {
      width: 100%; box-sizing: border-box; padding: .45rem; border-radius: .35rem;
      border: 1px solid var(--border, rgba(255, 255, 255, 0.1));
      background: var(--surface-ground, rgba(0, 0, 0, 0.3)); color: inherit; font-size: .85rem;
    }
    .poll-input.compact { padding: .35rem .45rem; }
    .poll-input:focus { outline: 2px solid var(--accent, #38bdf8); }
    .options-list { display: grid; gap: .4rem; }
    .option-row { display: flex; gap: .35rem; align-items: center; }
    .create-actions { display: flex; justify-content: space-between; align-items: center; margin-top: .3rem; }
    .poll-empty-hint { font-size: .85rem; color: var(--muted); margin: .4rem 0; }
    .poll-badge-row { display: flex; justify-content: space-between; align-items: center; font-size: .75rem; }
    .poll-status-badge { background: rgba(34, 197, 94, 0.15); color: #22c55e; border: 1px solid rgba(34, 197, 94, 0.3); border-radius: .25rem; padding: .1rem .35rem; font-weight: 600; }
    .poll-status-badge.closed { background: rgba(148, 163, 184, 0.15); color: #94a3b8; border-color: rgba(148, 163, 184, 0.3); }
    .poll-anon-badge, .poll-total-badge { color: var(--muted); }
    .poll-question { margin: 0; font-size: .95rem; font-weight: 600; line-height: 1.35; }
    .vote-options-group { display: grid; gap: .4rem; }
    .option-vote-button { width: 100%; text-align: left; padding: .5rem .65rem; border-radius: .35rem; font-size: .85rem; }
    .option-vote-button:hover { background: rgba(255, 255, 255, 0.08); border-color: var(--accent, #38bdf8); }
    .opt-num { font-weight: bold; color: var(--accent, #38bdf8); margin-right: .3rem; }
    .voted-confirmation { display: flex; align-items: center; gap: .45rem; padding: .5rem; background: rgba(34, 197, 94, 0.1); border: 1px solid rgba(34, 197, 94, 0.25); border-radius: .35rem; color: #22c55e; font-size: .85rem; }
    .voted-icon { font-weight: bold; }
    .creator-preview { display: grid; gap: .5rem; margin-top: .4rem; padding-top: .5rem; border-top: 1px dashed var(--border, rgba(255, 255, 255, 0.1)); }
    .creator-preview-heading { display: flex; justify-content: space-between; font-size: .8rem; color: var(--muted); }
    .results-bars { display: grid; gap: .5rem; }
    .result-bar-item { display: grid; gap: .2rem; }
    .result-bar-labels { display: flex; justify-content: space-between; font-size: .8rem; }
    .progress-track { width: 100%; height: 6px; background: rgba(255, 255, 255, 0.08); border-radius: 3px; overflow: hidden; }
    .progress-fill { height: 100%; background: var(--accent, #38bdf8); transition: width .3s ease; }
    .creator-actions, .results-actions { display: flex; justify-content: space-between; align-items: center; margin-top: .4rem; }
    .danger { color: #ef4444; }
  `],
})
export class PollPanelComponent {
  readonly minOptions = POLL_CONSTANTS.minOptions;
  readonly maxOptions = POLL_CONSTANTS.maxOptions;

  readonly questionInput = signal<string>("");
  readonly optionInputs = signal<readonly string[]>(["Ja", "Nein"]);

  constructor(
    readonly poll: PollService,
    readonly session: RoomSessionService,
  ) {}

  addOption(): void {
    if (this.optionInputs().length < this.maxOptions) {
      this.optionInputs.update((opts) => [...opts, ""]);
    }
  }

  removeOption(index: number): void {
    if (this.optionInputs().length > this.minOptions) {
      this.optionInputs.update((opts) => opts.filter((_, i) => i !== index));
    }
  }

  updateOption(index: number, value: string): void {
    this.optionInputs.update((opts) => {
      const next = [...opts];
      next[index] = value;
      return next;
    });
  }

  canSubmitPoll(): boolean {
    const q = this.questionInput().trim();
    if (!q || q.length > POLL_CONSTANTS.maxQuestionLength) return false;
    const opts = this.optionInputs();
    if (opts.length < this.minOptions || opts.length > this.maxOptions) return false;
    return opts.every((opt) => opt.trim().length > 0 && opt.trim().length <= POLL_CONSTANTS.maxOptionLength);
  }

  startPoll(): void {
    if (!this.canSubmitPoll()) return;
    const q = this.questionInput().trim();
    const opts = this.optionInputs().map((opt) => opt.trim());
    this.poll.createPoll(q, opts);
  }

  getPercent(index: number): string {
    const total = this.poll.totalVotes();
    if (total <= 0) return "0.0";
    const count = this.poll.counts()[index] || 0;
    return ((count / total) * 100).toFixed(1);
  }

  resetFormAndStartNew(): void {
    this.questionInput.set("");
    this.optionInputs.set(["Ja", "Nein"]);
    this.poll.reset();
  }
}
