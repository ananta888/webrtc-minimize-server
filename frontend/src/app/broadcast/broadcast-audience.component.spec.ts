import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const template = readFileSync("frontend/src/app/broadcast/broadcast-audience.component.html", "utf8");
const component = readFileSync("frontend/src/app/broadcast/broadcast-audience.component.ts", "utf8");

describe("BroadcastAudienceComponent", () => {
  it("separates public, entitled private, owned and unavailable programs", () => {
    for (const heading of [
      "Öffentlich live", "Für mich freigegeben", "Meine Programme", "Beendet oder nicht erreichbar",
    ]) expect(template).toContain(heading);
    expect(template).toContain("Private Programme erscheinen erst nach OIDC-Anmeldung");
    expect(template).toContain("Private oder unbekannte Programme werden nicht unterschieden");
  });

  it("shows policy-safe metadata and embeds the explicit-start player", () => {
    for (const value of ["Besitzer", "Zuschauer", "Modus", "Untertitel"]) expect(template).toContain(value);
    expect(template).toContain("<app-broadcast-player");
    expect(template).toContain("aggregiert");
    expect(template).toContain("Zuschauen ohne Raumbeitritt");
  });

  it("does not auto-open playback or place grants in history", () => {
    expect(component).not.toContain("ngAfterViewInit");
    expect(component).toContain("this.directory.deepLink(entry.programId)");
    expect(component).not.toContain("deepLink(bootstrap.playbackGrant");
    expect(component).not.toContain("getUserMedia");
  });

  it("uses native buttons and alert/status semantics for accessible recovery", () => {
    expect(template).toContain('role="status"');
    expect(template).toContain('role="alert"');
    expect(template).toContain("Erneut versuchen");
    expect(template).not.toContain('tabindex="');
  });
});
