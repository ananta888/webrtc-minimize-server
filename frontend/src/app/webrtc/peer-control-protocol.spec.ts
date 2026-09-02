import { describe, expect, it } from "vitest";

import {
  MAX_CONTROL_BYTES,
  MAX_MESH_TELEMETRY_LINKS,
  parsePeerChat,
  parsePeerControl,
} from "./peer-control-protocol";

describe("peer control contracts", () => {
  it("accepts bounded activity, link quality and receive-quality messages", () => {
    expect(parsePeerControl(JSON.stringify({ version: 1, type: "activity", sequence: 2, level: 0.5 }))).toEqual({ version: 1, type: "activity", sequence: 2, level: 0.5 });
    expect(parsePeerControl(JSON.stringify({ version: 1, type: "quality", sequence: 3, linkClass: "critical" }))).toEqual({ version: 1, type: "quality", sequence: 3, linkClass: "critical" });
    expect(parsePeerControl(JSON.stringify({ version: 1, type: "receive-quality", sequence: 4, profile: "audio-only" }))).toEqual({ version: 1, type: "receive-quality", sequence: 4, profile: "audio-only" });
    expect(parsePeerControl(JSON.stringify({ version: 1, type: "mesh-analysis-interest", sequence: 5, active: true }))).toEqual({ version: 1, type: "mesh-analysis-interest", sequence: 5, active: true });
  });

  it("accepts only closed, bounded mesh telemetry targets and rate tuples", () => {
    const message = {
      version: 1,
      type: "mesh-telemetry",
      sequence: 5,
      links: [{
        targetKind: "peer",
        targetId: "0123456789abcdef",
        rates: [1_000, 2_000, 100, 200, 300, 400, 500, 600, 50, 60],
      }],
    };
    expect(parsePeerControl(JSON.stringify(message))).toEqual(message);
    expect(parsePeerControl(JSON.stringify({
      ...message,
      links: [{ ...message.links[0], secret: "no" }],
    }))).toBeNull();
    expect(parsePeerControl(JSON.stringify({
      ...message,
      links: [{ ...message.links[0], rates: [1, 2] }],
    }))).toBeNull();
    expect(parsePeerControl(JSON.stringify({
      ...message,
      links: [message.links[0], message.links[0]],
    }))).toBeNull();
    expect(parsePeerControl(JSON.stringify({
      ...message,
      links: [{ ...message.links[0], targetKind: "media-agent", targetId: "UPPERCASE" }],
    }))).toBeNull();

    const maximum = {
      ...message,
      links: Array.from({ length: MAX_MESH_TELEMETRY_LINKS }, (_, index) => index < 19 ? ({
        targetKind: "peer",
        targetId: index.toString(16).padStart(16, "0"),
        rates: [1_000_000_000, 1_000_000_000, ...Array(8).fill(200_000_000)],
      }) : ({
        targetKind: "media-agent",
        targetId: `edge-agent-${index}`,
        rates: [1_000_000_000, 1_000_000_000, ...Array(8).fill(200_000_000)],
      })),
    };
    const encoded = JSON.stringify(maximum);
    expect(new TextEncoder().encode(encoded).byteLength).toBeLessThanOrEqual(MAX_CONTROL_BYTES);
    expect(parsePeerControl(encoded)?.type).toBe("mesh-telemetry");
    expect(parsePeerControl(JSON.stringify({
      ...maximum,
      links: [...maximum.links, maximum.links[0]],
    }))).toBeNull();
  });

  it("rejects invalid or oversized peer payloads", () => {
    expect(parsePeerControl(JSON.stringify({ version: 1, type: "activity", sequence: 1, level: 4 }))).toBeNull();
    expect(parsePeerControl(JSON.stringify({ version: 1, type: "activity", sequence: 1, level: 0.2, extra: true }))).toBeNull();
    expect(parsePeerControl(JSON.stringify({ version: 1, type: "receive-quality", sequence: 2, profile: "ultra" }))).toBeNull();
    expect(parsePeerControl(JSON.stringify({ version: 1, type: "receive-quality", sequence: 2, profile: "low", extra: true }))).toBeNull();
    expect(parsePeerControl(JSON.stringify({ version: 1, type: "mesh-analysis-interest", sequence: 3, active: "yes" }))).toBeNull();
    expect(parsePeerControl("x".repeat(MAX_CONTROL_BYTES + 1))).toBeNull();
    expect(parsePeerChat(JSON.stringify({ version: 1, type: "chat", text: "x".repeat(2_001) }))).toBeNull();
  });
});
