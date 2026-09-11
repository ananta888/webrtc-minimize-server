import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const source = readFileSync("frontend/src/app/shared/poll-panel.component.ts", "utf8");

describe("PollPanelComponent", () => {
  it("renders poll creation, voting, and result export without capture", () => {
    expect(source).toContain('id="poll-question-input"');
    expect(source).toContain('id="poll-start-button"');
    expect(source).toContain('id="poll-publish-results"');
    expect(source).toContain('id="poll-close-poll"');
    expect(source).toContain('id="poll-export-results"');
    expect(source).toContain("poll.vote($index)");
    expect(source).toContain("poll.publishResults()");
    expect(source).toContain("poll.closePoll()");
    expect(source).toContain("poll.exportResults()");
    expect(source).not.toContain("innerHTML");
    expect(source).not.toContain("getUserMedia");
    expect(source).not.toContain("getDisplayMedia");
  });
});
