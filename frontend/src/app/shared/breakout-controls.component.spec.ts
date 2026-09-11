import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const source = readFileSync("frontend/src/app/shared/breakout-controls.component.ts", "utf8");

describe("BreakoutControlsComponent", () => {
  it("requires an explicit click and never starts capture", () => {
    expect(source).toContain('id="breakout-confirm"');
    expect(source).toContain("breakouts.confirm()");
    expect(source).toContain("breakouts.open()");
    expect(source).not.toContain("getUserMedia");
    expect(source).not.toContain("getDisplayMedia");
    expect(source).not.toContain("innerHTML");
  });
});
