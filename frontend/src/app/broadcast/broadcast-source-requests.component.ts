import { DatePipe } from "@angular/common";
import { ChangeDetectionStrategy, Component, OnChanges, OnDestroy, OnInit, computed, input, signal } from "@angular/core";
import { BroadcastSourceRequestsService, SourceInvitation, SourceRequestProgram } from "./broadcast-source-requests.service";
import { BroadcastSourceKind } from "./broadcast-ports";
import { TrustedSourceWorkflowService } from "./trusted-source-workflow.service";

@Component({
  selector: "app-broadcast-source-requests", standalone: true, imports: [DatePipe],
  providers: [BroadcastSourceRequestsService], changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="panel" aria-labelledby="broadcast-source-requests-heading">
      <h2 id="broadcast-source-requests-heading">Quellenanfragen</h2>
      <p>Eine Anfrage startet weder Kamera, Mikrofon noch Bildschirm und gibt keine Medien oder Schlüssel frei.
        Für einen nativen Quellen-Packager kannst du eine bereits laufende eigene Quelle getrennt freigeben.
        Der Trusted Packager entschlüsselt diese Quelle und kann sie an das Broadcast-Publikum ausgeben.</p>
      <button id="broadcast-source-requests-load" class="button secondary" type="button"
        [disabled]="disabled() || requests.busy()" (click)="load()">Anfragen vom Server laden</button>
      @if (program()) {
        <fieldset [disabled]="disabled() || requests.busy()">
          <legend>Teilnehmer für die laufende Sendung anfragen</legend>
          <label for="broadcast-source-request-target">Teilnehmer</label>
          <select id="broadcast-source-request-target" [value]="target()" (change)="target.set($any($event.target).value)">
            <option value="">Bitte wählen</option>
            @for (candidate of candidates(); track candidate.id) { <option [value]="candidate.id">{{ candidate.name }}</option> }
          </select>
          <label for="broadcast-source-request-kind">Gewünschte Quelle</label>
          <select id="broadcast-source-request-kind" [value]="kind()" (change)="setKind($any($event.target).value)">
            <option value="camera">Kamera</option><option value="microphone">Mikrofon</option>
            <option value="screen">Bildschirm</option><option value="screen-audio">Bildschirmton</option>
          </select>
          <button id="broadcast-source-request-create" class="button secondary" type="button"
            [disabled]="!canCreate()" (click)="create()">Anfrage bestätigen…</button>
        </fieldset>
      }
      @if (requests.loaded()) {
        <p role="status">{{ requests.items().length }} eigene oder eingegangene Anfragen im letzten Serverstand.</p>
        <ul>
          @for (item of requests.items(); track item.requestId) {
            <li [attr.data-source-request-id]="item.requestId">
              <strong>{{ item.ownerPeerId === peerId() ? 'Gesendet an ' + name(item.targetPeerId) : 'Anfrage von ' + name(item.ownerPeerId) }}</strong>
              · {{ label(item.sourceKind) }} · {{ item.expiresAt <= now() ? 'Abgelaufen' : stateLabel(item.state) }}
              <small>Programm {{ item.programId }} · gültig bis {{ item.expiresAt | date:'HH:mm:ss' }}</small>
              @if (item.state === 'pending') {
                @if (item.targetPeerId === peerId()) {
                  <button class="button secondary" type="button"
                    [disabled]="disabled() || sources.view().preparing || !!sources.view().selection || item.expiresAt <= now()"
                    (click)="prepareSource(item)">Eigene Quelle prüfen</button>
                }
                <button class="button secondary" type="button" [disabled]="disabled() || requests.busy() || item.expiresAt <= now()"
                  (click)="finish(item)">{{ item.ownerPeerId === peerId() ? 'Zurückziehen' : 'Ablehnen' }}</button>
              }
            </li>
          } @empty { <li>Keine Anfragen vorhanden.</li> }
        </ul>
      }
      @if (requests.error()) { <p id="broadcast-source-requests-error" class="error" role="alert">{{ requests.error() }}</p> }
      @if (sources.view().preparing) { <p role="status">Aktuelle eigene Publikation wird beim Server geprüft…</p> }
      @if (sources.view().selection; as selection) {
        <fieldset id="broadcast-source-approval"><legend>Getrennte Freigabe für den Trusted Packager</legend>
          <p>Ziel-Packager: <code>{{ selection.packagerRef }}</code> · Programm: <code>{{ selection.programId }}</code></p>
          @for (publication of selection.publications; track publication.publicationId) {
            <p>{{ label(publication.source) }} · bereits laufende eigene Quelle</p>
            <p>Der interaktive Raum bleibt getrennt verschlüsselt. Der gewählte Packager erhält jedoch einen eigenen
              Entschlüsselungsschlüssel für diese Quelle. Ein Zuschauer-Broadcast ist nicht Ende-zu-Ende-verschlüsselt.</p>
            <label>Maximale Freigabedauer
              <select [value]="sourceTtl()" (change)="setSourceTtl(+$any($event.target).value)">
                <option value="60000">1 Minute</option><option value="300000">5 Minuten</option><option value="600000">10 Minuten</option>
              </select>
            </label>
            <button type="button" class="button primary" [disabled]="disabled()"
              (click)="approveSource(selection.requestId, publication.publicationId)">Entschlüsselung und Broadcast ausdrücklich erlauben…</button>
          } @empty { <p>Keine passende laufende Quelle vorhanden. Starte sie bei Bedarf selbst über die Mediensteuerung und prüfe erneut.</p> }
          <button type="button" class="button secondary" (click)="sources.workflow.cancelSelection()">Auswahl schließen</button>
        </fieldset>
      }
      @if (sources.view().publications.length) {
        <h3>Meine Broadcast-Quellen</h3>
        <ul>@for (publication of sources.view().publications; track publication.requestId) {
          <li>{{ label(publication.source) }} · {{ sourcePhase(publication.phase) }}
            @if (publication.phase !== 'stopped' && publication.phase !== 'failed') {
              · höchstens bis {{ publication.expiresAt | date:'HH:mm:ss' }}
              <button type="button" class="button secondary" (click)="sources.workflow.revoke(publication.requestId)">Broadcast-Quelle sofort stoppen</button>
            }
          </li>
        }</ul>
      }
      @if (sources.view().error) { <p role="alert">Quellenfreigabe nicht bestätigt oder nicht mehr gültig. Bitte Quelle und Anfrage erneut prüfen.</p> }
      <p>Bis zu vier eigene Quellen. Freigaben werden nicht automatisch verlängert; Server- und Packager-Leases können früher enden.
        „Sender aktiv“ beweist noch keine Wiedergabe beim Publikum. Panelwechsel stoppt keinen aktiven Broadcastsender;
        „Broadcast-Quelle sofort stoppen“ beendet nur diesen Zweig, nicht deine laufende Raumfreigabe.</p>
      <p>Keine automatische Aktualisierung. Nach 120 Sekunden, Raum-/Gerätewechsel oder Packager-Übergabe wird die Anfrage ungültig.</p>
    </section>
  `,
})
export class BroadcastSourceRequestsComponent implements OnChanges, OnDestroy, OnInit {
  readonly roomId = input(""); readonly peerId = input(""); readonly identityKey = input(""); readonly disabled = input(true);
  readonly candidates = input<readonly { id: string; name: string }[]>([]);
  readonly program = input<SourceRequestProgram | null>(null);
  readonly target = signal(""); readonly kind = signal<BroadcastSourceKind>("camera");
  readonly sourceTtl = signal(60000);
  readonly canCreate = computed(() => !this.disabled() && !this.requests.busy() && Boolean(this.program())
    && this.candidates().some(candidate => candidate.id === this.target()));
  private identity = "";
  private programKey = "";
  readonly now = signal(Date.now());
  private timer: ReturnType<typeof setInterval> | null = null;
  constructor(readonly requests: BroadcastSourceRequestsService, readonly sources: TrustedSourceWorkflowService) {}
  ngOnChanges(): void {
    const program = this.program(), key = program ? `${program.programId}:${program.programEpoch}` : "";
    if (this.identity !== this.identityKey() || this.programKey !== key) {
      this.requests.reset(); this.identity = this.identityKey(); this.programKey = key;
    }
    this.requests.setScope(this.disabled() ? "" : this.roomId(), this.peerId());
    if (!this.candidates().some(candidate => candidate.id === this.target())) this.target.set("");
  }
  ngOnInit(): void { this.timer = setInterval(() => this.now.set(Date.now()), 1000); }
  ngOnDestroy(): void { if (this.timer !== null) clearInterval(this.timer); this.requests.reset(); this.sources.workflow.cancelSelection(); }
  setSourceTtl(value: number): void { if ([60000, 300000, 600000].includes(value)) this.sourceTtl.set(value); }
  async prepareSource(item: SourceInvitation): Promise<void> {
    if (!this.disabled() && this.requests.items().includes(item)) await this.sources.workflow.prepare(item);
  }
  approveSource(requestId: string, publicationId: string): void {
    const selection = this.sources.view().selection, ttl = this.sourceTtl();
    if (this.disabled() || selection?.requestId !== requestId || !selection.publications.some(p => p.publicationId === publicationId)) return;
    if (!window.confirm("Diese eigene Quelle für den angefragten Trusted Packager entschlüsseln und zur Ausstrahlung freigeben? Das Broadcast-Publikum ist nicht SFrame-E2EE geschützt.")) return;
    if (this.disabled() || this.sources.view().selection !== selection || this.sourceTtl() !== ttl) return;
    this.sources.workflow.approve(requestId, publicationId, ttl, "user-action");
  }
  sourcePhase(value: string): string {
    return ({ "waiting-consent": "Warte auf Serverfreigabe", "waiting-receiver": "Warte auf Packager-Empfangsbereitschaft",
      "waiting-key": "Warte auf Schlüsselbestätigung", sending: "Sender aktiv", stopped: "Gestoppt", failed: "Beendet oder fehlgeschlagen" } as Record<string, string>)[value] || "Unbekannt";
  }
  setKind(value: string): void { if (["camera", "microphone", "screen", "screen-audio"].includes(value)) this.kind.set(value as BroadcastSourceKind); }
  name(id: string): string { return this.candidates().find(candidate => candidate.id === id)?.name || "Teilnehmer nicht mehr im Raum"; }
  label(kind: BroadcastSourceKind): string { return ({ camera: "Kamera", microphone: "Mikrofon", screen: "Bildschirm", "screen-audio": "Bildschirmton" })[kind]; }
  stateLabel(state: SourceInvitation["state"]): string { return ({ pending: "Offen · keine Freigabe", declined: "Abgelehnt", cancelled: "Zurückgezogen", invalidated: "Ungültig" })[state]; }
  async load(): Promise<void> { if (!this.disabled()) await this.requests.load(); }
  async create(): Promise<void> {
    const program = this.program(), target = this.target(), kind = this.kind(), identity = this.identityKey(), room = this.roomId(), peer = this.peerId();
    if (!this.canCreate() || !program || !window.confirm(`${this.name(target)} für ${this.label(kind)} anfragen? Dies erteilt noch keine Quellenfreigabe.`)) return;
    if (!this.canCreate() || this.program() !== program || this.target() !== target || this.kind() !== kind
      || this.identityKey() !== identity || this.roomId() !== room || this.peerId() !== peer) return;
    await this.requests.create(program, target, kind);
  }
  async finish(item: SourceInvitation): Promise<void> { if (!this.disabled()) await this.requests.finish(item); }
}
