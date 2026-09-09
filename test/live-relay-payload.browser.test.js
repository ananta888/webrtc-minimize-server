import assert from "node:assert/strict";
import test from "node:test";
import { liveRelayPayload } from "../scripts/live-relay-payload.mjs";
import { machineBrowserFixture } from "./helpers/machine-browser-fixture.js";

for (const icePath of ["turn-udp", "turn-tcp"]) test(`bounded live payload function on private authenticated ${icePath}`, {
  skip: process.env.RUN_PRIVATE_TURN_PROBE !== "1" && "set RUN_PRIVATE_TURN_PROBE=1 for the owned private TURN fixture",
  timeout: 90000,
}, async context => {
  const fixture = await machineBrowserFixture(context, { icePath, externalMachine: true });
  // The fixture wrapper accepts only credentials from its real authorized
  // session response. This unnegotiated peer retrieves that configuration;
  // it sends nothing and creates no TURN allocation.
  const servers = await fixture.human.evaluate(() => {
    const peer = new RTCPeerConnection();
    try { return peer.getConfiguration().iceServers; }
    finally { peer.close(); }
  });
  const result = await fixture.human.evaluate(liveRelayPayload, servers);
  assert.equal(result.selectedRelayPairs, 2);
  assert.equal(result.payloadBytesEachDirection, 32);
  assert.ok(result.relayCount >= 2 && result.candidateCount >= result.relayCount);
  assert.equal(await fixture.human.evaluate(() => window.__captures), 0);
  assert.equal(await fixture.human.evaluate(() => window.__pcs.every(peer => peer.connectionState === "closed")), true);
  assert.equal(fixture.proxyObservation().connectionDrops, 0);
  context.diagnostic(JSON.stringify({ ...result, scope: "private-same-browser-synthetic-datachannel",
    applicationMediaVerified: false, externalReceiverVerified: false, productionReleaseEvidence: false }));
});
