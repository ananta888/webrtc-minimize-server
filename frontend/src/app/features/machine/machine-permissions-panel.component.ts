import { Component, effect, inject, signal } from "@angular/core";
import { DatePipe } from "@angular/common";
import { MachineReceiveControlsService, MachineReceiveSelection } from "./machine-receive-controls.service";
import { MachineAdmissionStatusComponent } from "./machine-admission-status.component";

@Component({
  selector: "app-machine-permissions-panel", standalone: true, imports: [DatePipe, MachineAdmissionStatusComponent],
  providers: [MachineReceiveControlsService],
  template: `<section aria-labelledby="machine-receive-heading">
    <h2 id="machine-receive-heading">Ananta · Freigaben meiner Quellen</h2>
    @defer (on immediate) { <app-machine-admission-status /> }
    <p>Ananta verarbeitet freigegebene Inhalte als entschlüsselnder KI-Endpunkt, nicht als blinder Relay.
      Die Freigabe gilt nur für deine eigenen aktuellen Quellen. Aufnahme, Speicherung und externe Modellanbieter sind damit nicht erlaubt.</p>
    @for (peer of controls.activities(); track peer.id) {
      <article><h3>{{ peer.name }}</h3>
        <p>KI-Endpunkt · technische Peer-ID: <code>{{ peer.id }}</code>. Keine bewiesene menschliche Identität.</p>
        @if (peer.grant; as grant) {
          <p>Bestätigte Freigabe bis {{ grant.expiresAt | date:'HH:mm:ss' }} · Audioquellen: {{ grant.publicationIds.length }} · Chat: {{ grant.chatRead ? 'ja' : 'nein' }}</p>
        } @else {
          <p>Keine Empfangsfreigabe erteilt.</p>
          @if (peer.grantState === 'expired') { <p>Die letzte Freigabe ist abgelaufen.</p> }
        }
        <dl>
          <dt>Audioempfang</dt><dd>{{ peer.audioSupported ? 'Vom Hub erlaubt; eigene Quellen benötigen zusätzlich deine Freigabe.' : 'Vom Hub nicht freigegeben.' }}</dd>
          <dt>Chat lesen / antworten</dt><dd>{{ peer.chatReadSupported ? 'Leserecht möglich' : 'Kein Leserecht' }} / {{ peer.chatSendSupported ? 'Senderecht vorhanden' : 'Kein Senderecht' }}</dd>
          <dt>Agenteneigener Bildschirm</dt><dd>{{ peer.screenAvailable ? 'Remote-Track verfügbar' : peer.screenSupported ? 'Erlaubt, zurzeit kein Remote-Track' : 'Nicht freigegeben' }}</dd>
          <dt>Agenteneigener Bildschirmton</dt><dd>{{ peer.screenAudioAvailable ? 'Separater Ton-Track verfügbar' : 'Kein Ton-Track' }}</dd>
          <dt>Avatar / synthetische Sprache</dt><dd>{{ peer.avatarAvailable ? 'Avatar-Track verfügbar' : 'Kein Avatar-Track' }} / {{ peer.speechAvailable ? 'Sprach-Track verfügbar' : 'Kein Sprach-Track' }}</dd>
          <dt>Tatsächliche KI-Verarbeitung</dt><dd>Nicht durch Meet bestätigt. Ein Recht oder Remote-Track beweist weder ASR-/Dialogaktivität noch flüssige Wiedergabe.</dd>
        </dl>
        <button type="button" [attr.aria-pressed]="target() === peer.id" (click)="select(peer.id)">Für diese KI einstellen</button>
        <button type="button" [disabled]="controls.state() === 'pending'" (click)="controls.request(peer.id, false, false, false, 1, 'user-action')">Meine Freigaben widerrufen</button>
      </article>
    } @empty { <p>Zurzeit ist keine KI im Raum verbunden.</p> }
    @if (target()) {
      <fieldset [attr.data-machine-peer]="target()"><legend>Ausgewählte KI: {{ targetName() }} · nur eigene Quellen</legend>
        <label><input type="checkbox" [checked]="microphone()" (change)="microphone.set($any($event.target).checked)" [disabled]="!supports('audio.receive') || !controls.sourceAvailable('microphone')"> Mein laufendes Mikrofon</label>
        @if (!controls.sourceAvailable('microphone')) { <p>Mikrofon nicht aktiv. Start ist ausschließlich über die Mediensteuerung möglich.</p> }
        <label><input type="checkbox" [checked]="screenAudio()" (change)="screenAudio.set($any($event.target).checked)" [disabled]="!supports('audio.receive') || !controls.sourceAvailable('screen-audio')"> Mein laufender Bildschirmton</label>
        @if (!controls.sourceAvailable('screen-audio')) { <p>Kein laufender Bildschirmton vorhanden.</p> }
        <label><input type="checkbox" [checked]="chat()" (change)="chat.set($any($event.target).checked)" [disabled]="!supports('chat.read')"> Meine neuen Chatbeiträge</label>
        <label>Gültigkeit <select [value]="minutes()" (change)="minutes.set(+$any($event.target).value)"><option value="1">1 Minute</option><option value="5">5 Minuten</option><option value="10">10 Minuten</option></select></label>
        <p>Nur bereits laufende Audioquellen sind auswählbar. Diese Ansicht startet keine Aufnahme.
          Die Auswahl ersetzt die bisherigen Freigaben für diese KI erst nach deinem Klick und der Serverbestätigung.
          Ein bestätigtes Recht bedeutet noch nicht, dass Audioerkennung oder Dialog bereits aktiv sind.</p>
        <button type="button" [disabled]="controls.state() === 'pending'" (click)="controls.request(target(), microphone(), screenAudio(), chat(), minutes(), 'user-action', selected)">Auswahl ausdrücklich freigeben</button>
      </fieldset>
    }
    <p role="status" aria-live="polite">{{ controls.state() === 'pending' ? 'Warte auf Serverbestätigung…' : controls.state() === 'confirmed' ? 'Serverbestätigung erhalten.' : '' }}</p>
    @if (controls.state() === 'expired') { <p role="status">Die bestätigte Freigabe ist abgelaufen. Es wird nichts automatisch verlängert.</p> }
    @if (controls.requestPeerId() && controls.state() !== 'idle') {
      <p>Rückmeldung für KI-Peer <code>{{ controls.requestPeerId() }}</code>.</p>
    }
    @if (controls.error() === 'machine_receive_selection_changed') {
      <p role="alert">Quelle oder Sitzung seit der Auswahl geändert. Es wurde keine neue Freigabe gesendet.
        Bitte „Für diese KI einstellen“ erneut wählen und die gewünschten Quellen prüfen.</p>
    } @else if (controls.error()) { <p role="alert">{{ controls.error() }}</p> }
  </section>`,
  styles: [`section { margin-top: 1rem; padding: 1.25rem; border: 1px solid var(--border, #526075); border-radius: 1rem; }
    fieldset, article { margin-block: 1rem; } label { display: block; margin-block: .75rem; } button { margin: .25rem .5rem .25rem 0; }
    dt { font-weight: 600; margin-top: .75rem; } dd { margin-inline-start: 0; } code { overflow-wrap: anywhere; }`],
})
export class MachinePermissionsPanelComponent {
  readonly controls = inject(MachineReceiveControlsService);
  readonly target = signal(""); readonly microphone = signal(false); readonly screenAudio = signal(false);
  readonly chat = signal(false); readonly minutes = signal(5);
  selected?: MachineReceiveSelection;
  constructor() {
    effect(() => {
      if (this.target() && !this.controls.targets().some(peer => peer.id === this.target())) this.select("");
      if (!this.controls.sourceAvailable("microphone") || !this.supports("audio.receive")) this.microphone.set(false);
      if (!this.controls.sourceAvailable("screen-audio") || !this.supports("audio.receive")) this.screenAudio.set(false);
      if (!this.supports("chat.read")) this.chat.set(false);
    });
  }
  select(id: string): void {
    const selection = this.controls.selection(id);
    this.selected = id ? this.controls.selectionScope(id) : undefined;
    this.target.set(id); this.microphone.set(selection.microphone); this.screenAudio.set(selection.screenAudio); this.chat.set(selection.chat);
  }
  targetName(): string { return this.controls.targets().find(peer => peer.id === this.target())?.name || "Nicht verbunden"; }
  supports(capability: string): boolean { return this.controls.mesh.machineReceive.supports(this.target(), capability); }
}
