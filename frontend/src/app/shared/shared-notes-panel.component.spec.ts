import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const source = readFileSync("frontend/src/app/shared/shared-notes-panel.component.ts", "utf8");

describe("SharedNotesPanelComponent", () => {
  it("renders bounded plaintext/markdown textarea and explicit export actions without capture", () => {
    expect(source).toContain('id="shared-notes-textarea"');
    expect(source).toContain('id="notes-export-md"');
    expect(source).toContain('id="notes-export-txt"');
    expect(source).toContain('id="notes-clear"');
    expect(source).toContain("notes.charCount()");
    expect(source).toContain("notes.maxCharCount");
    expect(source).toContain("notes.export('md')");
    expect(source).toContain("notes.export('txt')");
    expect(source).not.toContain("innerHTML");
    expect(source).not.toContain("getUserMedia");
    expect(source).not.toContain("getDisplayMedia");
  });
});
