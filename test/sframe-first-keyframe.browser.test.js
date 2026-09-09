import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { build } from "esbuild";
import { chromium, firefox } from "playwright";

// Isolate codec startup from Hub/room authorization. The keys and canvas are
// synthetic; only fixed counters leave the browser. Lose exactly one complete
// keyframe after RTP reception, as can happen before a receive key is available.
// A separate structural-failure case corrupts only its envelope version.
const fault = `{
  const listen = globalThis.addEventListener.bind(globalThis);
  globalThis.addEventListener = (type, callback, ...args) => {
    if (type !== 'rtctransform') return listen(type, callback, ...args);
    return listen(type, event => {
      const source = event.transformer;
      if (source.options.direction !== 'decrypt') return callback(event);
      let dropped = false;
      const readable = source.readable.pipeThrough(new TransformStream({
        transform(frame, controller) {
          if (!dropped && frame.type === 'key') {
            dropped = true; postMessage({type:'synthetic-first-keyframe-fault'});
            if (globalThis.syntheticFailure === 'drop') return;
            const bytes = new Uint8Array(frame.data); bytes[12] ^= 1;
          }
          controller.enqueue(frame);
        }
      }));
      callback({transformer:{options:source.options, readable, writable:source.writable}});
    }, ...args);
  };
}\n`;

for (const [name, engine] of Object.entries({ chromium, firefox })) {
  for (const failure of ["drop", "envelope"]) {
  test(`${name} ${failure === "drop" ? "recovers after keyframe loss" : "stays closed after structural envelope failure"}`,
    { timeout: 35000 }, async t => {
      const result = await build({ entryPoints: ["frontend/src/app/webrtc/sframe.worker.ts"],
        bundle: true, format: "iife", platform: "browser", write: false, logLevel: "silent" });
      const worker = `globalThis.syntheticFailure=${JSON.stringify(failure)};\n` + fault + result.outputFiles[0].text;
      const server = http.createServer((req, res) => {
        res.setHeader("Content-Type", req.url === "/worker.js" ? "text/javascript" : "text/html");
        res.end(req.url === "/worker.js" ? worker : "<!doctype html><title>Synthetic SFrame startup</title>");
      });
      t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
      await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
      const browser = await engine.launch({ headless: true });
      t.after(() => browser.close());
      const page = await browser.newPage();
      await page.goto(`http://127.0.0.1:${server.address().port}`);
      const observed = await page.evaluate(async failure => {
        let dropped = 0, decoded = 0, ticks = 0, structuralErrors = 0;
        const sender = new RTCPeerConnection({ iceServers: [] });
        const receiver = new RTCPeerConnection({ iceServers: [] });
        const workers = [], pendingIce = [[], []];
        const connectIce = (from, to, queue) => from.onicecandidate = event => {
          if (!event.candidate) return;
          if (!to.remoteDescription) queue.push(event.candidate);
          else void to.addIceCandidate(event.candidate);
        };
        connectIce(sender, receiver, pendingIce[0]); connectIce(receiver, sender, pendingIce[1]);
        const canvas = document.createElement("canvas"); canvas.width = 160; canvas.height = 90;
        const context = canvas.getContext("2d");
        const timer = setInterval(() => {
          context.fillStyle = ++ticks % 2 ? "red" : "green";
          context.fillRect(0, 0, 160, 90);
        }, 80);
        const stream = canvas.captureStream(12);
        const video = document.createElement("video"); video.muted = true; video.autoplay = true;
        const install = (target, direction) => {
          const worker = new Worker("/worker.js"); workers.push(worker);
          worker.onmessage = ({ data }) => {
            if (data?.type === "synthetic-first-keyframe-fault") dropped++;
            if (data?.type === "transform-error" && data?.code === "media_envelope_version") structuralErrors++;
          };
          worker.postMessage({version:1, type:"set-key", contextId:"synthetic", direction,
            keyId:"0000000000000001", baseKey:new Uint8Array(16).fill(7).buffer});
          target.transform = new RTCRtpScriptTransform(worker, {
            version:1, direction, contextId:"synthetic", frameEnvelope:"codec-prefix-v1",
          });
        };
        try {
          const transceiver = sender.addTransceiver(stream.getVideoTracks()[0], { direction: "sendonly" });
          transceiver.setCodecPreferences(RTCRtpSender.getCapabilities("video").codecs
            .filter(codec => codec.mimeType.toLowerCase() === "video/vp8"));
          install(transceiver.sender, "encrypt");
          receiver.ontrack = event => {
            install(event.receiver, "decrypt"); video.srcObject = new MediaStream([event.track]);
            document.body.append(video); void video.play();
          };
          await sender.setLocalDescription(await sender.createOffer());
          await receiver.setRemoteDescription(sender.localDescription);
          for (const candidate of pendingIce[0]) await receiver.addIceCandidate(candidate);
          await receiver.setLocalDescription(await receiver.createAnswer());
          await sender.setRemoteDescription(receiver.localDescription);
          for (const candidate of pendingIce[1]) await sender.addIceCandidate(candidate);
          const deadline = performance.now() + (failure === "drop" ? 20000 : 4000);
          let packets = 0, pli = 0, keyframes = 0;
          while (performance.now() < deadline) {
            for (const row of (await receiver.getStats()).values()) {
              if (row.type !== "inbound-rtp" || row.kind !== "video") continue;
              decoded = row.framesDecoded || 0; packets = row.packetsReceived || 0;
              pli = row.pliCount || 0; keyframes = row.keyFramesDecoded || 0;
            }
            if (failure === "drop" && dropped === 1 && decoded >= 3) break;
            await new Promise(resolve => setTimeout(resolve, 100));
          }
          return { dropped, decoded, packets, pli, keyframes, structuralErrors,
            connected:receiver.connectionState === "connected" };
        } finally {
          clearInterval(timer); stream.getTracks().forEach(track => track.stop());
          sender.close(); receiver.close(); workers.forEach(worker => worker.terminate());
          video.srcObject = null; video.remove();
        }
      }, failure);
      t.diagnostic(JSON.stringify(observed));
      assert.equal(observed.connected, true);
      assert.equal(observed.dropped, 1);
      if (failure === "drop") {
        assert.ok(observed.decoded >= 3, "decoder did not recover inside the fixed 20-second budget");
        assert.ok(observed.keyframes >= 1); assert.equal(observed.structuralErrors, 0);
      } else {
        assert.equal(observed.structuralErrors, 1);
        assert.ok(observed.packets >= 10, "closed transform must still be challenged by later RTP frames");
        assert.equal(observed.decoded, 0); assert.equal(observed.keyframes, 0);
      }
    });
  }
}
