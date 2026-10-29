import { Component, inject } from "@angular/core";
import { MachineReceiveObservationService } from "./machine-receive-observation.service";
import { MachineAdmissionStatusComponent } from "./machine-admission-status.component";

@Component({
  selector: "app-machine-permissions-panel", standalone: true, imports: [MachineAdmissionStatusComponent],
  providers: [MachineReceiveObservationService],
  template: `<section aria-labelledby="machine-receive-heading">
    <h2 id="machine-receive-heading">Ananta · Empfangsrechte im Raum</h2>
    @defer (on immediate) { <app-machine-admission-status /> }
    @loading { <p id="machine-admission-loading" role="status">Betreiberstatus wird geladen…</p> }
    @error { <p id="machine-admission-load-error" role="alert">Betreiberstatus nicht geladen. Der globale Aufnahmestatus ist unbekannt; die verbundenen KI-Endpunkte bleiben unten sichtbar.</p> }
    <p id="machine-receive-policy">Der Hub autorisiert den Empfang durch die KI während ihrer gültigen Raumsitzung.
      Eine KI mit Audio- oder Bildempfangsrecht kann deine laufenden, im Raum geteilten Quellen entschlüsseln.
      Mit Chatleserecht kann sie deine neuen Chatbeiträge lesen. Diese Übersicht erteilt und widerruft keine Rechte.</p>
    <p id="machine-receive-stop">Stoppe Mikrofon, Kamera oder Bildschirm über die Mediensteuerung, um die jeweilige Quelle nicht weiter zu teilen.
      Verlasse den Raum, um deine gesamte Teilnahme zu beenden. Frühere lokale Quellenfreigaben begrenzen die Hub-Rechte nicht.</p>
    <p>Empfangsrechte bestätigen keine Aufnahme, Speicherung oder Nutzung externer Modellanbieter und erlauben diese nicht zusätzlich.</p>
    @for (peer of observation.activities(); track peer.id) {
      <article [attr.data-machine-peer]="peer.id"><h3>{{ peer.name }}</h3>
        <p>KI-Endpunkt · technische Peer-ID: <code>{{ peer.id }}</code>. Keine bewiesene menschliche Identität.</p>
        <dl>
          <dt>Audioempfang</dt><dd>{{ peer.audioSupported ? 'Vom Hub erlaubt für laufende Raumquellen.' : 'Vom Hub nicht freigegeben.' }}</dd>
          <dt>Visueller Empfang</dt><dd>{{ peer.videoSupported ? 'Vom Hub erlaubt für laufende Kamera- und Bildschirmquellen.' : 'Vom Hub nicht freigegeben.' }}</dd>
          <dt>Chat lesen / antworten</dt><dd>{{ peer.chatReadSupported ? 'Leserecht vorhanden' : 'Kein Leserecht' }} / {{ peer.chatSendSupported ? 'Senderecht vorhanden' : 'Kein Senderecht' }}</dd>
          <dt>Agenteneigener Bildschirm / Bildschirmton</dt><dd>{{ peer.screenAvailable ? 'Remote-Track verfügbar' : 'Kein Remote-Track' }} / {{ peer.screenAudioAvailable ? 'Separater Ton-Track verfügbar' : 'Kein Ton-Track' }}</dd>
          <dt>Avatar / synthetische Sprache</dt><dd>{{ peer.avatarAvailable ? 'Avatar-Track verfügbar' : 'Kein Avatar-Track' }} / {{ peer.speechAvailable ? 'Sprach-Track verfügbar' : 'Kein Sprach-Track' }}</dd>
          <dt>Tatsächliche KI-Verarbeitung</dt><dd>Nicht durch Meet bestätigt. Ein Recht oder Remote-Track beweist weder ASR-/Dialogaktivität noch flüssige Wiedergabe.</dd>
        </dl>
      </article>
    } @empty { <p>Zurzeit ist keine KI im Raum verbunden.</p> }
  </section>`,
  styles: [`section { margin-top: 1rem; padding: 1.25rem; border: 1px solid var(--border, #526075); border-radius: 1rem; }
    article { margin-block: 1rem; } dt { font-weight: 600; margin-top: .75rem; }
    dd { margin-inline-start: 0; } code { overflow-wrap: anywhere; }`],
})
export class MachinePermissionsPanelComponent {
  readonly observation = inject(MachineReceiveObservationService);
}
