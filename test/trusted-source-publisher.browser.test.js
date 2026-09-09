import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { before, after, test } from "node:test";
import { build } from "esbuild";
import { chromium, firefox } from "playwright";
import { nativeCompilerDiagnostic } from "./helpers/native-compiler-diagnostic.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const avClockRuns = process.env.TRUSTED_SOURCE_AV_CLOCK_RUNS ?? "1";
assert.match(avClockRuns, /^(?:[1-9]|10)$/, "paired clock repetition count must be 1..10");
let directory, executable, dockerRunner, bundle, worker, avBundle;
before(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "webrtc-source-publisher-"));
  executable = path.join(directory,"source.test");
  const local = spawnSync("go",["version"],{encoding:"utf8",timeout:10000});
  dockerRunner = Boolean(local.error || local.status !== 0);
  if (dockerRunner && process.platform !== "linux") return;
  const compilerContainer = `webrtc-source-compile-${randomUUID()}`;
  let compiled;
  try {
    compiled = spawnSync(dockerRunner ? "docker" : "go", dockerRunner ? ["run","--rm","--name",compilerContainer,"-e","CGO_ENABLED=0","-v",`${root}:/workspace:ro`,"-v",`${directory}:/out`,
      "-w","/workspace/native-broadcast-packager","golang:1.24-alpine","go","test","-c","-o","/out/source.test","."]
      : ["test","-c","-o",executable,"."], {cwd:path.join(root,"native-broadcast-packager"),encoding:"utf8",timeout:90000});
  } finally {
    if(dockerRunner) {
      const cleanup = spawnSync("docker",["rm","--force",compilerContainer],{encoding:"utf8",timeout:5000});
      assert.ok(cleanup.status===0 || /No such container/.test(cleanup.stderr||""),"native source compiler cleanup failed");
    }
  }
  assert.equal(compiled.status,0,"native source fixture compilation failed: " + JSON.stringify(nativeCompilerDiagnostic(compiled)));
  const built = await build({stdin:{resolveDir:root,contents:`
    import { TrustedSourcePublisher } from "./frontend/src/app/broadcast/trusted-source-publisher";
    import { sameTrustedSource } from "./frontend/src/app/broadcast/trusted-source-contract";
    import { TrustedSourceWorkflow } from "./frontend/src/app/broadcast/trusted-source-workflow";
    import { MediaE2eeController } from "./frontend/src/app/webrtc/media-e2ee-controller";
    let track, context, oscillator, timer, publisher, lease, connection, workflow, workflowTimer, allowed = true;
    const pending = [], states = [], failures = [], lifetime = new AbortController();
    window.createSyntheticSource = async codec => {
      if (codec === "audio/opus") {
        context = new AudioContext(); const destination = context.createMediaStreamDestination();
        oscillator = context.createOscillator(); const gain = context.createGain(); gain.gain.value = 0.1;
        oscillator.connect(gain).connect(destination); oscillator.start(); await context.resume();
        track = destination.stream.getAudioTracks()[0];
      } else {
        const canvas = document.querySelector("canvas"), draw = canvas.getContext("2d"); let n=0;
        timer = setInterval(() => { draw.fillStyle = "hsl("+(n++%360)+" 70% 50%)"; draw.fillRect(0,0,320,180); },30);
        track = canvas.captureStream(30).getVideoTracks()[0];
      }
      return {codec,publicationId:track.id};
    };
    window.acceptSourceNative = async value => {
      if (!workflow) { if(pending.length>=32) throw new Error("fixture_queue"); pending.push(value); return; }
      if(value.fixture === "lease") workflow.receive({version:1,type:"trusted-source-publisher-lease",lease:value.lease});
      else if(value.type === "trusted-source-packager-signal") {
        const {type,...fields} = value;
        workflow.receive({...fields,type:"trusted-source-agent-signal",
          packagerId:lease.consent.granteePackagerRef,packagerDeviceRef:lease.consent.granteeDeviceRef});
      }
    };
    window.startSourcePublisher = async initial => {
      lease = initial;
      // Explicit synthetic control-policy fixture, not HTTP/OIDC/Angular approval evidence.
      // Exercise the actual local workflow and sender against the real native receiver.
      const now = Date.now(), requestId = "bsr_"+"a".repeat(24), consent = initial.consent;
      const scope = {roomId:consent.roomId,peerId:initial.publisherPeerId,roomEpoch:consent.roomEpoch,
        fingerprint:"a".repeat(43),identity:"synthetic-policy"};
      workflow = new TrustedSourceWorkflow({
        context:()=>allowed ? scope : null,
        references:async()=>({tenantId:consent.tenantId,subjectRef:consent.grantorSubjectRef,deviceRef:initial.publisherDeviceRef}),
        track:()=>track,
        changed:()=>{},
        send:value=>{
          if(value.type==="trusted-source-publications") workflow.receive({version:1,type:value.type,
            roomId:scope.roomId,peerId:scope.peerId,roomEpoch:scope.roomEpoch,publicationRevision:1,
            publications:[{publicationId:track.id,publicationEpoch:initial.publicationEpoch,source:consent.sourceKind}]});
          else if(value.type==="trusted-source-approve") {
            workflow.receive({version:1,type:"trusted-source-approved",requestId,consent});
            workflow.receive({version:1,type:"trusted-source-publisher-lease",lease:initial});
          } else if(value.type!=="trusted-source-revoke") throw new Error("fixture_control_invalid");
        },
        start:async(current,borrowed,signal,authorized,onState)=>{
          publisher = await TrustedSourcePublisher.start(current,borrowed,{}, {
        signal,
        authorized: candidate => authorized(candidate) && sameTrustedSource(initial,candidate),
        sendSignal: value => { void window.sendSourceNative(value); },
        onState: state => { if(states.length<32) states.push(state); onState(state); },
        createPeerConnection: config => (connection = new RTCPeerConnection(config)),
        createEncryption: fail => new MediaE2eeController((_context,code) => { if(failures.length<8) failures.push(code); fail(); },
          () => { if(failures.length<8) failures.push("worker-failed"); fail(); })
          }); return publisher;
        }
      });
      workflowTimer=setInterval(()=>workflow.tick(),250);
      await workflow.prepare({requestId,roomId:scope.roomId,programId:consent.programId,programEpoch:consent.programEpoch,
        programRevision:1,ownerPeerId:scope.peerId==="fedcba9876543210" ? "0123456789abcdef" : "fedcba9876543210",
        targetPeerId:scope.peerId,packagerRef:consent.granteePackagerRef,sourceKind:consent.sourceKind,
        state:"pending",authority:"none",createdAt:now,expiresAt:now+120000});
      workflow.approve(requestId,track.id,600000,"user-action");
      for(const value of pending.splice(0)) await window.acceptSourceNative(value);
    };
    window.sourceObservation = async () => {
      const stats = connection ? [...(await connection.getStats()).values()] : [];
      return {states:[...states],trackState:track.readyState,failures:[...failures],connection:connection?.connectionState,
        ice:connection?.iceConnectionState,signaling:connection?.signalingState,
        outbound:stats.filter(row=>row.type==="outbound-rtp").slice(0,2).map(row=>({
          framesEncoded:Number(row.framesEncoded||0),bytesSent:Number(row.bytesSent||0),packetsSent:Number(row.packetsSent||0)}))};
    };
    window.cleanupSource = async () => { allowed=false; workflow?.destroy(); clearInterval(workflowTimer); lifetime.abort(); publisher?.stop(); track?.stop(); clearInterval(timer); oscillator?.stop(); await context?.close(); };
  `},bundle:true,format:"esm",platform:"browser",write:false,logLevel:"silent"});
  bundle = built.outputFiles[0].contents;
  const workerBuild = await build({entryPoints:[path.join(root,"frontend/src/app/webrtc/sframe.worker.ts")],bundle:true,format:"esm",platform:"browser",write:false,logLevel:"silent"});
  worker = workerBuild.outputFiles[0].contents;
  const avBuild = await build({entryPoints:[path.join(root,"scripts/fixtures/trusted-source-av-clock.ts")],bundle:true,format:"esm",platform:"browser",write:false,logLevel:"silent"});
  avBundle = avBuild.outputFiles[0].contents;
});
after(async () => { if(directory) await fs.rm(directory,{recursive:true,force:true}); });

// The first test also owns the bounded 90-second native compilation hook.
test("native trusted VP8 source decodes changing pixels and invalidates on revoke", {timeout:120000}, t => {
  nativeCodecFixture(t, "TestLiveTrustedSourceVideoDecoder");
});
test("native trusted Opus source decodes timed PCM and invalidates on revoke", {timeout:25000}, t => {
  nativeCodecFixture(t, "TestLiveTrustedSourceAudioDecoder");
});
test("native decoder admission retains capacity until reaping and revokes idle children", {timeout:10000}, t => {
  nativeCodecFixture(t, "TestLiveTrustedSourceDecoderAdmission");
});
test("native trusted audio mixer combines two decoded sources and removes revoked queued audio", {timeout:25000}, t => {
  nativeCodecFixture(t, "TestLiveTrustedSourceAudioMixer");
});
test("native trusted video compositor switches layouts and wipes revoked decoded frames", {timeout:25000}, t => {
  nativeCodecFixture(t, "TestLiveTrustedSourceVideoMixer");
});
test("native program clock combines four real decoders and propagates individual revoke", {timeout:25000}, t => {
  nativeCodecFixture(t, "TestLiveTrustedSourceProgramClock");
});
test("native raw program encoder publishes actual H264 AAC renditions and revokes its generation", {timeout:25000}, t => {
  nativeCodecFixture(t, "TestLiveTrustedSourceProgramEncoder");
});
test("native program generation composes VP8 Opus through renewals into decodable HLS and reaps on revoke", {timeout:25000}, t => {
  nativeCodecFixture(t, "TestLiveTrustedSourceProgramGeneration");
});
test("native v4 assignment owns VP8 Opus source bootstrap, renewed HLS output and terminal cleanup", {timeout:25000}, t => {
  nativeCodecFixture(t, "TestLiveTrustedSourceAssignmentProgram");
});
test("native opt-in v4 control uses authenticated TLS, real HLS readiness, renewals and terminal cleanup", {timeout:30000}, t => {
  nativeCodecFixture(t, "TestLiveTrustedSourceControlSocket", 25);
});
test("native raw program encoder bounds rolling HLS windows and reaps a revoked writer", {timeout:45000}, t => {
  nativeCodecFixture(t, "TestLiveTrustedSourceProgramEncoderRollingWindow", 40);
});

function nativeCodecFixture(t, testName, timeoutSeconds = 20) {
  if(dockerRunner && process.platform!=="linux") {t.skip("native decoder fixture needs local Go or Linux compiler fallback");return;}
  const available = spawnSync("ffmpeg",["-version"],{encoding:"utf8",timeout:3000,maxBuffer:32768});
  if(available.error || available.status!==0) {t.skip("real source decoding requires local FFmpeg; no decode claim from RTP alone");return;}
  // The Linux Docker compiler creates a static host binary; plaintext remains in
  // this test's local FFmpeg pipes, never the Node control-plane implementation.
  const result = spawnSync(executable,[`-test.run=^${testName}$`,`-test.timeout=${timeoutSeconds}s`,"-test.v"],
    {env:{...process.env,RUN_LIVE_TRUSTED_SOURCE_DECODE:"1"},encoding:"utf8",timeout:(timeoutSeconds+2)*1000,maxBuffer:32768});
  assert.equal(result.error,undefined,"bounded native decode fixture failed to run");
  assert.equal(result.status,0,"native decode/revocation fixture failed");
  assert.ok(result.stdout.includes(`--- PASS: ${testName}`),"native decode fixture did not actually execute");
  assert.equal(result.stdout.includes("SKIP"),false,"opted-in native decode fixture skipped");
}

async function nativeSource(page, codec, decode) {
  const source = await page.evaluate(codec => window.createSyntheticSource(codec),codec);
  const flags = ["-test.run=^TestSourcePublisherBrowserInterop$","-test.timeout=30s"];
  const child = spawn(executable,flags,
    {env:{...process.env,TRUSTED_SOURCE_BROWSER_INTEROP:"1",TRUSTED_SOURCE_BROWSER_DECODE:decode ? "1" : "0"},stdio:["pipe","pipe","pipe"]});
  let buffered="", outputBytes=0, errorBytes=0, firstLease=false, protocolFailed=false, resolveLease, resolveResult, nativeDiagnostic=null;
  const ready = new Promise(resolve => {resolveLease=resolve;}), result = new Promise(resolve => {resolveResult=resolve;});
  let forwarding=Promise.resolve();
  child.stdout.on("data",data => {
    outputBytes+=data.length;
    if(outputBytes>256*1024) {protocolFailed=true; child.kill(); return;}
    buffered+=data.toString();
    while(buffered.includes("\n")) {
      const index=buffered.indexOf("\n"),line=buffered.slice(0,index); buffered=buffered.slice(index+1);
      if(!line.startsWith("{")) continue;
      let value;
      try {value=JSON.parse(line);} catch {protocolFailed=true; child.kill();return;}
      if(value.fixture==="lease" && !firstLease) {firstLease=true;resolveLease(value.lease);}
      else if(value.fixture==="result") resolveResult(value);
      else if(value.fixture==="diagnostic") nativeDiagnostic={frames:Number(value.frames||0),keyframes:Number(value.keyframes||0),decoded:Number(value.decoded||0),closed:value.closed===true,failure:Number(value.failure||0)};
      else if(value.fixture==="lease" || value.type==="trusted-source-packager-signal") {
        forwarding=forwarding.then(()=>page.evaluate(value=>window.acceptSourceNative(value),value)).catch(()=>{protocolFailed=true;child.kill();});
      } else {protocolFailed=true; child.kill();}
    }
  });
  child.stderr.on("data",data=>{errorBytes+=data.length;if(errorBytes>16384){protocolFailed=true;child.kill();}});
  child.on("error",()=>{protocolFailed=true;}); child.stdin.on("error",()=>{});
  const exited = new Promise(resolve=>child.once("close",code=>resolve(code)));
  const timeout=setTimeout(()=>child.kill("SIGKILL"),35000);
  await page.exposeFunction("sendSourceNative",value=>{
    const raw=JSON.stringify(value);
    if(Buffer.byteLength(raw)>31*1024 || child.stdin.writableLength>64*1024 || child.exitCode!==null) {protocolFailed=true;child.kill();return;}
    child.stdin.write(raw+"\n");
  });
  child.stdin.write(JSON.stringify(source)+"\n");
  try {
    const lease=await Promise.race([ready,exited.then(()=>{throw new Error("native source ended before lease");})]);
    await page.evaluate(lease=>window.startSourcePublisher(lease),lease);
    const observed=await Promise.race([result,exited.then(()=>{throw new Error("native source ended before authenticated media");})]);
    assert.ok(observed.frames>=401,"expected at least 401 authenticated browser frames");
    if(decode) assert.ok(observed.decoded>=350,"expected actual decoded browser pixels/PCM after counter 350");
    if(codec==="video/vp8") assert.ok(observed.keyframes>=1,"expected an authenticated VP8 keyframe");
    assert.equal(observed.closed,true);
    assert.equal(await exited,0,"native source fixture failed");
    await forwarding;
    assert.equal(protocolFailed,false,"source control fixture failed");
    const local=await page.evaluate(()=>window.sourceObservation());
    assert.ok(local.states.includes("sending"),"sender never passed key ACK activation");
    assert.equal(local.trackState,"live","source teardown stopped the borrowed track");
  } catch {
    const browser=await page.evaluate(()=>window.sourceObservation()).catch(()=>({observationFailed:true}));
    throw new Error("native_source_interop_failed "+JSON.stringify({codec,browser,native:nativeDiagnostic}));
  } finally {
    clearTimeout(timeout);
    await page.evaluate(()=>window.cleanupSource()).catch(()=>{});
    if(child.exitCode===null && child.signalCode===null) child.kill("SIGKILL");
    await exited;
  }
}

for(const [name,engine] of [["Chromium",chromium],["Firefox",firefox]]) {
  test(`${name} actual source publisher sends 401 SFrame VP8/Opus frames to native WebRTC receiver`,{timeout:80000},async t=>{
    if(dockerRunner && process.platform!=="linux") {t.skip("compiler fallback requires Linux; native Go runner also supported");return;}
    const available=spawnSync("ffmpeg",["-version"],{encoding:"utf8",timeout:3000,maxBuffer:32768});
    const decode=!available.error && available.status===0;
    if(!decode) t.diagnostic("SKIP native codec output: FFmpeg unavailable; only authenticated RTP is checked");
    const app=http.createServer((request,response)=>{
      response.setHeader("content-type",request.url==="/fixture.js" || request.url==="/sframe.worker" ? "text/javascript" : "text/html");
      response.end(request.url==="/fixture.js" ? bundle : request.url==="/sframe.worker" ? worker
        : '<!doctype html><canvas width="320" height="180"></canvas><script type="module" src="/fixture.js"></script>');
    });
    t.after(()=>new Promise(resolve=>app.close(resolve)));
    await new Promise(resolve=>app.listen(0,"127.0.0.1",resolve));
    const browser=await engine.launch({headless:true,...(name==="Chromium" ? {args:["--autoplay-policy=no-user-gesture-required"]}
      : {firefoxUserPrefs:{"media.autoplay.default":0,"media.autoplay.block-webaudio":false}})});
    t.after(()=>browser.close());
    for(const codec of ["video/vp8","audio/opus"]) {
      const page=await browser.newPage();
      try {await page.goto(`http://127.0.0.1:${app.address().port}`);await nativeSource(page,codec,decode);}
      finally {await page.close();}
    }
  });
  test(`${name} aligns decoded paired SFrame audio/video using actual sender reports`,{timeout:45000*Number(avClockRuns)},async t=>{
    if(dockerRunner && process.platform!=="linux") {t.skip("compiler fallback requires Linux; local Go also supported");return;}
    const available=spawnSync("ffmpeg",["-version"],{encoding:"utf8",timeout:3000,maxBuffer:32768});
    if(available.error || available.status!==0) {t.skip("A/V source clock gate needs actual FFmpeg decoding");return;}
    const app=http.createServer((request,response)=>{
      response.setHeader("content-type",request.url==="/fixture.js" || request.url==="/sframe.worker" ? "text/javascript" : "text/html");
      response.end(request.url==="/fixture.js" ? avBundle : request.url==="/sframe.worker" ? worker
        : '<!doctype html><canvas width="320" height="180"></canvas><script type="module" src="/fixture.js"></script>');
    });
    t.after(()=>new Promise(resolve=>app.close(resolve)));
    await new Promise(resolve=>app.listen(0,"127.0.0.1",resolve));
    const browser=await engine.launch({headless:true,...(name==="Chromium" ? {args:["--autoplay-policy=no-user-gesture-required"]}
      : {firefoxUserPrefs:{"media.autoplay.default":0,"media.autoplay.block-webaudio":false}})});
    t.after(()=>browser.close());
    for(let run=0;run<Number(avClockRuns);run++) {
      const page=await browser.newPage();
      try {
        await page.goto(`http://127.0.0.1:${app.address().port}`);
        const result=await nativeSourceAV(page);
        t.diagnostic(`paired run=${run+1}, decoded onsets=${result.matched}, max A/V delta=${(result.maxDeltaSamples/48).toFixed(1)} ms; synthetic sender/consent policy, no production ingress claim`);
      } finally { await page.close(); }
    }
  });
}

async function nativeSourceAV(page) {
  const source=await page.evaluate(()=>window.createSyntheticAV());
  const child=spawn(executable,["-test.run=^TestSourcePublisherAVClockInterop$","-test.timeout=30s"],
    {env:{...process.env,TRUSTED_SOURCE_AV_CLOCK_INTEROP:"1"},stdio:["pipe","pipe","pipe"]});
  let buffered="", outputBytes=0, errorBytes=0, failed=false, resolveLeases, resolveResult, diagnostic=null;
  const ready=new Promise(resolve=>{resolveLeases=resolve;}), result=new Promise(resolve=>{resolveResult=resolve;});
  let forwarding=Promise.resolve();
  child.stdout.on("data",data=>{
    outputBytes+=data.length;
    if(outputBytes>512*1024) {failed=true;child.kill();return;}
    buffered+=data.toString();
    while(buffered.includes("\n")) {
      const index=buffered.indexOf("\n"), line=buffered.slice(0,index); buffered=buffered.slice(index+1);
      if(!line.startsWith("{")) continue;
      let value; try {value=JSON.parse(line);} catch {failed=true;child.kill();return;}
      if(value.fixture==="leases") resolveLeases(value.leases);
      else if(value.fixture==="result") resolveResult(value);
      else if(value.fixture==="diagnostic") diagnostic=value;
      else if(value.fixture==="lease" || value.type==="trusted-source-packager-signal") {
        forwarding=forwarding.then(()=>page.evaluate(value=>window.acceptSourceNativeAV(value),value)).catch(()=>{failed=true;child.kill();});
      } else {failed=true;child.kill();}
    }
  });
  child.stderr.on("data",data=>{errorBytes+=data.length;if(errorBytes>16384){failed=true;child.kill();}});
  child.on("error",()=>{failed=true;}); child.stdin.on("error",()=>{});
  const exited=new Promise(resolve=>child.once("close",code=>resolve(code)));
  const timeout=setTimeout(()=>child.kill("SIGKILL"),35000);
  await page.exposeFunction("sendSourceNativeAV",value=>{
    const raw=JSON.stringify(value);
    if(Buffer.byteLength(raw)>31*1024 || child.stdin.writableLength>64*1024 || child.exitCode!==null) {failed=true;child.kill();return;}
    child.stdin.write(raw+"\n");
  });
  child.stdin.write(JSON.stringify(source)+"\n");
  try {
    const leases=await Promise.race([ready,exited.then(()=>{throw new Error("AV fixture ended before leases");})]);
    await page.evaluate(leases=>window.startSourceAV(leases),leases);
    const observed=await Promise.race([result,exited.then(()=>{throw new Error("AV fixture ended before clock result");})]);
    assert.ok(observed.matched>=6 && observed.maxDeltaSamples<=7200);
    assert.equal(observed.closed,true);
    assert.equal(await exited,0);
    await forwarding;
    assert.equal(failed,false);
    const local=await page.evaluate(()=>window.sourceAVObservation());
    assert.deepEqual(local.tracks,["live","live"]);
    assert.ok(local.states.length===2 && local.states.every(states=>states.includes("sending")));
    return observed;
  } catch {
    const local=await page.evaluate(()=>window.sourceAVObservation()).catch(()=>({observationFailed:true}));
    throw new Error("paired_source_clock_failed "+JSON.stringify({local,native:diagnostic}));
  } finally {
    clearTimeout(timeout);
    await page.evaluate(()=>window.cleanupSourceAV()).catch(()=>{});
    if(child.exitCode===null && child.signalCode===null) child.kill("SIGKILL");
    await exited;
  }
}
