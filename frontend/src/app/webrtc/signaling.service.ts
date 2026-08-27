import { Injectable, signal } from "@angular/core";

export interface ServerMessage {
  readonly version: number;
  readonly type: string;
  readonly [key: string]: unknown;
}

@Injectable({ providedIn: "root" })
export class SignalingService {
  readonly status = signal<"idle" | "connecting" | "connected" | "error">("idle");
  readonly lastError = signal("");
  private socket: WebSocket | null = null;
  private handler: ((message: ServerMessage) => void) | null = null;

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
        const message = JSON.parse(String(event.data)) as ServerMessage;
        if (message.version === 1 && typeof message.type === "string") this.handler?.(message);
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

  close(): void {
    const socket = this.socket;
    this.socket = null;
    this.handler = null;
    if (socket && socket.readyState < WebSocket.CLOSING) socket.close(1000, "client_leave");
    this.status.set("idle");
  }
}
