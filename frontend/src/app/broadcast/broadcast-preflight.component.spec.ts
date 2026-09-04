import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const template = readFileSync("frontend/src/app/broadcast/broadcast-preflight.component.html", "utf8");
const component = readFileSync("frontend/src/app/broadcast/broadcast-preflight.component.ts", "utf8");

describe("BroadcastPreflightComponent audio policy", () => {
  it("shows delivery, packager, resource and trust summaries without pretending runtime readiness", () => {
    expect(template).toContain('id="broadcast-delivery-profile"');
    expect(template).toContain('id="broadcast-packager-profile"');
    expect(template).toContain('id="broadcast-cpu-estimate"');
    expect(template).toContain('id="broadcast-start-summary"');
    expect(template).toContain('id="broadcast-start-disabled"');
    expect(template).toContain("Blind-Media-Agenten sind keine Trusted Packager");
    expect(template).toContain("Sendestart noch nicht mit der Control Plane verbunden");
    expect(template).toContain("<app-broadcast-moderation-panel");
    expect(template).toContain('[connected]="false"');
    expect(component).toContain("estimatedCpuClass");
  });

  it("exposes bounded speech, balanced and music profiles plus an echo-safe monitor default", () => {
    expect(template).toContain('id="broadcast-audio-profile"');
    expect(template).toContain('<option value="speech">');
    expect(template).toContain('<option value="balanced">');
    expect(template).toContain('<option value="music">');
    expect(template).toContain('id="broadcast-audio-monitoring"');
    expect(template).toContain('<option value="off">Aus · sichere Echo-Voreinstellung</option>');
    expect(template).toContain("Raumwiedergabe und Talkback werden niemals in den Programmbus zurückgeführt");
    expect(template).toContain("Monitoring über Lautsprecher kann ein Echo erzeugen");
  });

  it("changes monitoring only through the concrete local select event and never captures itself", () => {
    expect(template).toContain('(change)="setAudioMonitoring($any($event.target).value)"');
    expect(component).toContain('this.audioSettings.setMonitoring(value, "user-action")');
    expect(component).not.toContain("getUserMedia");
    expect(component).not.toContain("getDisplayMedia");
  });

  it("offers every bounded compositor layout and fixed output profile", () => {
    expect(template).toContain('id="broadcast-video-layout"');
    for (const layout of ["single", "screen-presenter", "side-by-side", "active-speaker", "grid", "waiting-slate", "end-slate"]) {
      expect(template).toContain(`<option value="${layout}">`);
    }
    expect(template).toContain('id="broadcast-video-profile"');
    for (const profile of ["bandwidth", "balanced", "screen-text", "quality"]) {
      expect(template).toContain(`<option value="${profile}">`);
    }
    expect(template).toContain("Titel, Namen und Untertitel bleiben standardmäßig aus");
  });
});
