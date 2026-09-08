import { afterEach, expect, it, vi } from "vitest";
import { MediaE2eeController } from "./media-e2ee-controller";

afterEach(() => vi.unstubAllGlobals());
it("notifies a source owner once on worker failure and terminates even when clearing cannot be posted", () => {
  const workers: FakeWorker[] = [];
  class FakeWorker extends EventTarget {
    postMessage = vi.fn(); terminate = vi.fn();
    constructor() { super(); workers.push(this); }
  }
  class Target {}
  Object.defineProperty(Target.prototype,"transform",{value:null,writable:true});
  vi.stubGlobal("Worker",FakeWorker);
  vi.stubGlobal("RTCRtpSender",Target);
  vi.stubGlobal("RTCRtpReceiver",Target);
  vi.stubGlobal("RTCRtpScriptTransform",class {});
  const failed = vi.fn(), controller = new MediaE2eeController(undefined,failed);
  expect(controller.attachSender(new Target() as RTCRtpSender,"source:fixture")).toBe(true);
  workers[0].postMessage.mockImplementation(() => {throw new Error("fixture failure");});
  workers[0].dispatchEvent(new Event("error"));
  workers[0].dispatchEvent(new Event("messageerror"));
  controller.destroy();
  expect(failed).toHaveBeenCalledTimes(1);
  expect(workers[0].terminate).toHaveBeenCalledTimes(1);
  expect(controller.attachSender(new Target() as RTCRtpSender,"source:new")).toBe(false);
  expect(controller.setSenderKey("source:fixture","0000000000000123",new Uint8Array(16))).toBe(false);
  expect(workers).toHaveLength(1);
  const meshFailure = vi.fn(), mesh = new MediaE2eeController(meshFailure);
  expect(mesh.attachSender(new Target() as RTCRtpSender,"mesh:fixture")).toBe(true);
  workers[1].dispatchEvent(new Event("messageerror"));
  expect(meshFailure).toHaveBeenCalledWith("", "media_worker_failed");
  expect(workers[1].terminate).toHaveBeenCalledTimes(1);
  mesh.destroy();
});
