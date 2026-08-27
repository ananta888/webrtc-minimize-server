import { ChangeDetectionStrategy, Component, OnInit, signal } from "@angular/core";
import { Router } from "@angular/router";

import { RuntimeConfigService } from "../core/runtime-config.service";
import { OidcAuthService } from "./oidc-auth.service";

@Component({
  selector: "app-oidc-callback",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <main class="callback-shell" aria-live="polite">
      <h1>Identität wird bestätigt</h1>
      <p>{{ status() }}</p>
      @if (failed()) { <a href="/">Zurück zur Anwendung</a> }
    </main>
  `,
})
export class OidcCallbackComponent implements OnInit {
  readonly status = signal("Keycloak-Antwort wird sicher geprüft …");
  readonly failed = signal(false);

  constructor(
    private readonly config: RuntimeConfigService,
    private readonly auth: OidcAuthService,
    private readonly router: Router,
  ) {}

  async ngOnInit(): Promise<void> {
    try {
      this.auth.configure(await this.config.load());
      const returnUrl = await this.auth.handleCallback();
      await this.router.navigateByUrl(returnUrl);
    } catch (error) {
      this.status.set(error instanceof Error ? error.message : "OIDC-Anmeldung fehlgeschlagen");
      this.failed.set(true);
    }
  }
}
