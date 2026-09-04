import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const template = readFileSync("frontend/src/app/broadcast/broadcast-player.component.html", "utf8");

describe("BroadcastPlayerComponent viewer controls", () => {
  it("shows audio, latency, fullscreen, captions-capable video and bounded quality modes", () => {
    expect(template).toContain("Ton einschalten");
    expect(template).toContain("Live-Abstand:");
    expect(template).toContain("Vollbild");
    expect(template).toContain('id="broadcast-player-captions"');
    expect(template).toContain('[attr.aria-pressed]="captionsVisible()"');
    expect(template).toContain('id="broadcast-viewer-quality-mode"');
    for (const mode of ["auto", "data-saver", "low", "medium", "high"]) {
      expect(template).toContain(`<option value="${mode}">`);
    }
  });
});
