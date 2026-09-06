import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const template = readFileSync("frontend/src/app/broadcast/broadcast-moderation-panel.component.html", "utf8");
const component = readFileSync("frontend/src/app/broadcast/broadcast-moderation-panel.component.ts", "utf8");

describe("BroadcastModerationPanelComponent", () => {
  it("distinguishes live local picture controls from consent and warns that slates do not mute audio", () => {
    expect(template).toContain('id="broadcast-local-video-status"');
    expect(template).toContain('id="broadcast-local-video-apply"');
    expect(template).toContain('id="broadcast-local-video-source"');
    expect(template).toContain('id="broadcast-local-video-error" role="alert"');
    expect(template).toContain("Lokale Bildregie bereit");
    expect(template).toContain("Ton und Sendung laufen weiter");
    expect(template).toContain("keine automatische Sprechererkennung");
    expect(component).toContain("expectedRevision: current.revision");
  });
  it("shows source consent, layout, one primary, standbys, handoff and stop controls", () => {
    for (const id of [
      "broadcast-moderation-panel", "broadcast-moderation-layout", "broadcast-layout-request",
      "broadcast-packager-request", "broadcast-moderation-stop",
    ]) expect(template).toContain(`id="${id}"`);
    expect(template).toContain("Meine Quelle sofort widerrufen");
    expect(template).toContain("Übergabe hierhin prüfen");
    expect(template).toContain("Standby ohne Decrypt-Schlüssel");
    expect(template).toContain("Blind-Media-Agenten sind keine Trusted Packager");
  });

  it("uses native keyboard-operable controls and a labelled confirmation dialog", () => {
    expect(template).not.toContain('tabindex="');
    expect(template).toContain('role="dialog"');
    expect(template).toContain('aria-labelledby="broadcast-confirmation-heading"');
    expect(template).toContain('aria-describedby="broadcast-confirmation-consequence"');
    expect(template).toContain('id="broadcast-confirm-action"');
    expect(component).not.toContain("getUserMedia");
    expect(component).not.toContain("getDisplayMedia");
  });

  it("bounds local standby selection to two and keeps the primary distinct", () => {
    expect(component).toContain("next.size < 2");
    expect(component).toContain("id !== agentId");
    expect(template).toContain("bis zu zwei schlüssellose Standbys");
  });

  it("renders stale revision or epoch conflicts as an alert", () => {
    expect(template).toContain('id="broadcast-moderation-conflict"');
    expect(template).toContain('role="alert"');
    expect(template).toContain("Aktualisiere die Ansicht und bestätige erneut");
  });
});
