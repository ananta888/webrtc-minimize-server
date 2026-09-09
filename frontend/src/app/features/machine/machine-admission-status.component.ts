import { Component, inject, OnInit } from "@angular/core";
import { DatePipe } from "@angular/common";
import { MachineAdmissionStatusService } from "./machine-admission-status.service";
import { MachineIntegrationCapability } from "./machine-integration-status";

@Component({
  selector: "app-machine-admission-status", standalone: true, imports: [DatePipe],
  providers: [MachineAdmissionStatusService],
  template: `<section aria-labelledby="machine-admission-heading">
    <h3 id="machine-admission-heading">Ananta-Anbindung · Betreiberstatus</h3>
    <p role="status" aria-live="polite">
      @switch (admission.state()) {
        @case ('enabled') { Maschinenaufnahme ist serverseitig eingeschaltet. }
        @case ('disabled') { Maschinenaufnahme ist serverseitig ausgeschaltet. }
        @case ('checking') { Betreiberstatus wird geprüft… }
        @case ('unavailable') { Betreiberstatus nicht verlässlich abrufbar. }
        @case ('stale') { Betreiberstatus ist nicht mehr aktuell. Bitte erneut prüfen. }
        @default { Betreiberstatus noch nicht geprüft. }
      }
    </p>
    @if (admission.state() === 'disabled') {
      <p>Der Betreiber muss zuerst öffentlichen Hub-Trust und die erlaubten Fähigkeiten konfigurieren.
        Zusätzlich braucht Ananta einen freigegebenen Projektauftrag. Deine Quellenfreigabe allein schaltet die Anbindung nicht ein.</p>
    }
    @if (admission.integration(); as integration) {
      <div class="integration-table-scroll" tabindex="0" role="region" aria-label="Ananta-Funktionsübersicht">
        <table>
          <caption>Meet-Schnittstellen · noch keine Freigabe für einen bestimmten Hub oder Worker</caption>
          <thead><tr><th scope="col">Funktion</th><th scope="col">Implementiert</th>
            <th scope="col">Globale Betreibergrenze</th><th scope="col">Zusätzlich erforderlich</th></tr></thead>
          <tbody>
            @for (capability of integration.supportedCapabilities; track capability) {
              <tr [attr.data-machine-capability]="capability">
                <th scope="row">{{ labels[capability] }}</th><td>Ja</td>
                <td>{{ integration.operatorCapabilityCeiling.includes(capability) ? 'Enthalten' : 'Gesperrt' }}</td>
                <td>{{ integration.publisherConsentRequired.includes(capability)
                  ? 'Freigabe deiner konkreten Quelle unten'
                  : capability === 'chat.send' ? 'Freigegebener Eingang und korrelierte Antwort' : 'Autorisierte agenteneigene Quelle' }}</td>
              </tr>
            }
            <tr><th scope="row">Sitzungserneuerung</th><td>Ja</td><td>Keine automatische Verlängerung</td>
              <td>Frischer Hub-Grant, gleiches Gerät und unveränderte Sitzungsbindung</td></tr>
          </tbody>
        </table>
      </div>
      <p>„Enthalten“ bezeichnet nur die globale Obergrenze, keine erteilte Berechtigung.
        Hub-Trustprofil, Projektauftrag, Browserunterstützung und aktuelle Raumrechte können weiter einschränken.
        Eine Sitzungserneuerung verlängert deine Quellenfreigaben nicht.</p>
    }
    <p>Diese Prüfung meldet weder einen verbundenen Hub noch einen laufenden Worker.
      Audioempfang und Chatlesen benötigen zusätzlich deine Freigabe unten.
      Bildschirm, Avatar und Sprache erscheinen erst bei tatsächlich verfügbaren Remote-Tracks.</p>
    @if (admission.checkedAt(); as time) { <p>Zuletzt geprüft: {{ time | date:'HH:mm:ss' }} · Status maximal 30 Sekunden aktuell.</p> }
    <button type="button" [disabled]="admission.state() === 'checking'" (click)="admission.refresh()">Betreiberstatus aktualisieren</button>
  </section>`,
  styles: [`.integration-table-scroll { overflow-x: auto; }
    table { width: 100%; border-collapse: collapse; font-size: .875rem; }
    caption { text-align: left; padding-block: .5rem; }
    th, td { text-align: left; vertical-align: top; padding: .5rem; border-bottom: 1px solid currentColor; }
    .integration-table-scroll:focus-visible { outline: 2px solid currentColor; outline-offset: 2px; }`],
})
export class MachineAdmissionStatusComponent implements OnInit {
  readonly admission = inject(MachineAdmissionStatusService);
  readonly labels: Record<MachineIntegrationCapability, string> = {
    "audio.receive": "Audioempfang durch KI", "video.receive": "Bildempfang durch KI",
    "chat.read": "Neue Chatbeiträge lesen", "chat.send": "Im Chat antworten",
    "screen.publish": "Agenteneigener Bildschirm", "screen-audio.publish": "Ton des Agentenbildschirms",
    "speech.publish": "Synthetische Sprache", "avatar.publish": "KI-Avatar",
  };
  ngOnInit(): void { void this.admission.refresh(); }
}
