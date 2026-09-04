import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const template = readFileSync("frontend/src/app/broadcast/broadcast-preflight.component.html", "utf8");
const component = readFileSync("frontend/src/app/broadcast/broadcast-preflight.component.ts", "utf8");

describe("BroadcastPreflightComponent audio policy", () => {
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
});
