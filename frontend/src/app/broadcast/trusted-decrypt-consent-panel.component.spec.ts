import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const template = readFileSync(
  "frontend/src/app/broadcast/trusted-decrypt-consent-panel.component.html", "utf8",
);
const component = readFileSync(
  "frontend/src/app/broadcast/trusted-decrypt-consent-panel.component.ts", "utf8",
);

describe("TrustedDecryptConsentPanelComponent", () => {
  it("shows exact source, packager, device, purpose and expiry before an individual approval click", () => {
    for (const binding of [
      "candidate.sourceLabel", "candidate.sourceKind", "candidate.programTitle",
      "candidate.packagerLabel", "candidate.deviceLabel", "candidate.expiresAt", "Live-Broadcast",
    ]) expect(template).toContain(binding);
    expect(template).toContain('(click)="approve(candidate)"');
    expect(template).toContain("Diese eine Quelle freigeben");
    expect(component).toContain("this.authorizeRequest.emit(candidate)");
    expect(component).not.toContain("ngOnInit");
    expect(component).not.toContain("effect(");
  });

  it("shows active target bindings and revokes only the clicked consent", () => {
    for (const binding of [
      "consent.sourceId", "consent.granteePackagerRef", "consent.granteeDeviceRef", "consent.sourceKind",
    ]) expect(template).toContain(binding);
    expect(template).toContain('(click)="revoke(consent.consentId)"');
    expect(component).toContain("this.revokeRequest.emit(consentId)");
    expect(template).toContain("keine Raum-E2EE");
  });
});
