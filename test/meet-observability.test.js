import assert from "node:assert/strict";
import test from "node:test";

import { MeetObservability, MeetObservabilityError } from "../src/meet-observability.js";

test("meet counters stay content-free and closed", () => {
  const metrics = new MeetObservability();
  metrics.join("admitted");
  metrics.join("denied");
  metrics.sessionOpen();
  metrics.sessionOpen();
  metrics.sessionClose();
  metrics.message("rate_limited");
  metrics.message("protocol_error");
  metrics.turn("infrastructure", 1);
  metrics.turn("peer-edge", 2);
  const snapshot = metrics.snapshot();
  assert.deepEqual(snapshot, {
    sessions: 1,
    joins: { admitted: 1, denied: 1 },
    messages: { rate_limited: 1, protocol_error: 1 },
    turnCredentials: { infrastructure: 1, "peer-edge": 2 },
  });
  assert.doesNotMatch(JSON.stringify(snapshot), /room|sdp|ice|ticket|token|name|https:\/\//i);
  assert.throws(() => metrics.join("owner"), (error) => error instanceof MeetObservabilityError);
  metrics.destroy();
  assert.throws(() => metrics.snapshot(), (error) => error instanceof MeetObservabilityError);
});
