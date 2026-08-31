import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const component = readFileSync("frontend/src/app/shared/media-control-bar.component.ts", "utf8");

describe("MediaControlBarComponent", () => {
  it("offers screen sharing through the same explicit control in every room mode", () => {
    expect(component).toContain('id="toggle-screen"');
    expect(component).toContain("(click)=\"media.toggle('screen')\"");
    expect(component).toContain("Bildschirm teilen");
    expect(component).not.toContain("session.mode");
  });

  it("keeps all capture actions disabled until session membership is active", () => {
    expect(component.match(/\[disabled\]="!session\.joined\(\) \|\| !!media\.pending\(\)"/g)).toHaveLength(3);
    expect(component).not.toContain("getUserMedia");
    expect(component).not.toContain("getDisplayMedia");
  });
});
