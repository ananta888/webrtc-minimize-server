import { expect, it, vi } from "vitest";
import { MachineClientProbePorts, probeMachineClient } from "./machine-client-probe";

function setup() {
  const effect = vi.fn(() => { throw new Error("must not execute"); });
  const source = { open: effect, push: effect, close: effect, status: effect };
  const api = { join: effect, renew: effect, leave: effect, status: effect, publish: effect,
    chat: { ...source, poll: effect, ack: effect, reply: effect },
    audio: { ...source, sources: effect, poll: effect, ack: effect, reply: effect },
    screen: { ...source }, screenAudio: { ...source }, speech: { ...source }, avatar: { ...source, pulse: effect } };
  const runtime: MachineClientProbePorts = { secureContext: () => true, encodedTransform: () => true,
    codecs: (_direction, kind) => [{ mimeType: kind === "video" ? "video/VP8" : "audio/opus" }] };
  return { api, runtime, effect };
}

it("reports closed versioned feasibility without executing a source or join", () => {
  const { api, runtime, effect } = setup();
  expect(probeMachineClient(api, runtime)).toEqual({ schema: "ananta.meet-client-probe.v1",
    client: "isolated-browser-v1", frameEnvelope: "codec-prefix-v1", nativeAdapter: false,
    secureContext: true, encodedTransform: true,
    codecs: { vp8Send: true, vp8Receive: true, opusSend: true, opusReceive: true },
    ports: { session: true, mp4: true, chat: true, audio: true, screen: true, screenAudio: true, speech: true, avatar: true } });
  expect(effect).not.toHaveBeenCalled();
});

it("returns independently frozen copies and no caller or device metadata", () => {
  const { api, runtime } = setup();
  Object.assign(api, { privateScope: "secret", nativeAdapter: true });
  const first = probeMachineClient(api, runtime), second = probeMachineClient(api, runtime);
  expect(first).not.toBe(second); expect(first.ports).not.toBe(second.ports);
  expect([first, first.ports, first.codecs].every(Object.isFrozen)).toBe(true);
  expect(JSON.stringify(first)).not.toMatch(/secret|privateScope/);
});

it.each(["secureContext", "encodedTransform"] as const)("contains errors and truthy coercion from %s", key => {
  const { api, runtime } = setup();
  runtime[key] = () => { throw new Error("private runtime error"); };
  expect(probeMachineClient(api, runtime)[key]).toBe(false);
  runtime[key] = () => 1 as unknown as boolean;
  expect(probeMachineClient(api, runtime)[key]).toBe(false);
});

it("reports each direction independently, without H264 or unknown-codec fallback", () => {
  const { api, runtime } = setup();
  runtime.codecs = (direction, kind) => direction === "send" && kind === "audio" ? [{ mimeType: "audio/opus" }]
    : [{ mimeType: "video/H264" }, { mimeType: "audio/not-opus" }];
  expect(probeMachineClient(api, runtime).codecs).toEqual({ vp8Send: false, vp8Receive: false, opusSend: true, opusReceive: false });
});

it.each([null, {}, new Array(129).fill({ mimeType: "video/VP8" })])("rejects malformed or unbounded local codec lists", value => {
  const { api, runtime } = setup();
  runtime.codecs = () => value as never;
  expect(Object.values(probeMachineClient(api, runtime).codecs)).toEqual([false, false, false, false]);
});

it("codec exceptions affect only their own direction and never expose error details", () => {
  const { api, runtime } = setup();
  const normal = runtime.codecs;
  runtime.codecs = (direction, kind) => { if (direction === "receive") throw new Error("secret"); return normal(direction, kind); };
  expect(probeMachineClient(api, runtime).codecs).toEqual({ vp8Send: true, vp8Receive: false, opusSend: true, opusReceive: false });
});

it("missing methods cannot advertise a complete port; other ports remain independent", () => {
  const { api, runtime, effect } = setup();
  Reflect.deleteProperty(api.audio, "ack"); Reflect.deleteProperty(api, "renew");
  const value = probeMachineClient(api, runtime);
  expect(value.ports.audio).toBe(false); expect(value.ports.session).toBe(false);
  expect(value.ports.chat).toBe(true); expect(value.ports.speech).toBe(true); expect(effect).not.toHaveBeenCalled();
});

it("a broken port getter cannot poison unrelated capability observations", () => {
  const { api, runtime } = setup();
  Object.defineProperty(api, "screen", { get() { throw new Error("private"); } });
  expect(probeMachineClient(api, runtime).ports.screen).toBe(false);
  expect(probeMachineClient(api, runtime).ports.speech).toBe(true);
});
