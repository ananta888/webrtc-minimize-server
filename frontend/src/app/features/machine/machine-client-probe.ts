import { supportsMediaE2ee } from "../../webrtc/media-e2ee-controller";

export interface MachineClientProbePorts {
  secureContext(): boolean;
  encodedTransform(): boolean;
  codecs(direction: "send" | "receive", kind: "audio" | "video"): readonly { mimeType: string }[];
}

const REQUIRED_METHODS = {
  session: ["join", "renew", "leave", "status"], mp4: ["publish"],
  chat: ["open", "poll", "ack", "reply", "close", "status"],
  audio: ["sources", "open", "poll", "ack", "reply", "close", "status"],
  screen: ["open", "push", "close", "status"], screenAudio: ["open", "push", "close", "status"],
  speech: ["open", "push", "close", "status"], avatar: ["open", "pulse", "close", "status"],
} as const;

export interface MachineClientProbe {
  readonly schema: "ananta.meet-client-probe.v1";
  readonly client: "isolated-browser-v1";
  readonly frameEnvelope: "codec-prefix-v1";
  readonly nativeAdapter: false;
  readonly secureContext: boolean;
  readonly encodedTransform: boolean;
  readonly codecs: Readonly<{ vp8Send: boolean; vp8Receive: boolean; opusSend: boolean; opusReceive: boolean }>;
  readonly ports: Readonly<Record<keyof typeof REQUIRED_METHODS, boolean>>;
}

const browserPorts: MachineClientProbePorts = {
  secureContext: () => globalThis.isSecureContext === true,
  encodedTransform: supportsMediaE2ee,
  codecs: (direction, kind) => {
    const endpoint = direction === "send" ? globalThis.RTCRtpSender : globalThis.RTCRtpReceiver;
    return endpoint?.getCapabilities?.(kind)?.codecs ?? [];
  },
};

function observed(check: () => boolean): boolean {
  try { return check() === true; } catch { return false; }
}

/** Local feasibility only. Never calls source, membership, capture or crypto ports. */
export function probeMachineClient(api: object, runtime: MachineClientProbePorts = browserPorts): MachineClientProbe {
  const codec = (direction: "send" | "receive", kind: "audio" | "video", name: string) => observed(() => {
    const values = runtime.codecs(direction, kind);
    return Array.isArray(values) && values.length <= 128 && values.some(value =>
      typeof value?.mimeType === "string" && value.mimeType.toLowerCase() === `${kind}/${name}`);
  });
  const ports = Object.fromEntries(Object.entries(REQUIRED_METHODS).map(([name, methods]) => [name, observed(() => {
    const target = name === "session" || name === "mp4" ? api : Reflect.get(api, name);
    return target !== null && typeof target === "object" && methods.every(method => typeof Reflect.get(target, method) === "function");
  })])) as Record<keyof typeof REQUIRED_METHODS, boolean>;
  return Object.freeze({
    schema: "ananta.meet-client-probe.v1", client: "isolated-browser-v1", frameEnvelope: "codec-prefix-v1",
    nativeAdapter: false, secureContext: observed(runtime.secureContext), encodedTransform: observed(runtime.encodedTransform),
    codecs: Object.freeze({ vp8Send: codec("send", "video", "vp8"), vp8Receive: codec("receive", "video", "vp8"),
      opusSend: codec("send", "audio", "opus"), opusReceive: codec("receive", "audio", "opus") }),
    ports: Object.freeze(ports),
  });
}
