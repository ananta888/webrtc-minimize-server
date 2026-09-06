import { ChangeDetectionStrategy, Component, Input, computed, signal } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { OwnedNativePackager } from "./native-packager-onboarding.service";
import { nativePackagerUpdateCommand, nativePackagerVerificationCommand } from "./native-packager-release";
import { NativePackagerReleaseService } from "./native-packager-release.service";
import { NativePackagerMigrationService } from "./native-packager-migration.service";

@Component({
  selector: "app-native-packager-update",
  standalone: true,
  imports: [FormsModule],
  providers: [NativePackagerMigrationService],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [":host{display:block;grid-column:1/-1;min-width:0} details{padding:.75rem;border:1px solid var(--border);border-radius:.75rem} pre,code{overflow-wrap:anywhere;white-space:pre-wrap} select,button{margin:.4rem} .warning{font-weight:600}"],
  template: `
    <details>
      <summary>Update und Herkunft prüfen</summary>
      <p>Nur auf diesem Gerät ausführen. Vorher laufende Broadcast-Zuweisungen beenden. Ein Serverdeployment aktualisiert diesen Benutzer-Agenten nicht automatisch.</p>
      <button type="button" [disabled]="catalog.busy()" (click)="catalog.load()">Release-Daten laden</button>
      @if (catalog.error()) { <p role="alert">{{ catalog.error() }}</p> }
      @if (catalog.release(); as release) {
        <p>Serverangebot: Agent {{ release.agentVersion }} · {{ release.builtAt }} · Go {{ release.goVersion }}</p>
        <code>{{ release.revision }}</code>
        <p class="warning">Noch nicht unabhängig verifiziert. Eine Prüfsumme vom Server ist keine Signaturprüfung im Browser.</p>
        <label>Architektur dieses Agent-Rechners
          <select [ngModel]="target()" (ngModelChange)="target.set($event)">
            <option value="">Bitte bewusst auswählen</option>
            @for (item of release.artifacts; track item.target) { @if (item.target.startsWith(packager.platform + '-')) { <option [value]="item.target">{{ item.target }}</option> } }
          </select>
        </label>
        @if (selected(); as artifact) {
          <p>{{ artifact.bytes }} Bytes · SHA-256: <code>{{ artifact.sha256 }}</code></p>
          <p>1. Beide Dateien in einen neuen Prüfordner herunterladen. Dort mit einer aktuellen GitHub CLI unabhängig prüfen; beide Befehle müssen erfolgreich sein.</p>
          <a href="/downloads/native-packager/release.json" download="native-packager-release.v1.json">Release-Manifest</a> ·
          <a [href]="'/downloads/native-packager/' + artifact.target" [attr.download]="artifact.filename">Binärdatei zur Prüfung</a>
          <pre>{{ verify(release) }}</pre><pre>{{ verify(release, artifact) }}</pre>
          <p>2. Die Revision zusätzlich mit dem beabsichtigten GitHub-Release/Commit vergleichen. Ein gültiger alter Nachweis beweist nicht, dass dies die neueste oder freigegebene Version ist.</p>
          <p>3. Erst danach den bereits lokal installierten Updater starten. Er lädt erneut und prüft diesen exakten Hash. Bei einem zwischenzeitlichen Deployment bricht er ab.</p>
          <pre>{{ update(packager.id, packager.platform, artifact) }}</pre>
          <p>Fehlt update-{{ packager.id }}, nicht neu registrieren oder alte Uninstaller ausführen: Diese Bestandsinstallation benötigt eine Migration. Docker-Installationen verwenden stattdessen ihren Deployment-Runner. Keine automatische Plattformsignatur-, Keystore- oder Reboot-Freigabe.</p>
          @if (packager.platform === 'linux') {
            <details class="legacy-migration">
              <summary>Alte gemeinsame Linux-Installation migrieren</summary>
              <p>Nur für das historische gemeinsame Benutzerverzeichnis, nicht für Docker oder bereits ID-isolierte Installationen. Eigene Geräteidentität bleibt erhalten, keine neue Registrierung. Angepasste Units oder abweichende Konfiguration werden abgelehnt.</p>
              <p>Andere noch alte Uninstaller können das gesamte Basisverzeichnis löschen: nicht ausführen. Vorher Broadcast-Zuweisungen beenden. Die Migrationsdatei stammt über HTTPS aus dieser Anwendung; der GitHub-Nachweis oben gilt nur für Manifest und Binärdatei, nicht für das personalisierte Skript.</p>
              <button type="button" [disabled]="migration.busy()" (click)="migration.download(packager.id, release, artifact)">Linux-Migrationsdatei herunterladen</button>
              @if (migration.error()) { <p role="alert">{{ migration.error() }}</p> }
              @if (migration.filenameFor(packager.id, release, artifact); as filename) {
                <p>Datei prüfen und auf dem Linux-Agenten speichern. Erst nach unabhängiger Prüfung der Binärdatei lokal ausführen:</p>
                <pre>sh ./{{ filename }} migrate {{ artifact.sha256 }}</pre>
                <p>Bei Abbruch dieselbe gespeicherte Datei mit <code>recover</code> aufrufen. Eine Kopie liegt im privaten Verzeichnis <code>.migration-{{ packager.id }}</code> neben den alten Dateien.</p>
                <p>Nach Erfolg Online-Status und Konto in dieser App prüfen. Erst danach entfernt <code>purge</code> die private Migrationssicherung. Der alte private Schlüssel bleibt zunächst zusätzlich im Legacy-Verzeichnis erhalten und darf niemals hochgeladen werden.</p>
              }
            </details>
          }
        }
      }
    </details>`,
})
export class NativePackagerUpdateComponent {
  @Input({ required: true }) packager!: OwnedNativePackager;
  readonly target = signal("");
  readonly selected = computed(() => this.catalog.release()?.artifacts.find(item => item.target === this.target()) || null);
  readonly verify = nativePackagerVerificationCommand;
  readonly update = nativePackagerUpdateCommand;
  constructor(readonly catalog: NativePackagerReleaseService, readonly migration: NativePackagerMigrationService) {}
}
