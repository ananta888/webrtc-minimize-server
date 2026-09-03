import { describe, expect, it } from "vitest";

import {
  encodeMediaAgentNegotiationControl,
  MEDIA_AGENT_NEGOTIATION_CONTROL_MAX_BYTES,
  parseMediaAgentNegotiationControl,
} from "./media-agent-negotiation-control";

describe("browser-agent negotiation control", () => {
  it("round-trips the exact request and grant variants", () => {
    for (const type of ["media-agent-negotiation-request", "media-agent-negotiation-grant"] as const) {
      const message = { version: 1 as const, type, routeEpoch: 7, sequence: 3 };
      expect(parseMediaAgentNegotiationControl(encodeMediaAgentNegotiationControl(message))).toEqual(message);
    }
  });

  it("rejects unknown, stale, malformed and oversized envelopes", () => {
    const valid = { version: 1, type: "media-agent-negotiation-request", routeEpoch: 7, sequence: 3 };
    expect(parseMediaAgentNegotiationControl(JSON.stringify({ ...valid, authority: true }))).toBeNull();
    expect(parseMediaAgentNegotiationControl(JSON.stringify({ ...valid, version: 2 }))).toBeNull();
    expect(parseMediaAgentNegotiationControl(JSON.stringify({ ...valid, routeEpoch: 0 }))).toBeNull();
    expect(parseMediaAgentNegotiationControl(JSON.stringify({ ...valid, sequence: 0 }))).toBeNull();
    expect(parseMediaAgentNegotiationControl("not-json")).toBeNull();
    expect(parseMediaAgentNegotiationControl("x".repeat(MEDIA_AGENT_NEGOTIATION_CONTROL_MAX_BYTES + 1))).toBeNull();
  });
});
