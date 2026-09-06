import { Component, inject, signal } from "@angular/core";
import { DatePipe } from "@angular/common";
import { MachineReceiveControlsService } from "./machine-receive-controls.service";

@Component({
  selector: "app-machine-permissions-panel", standalone: true, imports: [DatePipe],
  providers: [MachineReceiveControlsService],
  template: `<section aria-labelledby="machine-receive-heading">
    <h2 id="machine-receive-heading">Ananta · Freigaben meiner Quellen</h2>
    <p>Ananta verarbeitet freigegebene Inhalte als entschlüsselnder KI-Endpunkt, nicht als blinder Relay.
      Die Freigabe gilt nur für deine eigenen aktuellen Quellen. Aufnahme, Speicherung und externe Modellanbieter sind damit nicht erlaubt.</p>
    @for (peer of controls.targets(); track peer.id) {
      <article><h3>{{ peer.name }}</h3>
        @if (controls.mesh.ownMachineReceiveGrant(peer.id); as grant) {
          <p>Bestätigte Freigabe bis {{ grant.expiresAt | date:'HH:mm:ss' }} · Audioquellen: {{ grant.publicationIds.length }} · Chat: {{ grant.chatRead ? 'ja' : 'nein' }}</p>
        } @else { <p>Keine Empfangsfreigabe erteilt.</p> }
        <button type="button" (click)="select(peer.id)">Für diese KI einstellen</button>
        <button type="button" [disabled]="controls.state() === 'pending'" (click)="controls.request(peer.id, false, false, false, 1, 'user-action')">Meine Freigaben widerrufen</button>
      </article>
    } @empty { <p>Zurzeit ist keine KI im Raum verbunden.</p> }
    @if (target()) {
      <fieldset><legend>Ausgewählte KI · nur eigene Quellen</legend>
        <label><input type="checkbox" [checked]="microphone()" (change)="microphone.set($any($event.target).checked)" [disabled]="!supports('audio.receive')"> Mein laufendes Mikrofon</label>
        <label><input type="checkbox" [checked]="screenAudio()" (change)="screenAudio.set($any($event.target).checked)" [disabled]="!supports('audio.receive')"> Mein laufender Bildschirmton</label>
        <label><input type="checkbox" [checked]="chat()" (change)="chat.set($any($event.target).checked)" [disabled]="!supports('chat.read')"> Meine neuen Chatbeiträge</label>
        <label>Gültigkeit <select [value]="minutes()" (change)="minutes.set(+$any($event.target).value)"><option value="1">1 Minute</option><option value="5">5 Minuten</option><option value="10">10 Minuten</option></select></label>
        <p>Nur bereits laufende Audioquellen sind auswählbar. Diese Ansicht startet keine Aufnahme.
          Ein bestätigtes Recht bedeutet noch nicht, dass Audioerkennung oder Dialog bereits aktiv sind.</p>
        <button type="button" [disabled]="controls.state() === 'pending'" (click)="controls.request(target(), microphone(), screenAudio(), chat(), minutes(), 'user-action')">Auswahl ausdrücklich freigeben</button>
      </fieldset>
    }
    <p role="status" aria-live="polite">{{ controls.state() === 'pending' ? 'Warte auf Serverbestätigung…' : controls.state() === 'confirmed' ? 'Serverbestätigung erhalten.' : '' }}</p>
    @if (controls.error()) { <p role="alert">{{ controls.error() }}</p> }
  </section>`,
  styles: [`section { margin-top: 1rem; padding: 1.25rem; border: 1px solid var(--border, #526075); border-radius: 1rem; }
    fieldset, article { margin-block: 1rem; } label { display: block; margin-block: .75rem; } button { margin: .25rem .5rem .25rem 0; }`],
})
export class MachinePermissionsPanelComponent {
  readonly controls = inject(MachineReceiveControlsService);
  readonly target = signal(""); readonly microphone = signal(false); readonly screenAudio = signal(false);
  readonly chat = signal(false); readonly minutes = signal(5);
  select(id: string): void {
    this.target.set(id); this.microphone.set(false); this.screenAudio.set(false); this.chat.set(false);
  }
  supports(capability: string): boolean { return this.controls.mesh.machineReceive.supports(this.target(), capability); }
}
