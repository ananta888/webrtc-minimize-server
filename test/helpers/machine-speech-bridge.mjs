// Opt-in test driver, not an application endpoint. No caller URL, JS, task,
// grants or keys are accepted. Fixed synthetic Hub identity; private TLS/STUN.
import readline from "node:readline";
import { machineBrowserFixture } from "./machine-browser-fixture.js";

async function bridge() {
  const cleanup = [], reply = value => process.stdout.write(JSON.stringify(value) + "\n");
  const timer = setTimeout(() => process.stdin.destroy(), 90000); timer.unref();
  try {
    const f = await machineBrowserFixture({ after: close => cleanup.push(close) }, {
      tlsPortProxy: true, humanEngine: process.env.MEET_SPEECH_RECEIVER || "chromium",
    });
    f.binding.sessionId = "synthetic-speech-hub-session";
    const { human, machine } = f;
    human.setDefaultTimeout(12000); machine.setDefaultTimeout(12000);
    await machine.evaluate(([room, grant]) => window.anantaMachine.join(room, grant),
      [f.roomId, await f.grant(["speech.publish"])]);
    await human.locator("#participant-count", { hasText: "2 / 20" }).waitFor();
    reply({ ready: true });
    for await (const line of readline.createInterface({ input: process.stdin, crlfDelay: Infinity })) {
      if (line.length > 2048) throw new Error("test_request_invalid");
      const value = JSON.parse(line);
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("test_request_invalid");
      const keys = Object.keys(value).sort().join();
      if (value.op === "finish" && keys === "op") break;
      if (value.op === "open" && keys === "op,source_id,total_samples"
        && value.source_id === "speech:synthetic-speech-hub-session"
        && Number.isInteger(value.total_samples) && value.total_samples > 0 && value.total_samples <= 220500) {
        const source = await machine.evaluate(([id, total]) => window.anantaMachine.speech.open(id, total),
          [value.source_id, value.total_samples]);
        await human.waitForFunction(() => window.__pcs.some(pc => pc.getReceivers().some(r => r.track.kind === "audio")));
        await human.evaluate(async () => {
          if (window.__speechProbe) throw new Error("test_probe_already_started");
          const track = window.__pcs.flatMap(pc => pc.getReceivers()).find(r => r.track.kind === "audio").track;
          const context = new AudioContext(), source = context.createMediaStreamSource(new MediaStream([track]));
          const analyser = context.createAnalyser(), quiet = context.createGain(); quiet.gain.value = 0;
          source.connect(analyser); analyser.connect(quiet); quiet.connect(context.destination); await context.resume();
          const probe = { context, peak: 0, activeWindows: 0, windows: 0 }; window.__speechProbe = probe;
          probe.timer = setInterval(() => {
            const pcm = new Float32Array(analyser.fftSize); analyser.getFloatTimeDomainData(pcm);
            probe.peak = Math.max(probe.peak, ...pcm.map(Math.abs)); probe.windows++;
            if (pcm.some(v => Math.abs(v) > .01)) probe.activeWindows++;
          }, 20);
        });
        reply(source);
      } else if (value.op === "status" && keys === "op") {
        reply(await machine.evaluate(() => window.anantaMachine.speech.status()));
      } else if (value.op === "push" && keys === "generation,op,pcm,start_sample"
        && Number.isSafeInteger(value.generation) && Number.isSafeInteger(value.start_sample)
        && typeof value.pcm === "string" && value.pcm.length <= 1176 && /^[A-Za-z0-9+/]+={0,2}$/.test(value.pcm)) {
        await machine.evaluate(([gen, start, pcm]) => window.anantaMachine.speech.push(gen, start, pcm),
          [value.generation, value.start_sample, value.pcm]); reply({ accepted: true });
      } else if (value.op === "close" && keys === "generation,op" && Number.isSafeInteger(value.generation)) {
        await machine.evaluate(gen => { const source = window.anantaMachine.speech;
          if (source.status().generation === gen) source.close(); }, value.generation); reply({ closed: true });
      } else if (value.op === "probe" && keys === "op") {
        const decoded = await human.evaluate(async () => {
          const p = window.__speechProbe; if (!p) throw new Error("test_probe_missing");
          clearInterval(p.timer); await p.context.close();
          return { peak: p.peak, active_windows: p.activeWindows, windows: p.windows,
            captures: window.__captures, transform_errors: window.__transformErrors.length };
        });
        reply({ ...decoded, machine_captures: await machine.evaluate(() => window.__captures) });
      } else throw new Error("test_request_invalid");
    }
  } catch {
    reply({ error: "test_speech_bridge_failed" }); process.exitCode = 1;
  } finally {
    clearTimeout(timer);
    for (const close of cleanup.reverse()) { try { await close(); } catch { process.exitCode = 1; } }
  }
}

if (process.env.MEET_SPEECH_CROSS_GATE === "1") await bridge();
else process.stdout.write("SKIP private real-speech bridge: MEET_SPEECH_CROSS_GATE=1 required\n");
