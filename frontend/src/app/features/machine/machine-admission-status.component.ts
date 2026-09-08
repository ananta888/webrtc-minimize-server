import { Component, inject, OnInit } from "@angular/core";
import { DatePipe } from "@angular/common";
import { MachineAdmissionStatusService } from "./machine-admission-status.service";

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
    <p>Diese Prüfung meldet weder einen verbundenen Hub noch einen laufenden Worker.
      Audioempfang und Chatlesen benötigen zusätzlich deine Freigabe unten.
      Bildschirm, Avatar und Sprache erscheinen erst bei tatsächlich verfügbaren Remote-Tracks.</p>
    @if (admission.checkedAt(); as time) { <p>Zuletzt geprüft: {{ time | date:'HH:mm:ss' }} · Status maximal 30 Sekunden aktuell.</p> }
    <button type="button" [disabled]="admission.state() === 'checking'" (click)="admission.refresh()">Betreiberstatus aktualisieren</button>
  </section>`,
})
export class MachineAdmissionStatusComponent implements OnInit {
  readonly admission = inject(MachineAdmissionStatusService);
  ngOnInit(): void { void this.admission.refresh(); }
}
