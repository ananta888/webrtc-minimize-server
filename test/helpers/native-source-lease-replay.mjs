import assert from "node:assert/strict";

// Synthetic-fixture fault injection only. Retain one actual server message,
// never manufacture authority, dump identifiers or expose a production hook.
export function captureFirstCameraLease(socket, now = Date.now) {
  const send = socket.send;
  let captured = null, expiresAt = 0, disposed = false;
  function observe(data, ...args) {
    if (!disposed && captured === null && typeof data === "string" && Buffer.byteLength(data) <= 8192) {
      try {
        const message = JSON.parse(data);
        if (message.version === 1 && message.type === "trusted-source-publisher-lease"
          && message.lease?.consent?.sourceKind === "camera"
          && Number.isSafeInteger(message.lease.expiresAt) && message.lease.expiresAt > now()) {
          captured = data; expiresAt = message.lease.expiresAt;
        }
      } catch { /* Unrelated/malformed messages remain untouched. */ }
    }
    return send.call(this, data, ...args);
  }
  socket.send = observe;
  const dispose = () => {
    disposed = true; captured = null; expiresAt = 0;
    if (socket.send === observe) socket.send = send;
  };
  return {
    replayExpired() {
      assert.ok(!disposed && captured !== null, "fixture did not capture a source lease");
      assert.ok(now() > expiresAt, "fixture source lease is not expired");
      const message = captured;
      dispose();
      return send.call(socket, message);
    },
    dispose,
  };
}
