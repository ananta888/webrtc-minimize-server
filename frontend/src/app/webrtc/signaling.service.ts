import { Injectable, signal } from "@angular/core";

export interface ServerMessage {
  readonly version: number;
  readonly type: string;
  readonly [key: string]: unknown;
}

export const SERVER_MESSAGE_VERSIONS = Object.freeze({
  welcome: 1,
  "peer-joined": 1,
  "peer-left": 1,
  signal: 1,
  "media-state": 1,
  "topology-state": 1,
  "media-agent-state": 3,
  "media-agent-availability": 1,
  "media-agent-takeover-request": 1,
  "media-agent-signal": 1,
  "media-agent-track-state": 2,
  "media-agent-subscription-state": 2,
  "native-packager-signal": 1,
  "overlay-key": 1,
  error: 1,
} satisfies Readonly<Record<string, number>>);

export function validateServerMessageEnvelope(raw: unknown): ServerMessage | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  const type = value["type"];
  if (typeof type !== "string" || !Object.hasOwn(SERVER_MESSAGE_VERSIONS, type)) return null;
  if (value["version"] !== SERVER_MESSAGE_VERSIONS[type as keyof typeof SERVER_MESSAGE_VERSIONS]) return null;
  return value as ServerMessage;
}

@Injectable({ providedIn: "root" })
export class SignalingService {
  readonly status = signal<"idle" | "connecting" | "connected" | "error">("idle");
  readonly lastError = signal("");
  private socket: WebSocket | null = null;
  private handler: ((message: ServerMessage) => void) | null = null;
  private readonly subscribers = new Set<(message: ServerMessage) => void>();

  connect(path: string, handler: (message: ServerMessage) => void, onClose?: () => void): void {
    this.close();
    this.handler = handler;
    this.status.set("connecting");
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${protocol}//${location.host}${path}`);
    this.socket = socket;
    socket.onopen = () => this.status.set("connected");
    socket.onmessage = (event) => {
      try {
        const message = validateServerMessageEnvelope(JSON.parse(String(event.data)));
        if (!message) {
          this.lastError.set("invalid_server_message");
          return;
        }
        this.handler?.(message);
        for (const subscriber of this.subscribers) subscriber(message);
      } catch {
        this.lastError.set("invalid_server_message");
      }
    };
    socket.onerror = () => {
      this.lastError.set("signaling_failed");
      this.status.set("error");
    };
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.socket = null;
      if (this.status() !== "error") this.status.set("idle");
      onClose?.();
    };
  }

  send(message: object): void {
    if (this.socket?.readyState !== WebSocket.OPEN) throw new Error("signaling_not_connected");
    this.socket.send(JSON.stringify(message));
  }

  subscribe(handler: (message: ServerMessage) => void): () => void {
    this.subscribers.add(handler);
    return () => this.subscribers.delete(handler);
  }

  leave(): void {
    const socket = this.socket;
    if (socket?.readyState === WebSocket.OPEN) {
      try {
        socket.send(JSON.stringify({ type: "leave" }));
      } finally {
        this.close();
      }
      return;
    }
    this.close();
  }

  close(): void {
    const socket = this.socket;
    this.socket = null;
    this.handler = null;
    if (socket && socket.readyState < WebSocket.CLOSING) socket.close(1000, "client_leave");
    this.status.set("idle");
  }
}
