import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  SERVER_MESSAGE_VERSIONS,
  SignalingService,
  validateServerMessageEnvelope,
} from "./signaling.service";

class FakeWebSocket {
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static latest: FakeWebSocket | null = null;

  readonly readyState = FakeWebSocket.OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;

  constructor(readonly url: string) {
    FakeWebSocket.latest = this;
  }

  send(): void {}
  close(): void {}
}

describe("signaling server-message envelope", () => {
  beforeEach(() => {
    FakeWebSocket.latest = null;
    vi.stubGlobal("WebSocket", FakeWebSocket);
  });

  afterEach(() => vi.unstubAllGlobals());

  it("accepts every known server type only at its exact protocol version", () => {
    for (const [type, version] of Object.entries(SERVER_MESSAGE_VERSIONS)) {
      expect(validateServerMessageEnvelope({ version, type })).toEqual({ version, type });
      expect(validateServerMessageEnvelope({ version: version + 1, type })).toBeNull();
    }
    expect(validateServerMessageEnvelope({ version: 1, type: "future-authority" })).toBeNull();
    expect(validateServerMessageEnvelope([])).toBeNull();
  });

  it("dispatches versioned media-agent state while rejecting mismatched versions", () => {
    const service = new SignalingService();
    const received: Array<{ version: number; type: string }> = [];
    service.connect("/signal", (message) => received.push(message));
    const socket = FakeWebSocket.latest!;

    socket.onmessage?.({ data: JSON.stringify({ version: 3, type: "media-agent-state" }) } as MessageEvent);
    socket.onmessage?.({ data: JSON.stringify({ version: 2, type: "media-agent-track-state" }) } as MessageEvent);
    socket.onmessage?.({ data: JSON.stringify({ version: 2, type: "media-agent-subscription-state" }) } as MessageEvent);

    expect(received).toEqual([
      { version: 3, type: "media-agent-state" },
      { version: 2, type: "media-agent-track-state" },
      { version: 2, type: "media-agent-subscription-state" },
    ]);

    socket.onmessage?.({ data: JSON.stringify({ version: 1, type: "media-agent-state" }) } as MessageEvent);
    expect(received).toHaveLength(3);
    expect(service.lastError()).toBe("invalid_server_message");
  });
});
