import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { build } from "esbuild";
import { chromium, firefox } from "playwright";
import Ajv from "ajv/dist/2020.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const validateWire = new Ajv({ strict: true }).compile(JSON.parse(await fs.readFile(
  new URL("../contracts/trusted-decrypt/wire.v1.schema.json", import.meta.url), "utf8")));
function assertClosedWire(value) {
  assert.equal(validateWire(value), true, JSON.stringify(validateWire.errors));
  assert.equal(validateWire({ ...value, unexpected: true }), false);
  for (const field of Object.keys(value)) {
    const missing = { ...value }; delete missing[field];
    assert.equal(validateWire(missing), false, `wire accepted missing ${field}`);
  }
}
let directory, executable, bundle, dockerRunner;
before(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "webrtc-trusted-sframe-"));
  executable = path.join(directory, "decoder.test");
  const args = ["test", "-c", "-o", executable, "./internal/trustedsframe"];
  const local = spawnSync("go", ["version"], { encoding: "utf8", timeout: 10_000 });
  dockerRunner = Boolean(local.error || local.status !== 0);
  const result = !dockerRunner
    ? spawnSync("go", args, { cwd: path.join(root, "native-broadcast-packager"), encoding: "utf8", timeout: 90_000 })
    : spawnSync("docker", ["run", "--rm", "-v", `${root}:/workspace:ro`, "-v", `${directory}:/out`,
      "-w", "/workspace/native-broadcast-packager", "golang:1.24-alpine", "go", "test", "-c", "-o", "/out/decoder.test",
      "./internal/trustedsframe"], { encoding: "utf8", timeout: 90_000 });
  assert.equal(result.status, 0, `native decoder test build failed: ${result.error?.message || result.stderr}`);
  const resultJS = await build({ stdin: { resolveDir: root, contents: `
    import { SFrameEncryptContext } from "./frontend/src/app/webrtc/sframe-codec";
    import { encryptMediaFrame } from "./frontend/src/app/webrtc/sframe-media-envelope";
    import { sealTrustedDecryptKey } from "./frontend/src/app/broadcast/trusted-decrypt-key-lifecycle";
    const hex = bytes => [...bytes].map(b => b.toString(16).padStart(2,"0")).join("");
    window.generateSFrameFixture = async codec => {
      const base = Uint8Array.from({length:16},(_,i)=>i);
      const sender = new SFrameEncryptContext(291n,base);
      const Frames = [];
      try {
        for(let counter=0;counter<=400;counter++) {
          const key = counter%30===0;
          const prefix = codec==="audio/opus" ? [0x78] : key ? [0,0,0,0x9d,1,0x2a,64,0,64,0] : [1,0,0];
          const data = Uint8Array.from([...prefix, ...Array.from({length:32},(_,i)=>(counter+i)%256)]);
          const frame = {data:data.buffer,getMetadata:()=>({mimeType:codec}),
            ...(codec==="video/vp8"?{type:key?"key":"delta"}:{})};
          Frames.push({Wire:hex(await encryptMediaFrame(sender,frame)),Plain:hex(data)});
        }
        return {Codec:codec,Base:hex(base),KID:291,Frames};
      } finally {sender.destroy();base.fill(0)}
    };
    window.generateTrustedSFrameFixture = async handshake => {
      const fixture = await window.generateSFrameFixture(handshake.codec);
      const baseKey = Uint8Array.from({length:16},(_,i)=>i);
      try {
        return {Envelope:await sealTrustedDecryptKey({consent:handshake.consent,announcement:handshake.announcement,
          keyId:"0000000000000123",baseKey,now:handshake.now}),Frames:fixture.Frames};
      } finally {baseKey.fill(0)}
    };
  ` }, bundle: true, format: "iife", platform: "browser", write: false, logLevel: "silent" });
  bundle = resultJS.outputFiles[0].contents;
});
after(async () => { if (directory) await fs.rm(directory, { recursive: true, force: true }); });

async function verifyReceiver(page, codec) {
  const flags = ["-test.run=^TestReceiverBrowserInterop$", "-test.timeout=12s"];
  const container = `webrtc-trusted-key-test-${randomUUID()}`;
  const child = spawn(dockerRunner ? "docker" : executable, dockerRunner ? [
    "run", "-i", "--rm", "--name", container, "--network", "none", "-e", "TRUSTED_SFRAME_RECEIVER_INTEROP=1",
    "-e", `TRUSTED_SFRAME_RECEIVER_CODEC=${codec}`, "-v", `${directory}:/fixture:ro`,
    "golang:1.24-alpine", "/fixture/decoder.test", ...flags,
  ] : flags, { env: { ...process.env, TRUSTED_SFRAME_RECEIVER_INTEROP: "1", TRUSTED_SFRAME_RECEIVER_CODEC: codec }, stdio: ["pipe", "pipe", "pipe"] });
  let output = "", error = "", firstReceived = false, resolveFirst;
  const first = new Promise(resolve => { resolveFirst = resolve; });
  child.stdout.on("data", data => {
    output += data.toString();
    if (output.length > 16384) { child.kill(); return; }
    if (!firstReceived && output.includes("\n")) { firstReceived = true; resolveFirst(output.split("\n", 1)[0]); }
  });
  child.stderr.on("data", data => { error += data.toString(); if (error.length > 16384) child.kill(); });
  child.on("error", err => { error = err.message; });
  child.stdin.on("error", () => {}); // Exit status is authoritative after early native rejection.
  const exited = new Promise(resolve => child.once("close", code => resolve(code)));
  const timer = setTimeout(() => child.kill("SIGKILL"), 15000);
  try {
    const line = await Promise.race([first, exited.then(() => { throw new Error("native receiver ended before key announcement"); })]);
    const handshake = JSON.parse(line);
    assert.equal(handshake.codec, codec);
    assertClosedWire(handshake.consent);
    assertClosedWire(handshake.announcement);
    const fixture = await page.evaluate(handshake => window.generateTrustedSFrameFixture(handshake), handshake);
    assertClosedWire(fixture.Envelope);
    child.stdin.end(JSON.stringify(fixture));
    assert.equal(await exited, 0, `native key-envelope interop failed: ${error || output.slice(output.indexOf("\n") + 1)}`);
    assert.match(output, /PASS/);
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
    if (dockerRunner) {
      const cleanup = spawnSync("docker", ["rm", "--force", container], { encoding: "utf8", timeout: 5000 });
      assert.ok(cleanup.status === 0 || /No such container/.test(cleanup.stderr || ""), "isolated native test container cleanup failed");
    }
  }
}

for (const [name, engine] of [["Chromium", chromium], ["Firefox", firefox]]) {
  test(`${name} codec-prefix-v1 WebCrypto keys and frames decrypt in native Trusted-Packager through counter 400`, { timeout: 60_000 }, async t => {
    const app = http.createServer((request, response) => {
      response.setHeader("content-type", request.url === "/fixture.js" ? "text/javascript" : "text/html");
      response.end(request.url === "/fixture.js" ? bundle : '<!doctype html><script src="/fixture.js"></script>');
    });
    t.after(() => new Promise(resolve => app.close(resolve)));
    await new Promise(resolve => app.listen(0, "127.0.0.1", resolve));
    const browser = await engine.launch({ headless: true });
    t.after(() => browser.close());
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${app.address().port}`);
    for (const codec of ["video/vp8", "audio/opus"]) {
      const fixture = await page.evaluate(codec => window.generateSFrameFixture(codec), codec);
      const runArgs = ["-test.run=^TestBrowserInterop$", "-test.v"];
      // A Linux binary produced by the fallback is also executed there; never
      // assume the host is Linux merely because Docker is available.
      const result = spawnSync(dockerRunner ? "docker" : executable, dockerRunner ? [
        "run", "-i", "--rm", "--network", "none", "-e", "TRUSTED_SFRAME_BROWSER_INTEROP=1",
        "-v", `${directory}:/fixture:ro`, "golang:1.24-alpine", "/fixture/decoder.test", ...runArgs,
      ] : runArgs, {
        input: JSON.stringify(fixture), env: { ...process.env, TRUSTED_SFRAME_BROWSER_INTEROP: "1" },
        encoding: "utf8", timeout: 10_000, maxBuffer: 1024 * 1024,
      });
      assert.equal(result.status, 0, `${name} ${codec}: ${result.error?.message || result.stdout || result.stderr}`);
      assert.match(result.stdout, /--- PASS: TestBrowserInterop/);
      await verifyReceiver(page, codec);
    }
    t.diagnostic(`${name} ${browser.version()}: 802 browser-encrypted frames through direct decoder and native-announced P-256 key receiver, exact plaintext, replay rejection and revoke; synthetic policy only, no RTP/media/live-ingress claim`);
  });
}
