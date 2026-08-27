import { describe, expect, it } from "vitest";

import { parsePeerChat, parsePeerControl } from "./peer-control-protocol";

describe("peer control contracts", () => {
  it("accepts bounded activity and quality messages", () => {
    expect(parsePeerControl(JSON.stringify({ version: 1, type: "activity", sequence: 2, level: 0.5 }))).toEqual({ version: 1, type: "activity", sequence: 2, level: 0.5 });
    expect(parsePeerControl(JSON.stringify({ version: 1, type: "quality", sequence: 3, linkClass: "critical" }))).toEqual({ version: 1, type: "quality", sequence: 3, linkClass: "critical" });
  });

  it("rejects invalid or oversized peer payloads", () => {
    expect(parsePeerControl(JSON.stringify({ version: 1, type: "activity", sequence: 1, level: 4 }))).toBeNull();
    expect(parsePeerControl(JSON.stringify({ version: 1, type: "activity", sequence: 1, level: 0.2, extra: true }))).toBeNull();
    expect(parsePeerControl("x".repeat(2_049))).toBeNull();
    expect(parsePeerChat(JSON.stringify({ version: 1, type: "chat", text: "x".repeat(2_001) }))).toBeNull();
  });
});
