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

  readyState = FakeWebSocket.OPEN;
  readonly sent: string[] = [];
  readonly closes: Array<{ code?: number; reason?: string }> = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;

  constructor(readonly url: string) {
    FakeWebSocket.latest = this;
  }

  send(value: string): void { this.sent.push(value); }
  close(code?: number, reason?: string): void {
    this.closes.push({ code, reason });
    this.readyState = FakeWebSocket.CLOSING;
  }
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

  it("sends the explicit leave control before closing the transport", () => {
    const service = new SignalingService();
    service.connect("/signal", () => undefined);
    const socket = FakeWebSocket.latest!;

    service.leave();

    expect(socket.sent).toEqual([JSON.stringify({ type: "leave" })]);
    expect(socket.closes).toEqual([{ code: 1000, reason: "client_leave" }]);
    expect(service.status()).toBe("idle");
  });
});
