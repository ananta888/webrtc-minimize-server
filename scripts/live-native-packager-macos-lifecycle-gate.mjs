import assert from "node:assert/strict";
import crypto from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NativePackagerInstallerService } from "../src/native-packager-installers.js";

if (process.env.RUN_MACOS_PACKAGER_LIFECYCLE !== "1") {
  console.log("SKIP real macOS user-service lifecycle: set RUN_MACOS_PACKAGER_LIFECYCLE=1 in a macOS GUI login");
  process.exit(0);
}
assert.equal(process.platform,"darwin");
const run=(command,args,options={})=>execFileSync(command,args,{encoding:"utf8",stdio:"pipe",timeout:90_000,...options});
const directory=fs.mkdtempSync(path.join(os.tmpdir(),"packager-launchd-gate-"));
const ids=Array.from({length:2},()=>`pkr_${crypto.randomBytes(12).toString("hex")}`);
const base=path.join(os.homedir(),".local/share/ananta-native-packager");
const domain=`gui/${process.getuid()}`;
const target=process.arch==="arm64"?"macos-arm64":"macos-amd64";
const artifact=path.join(directory,`native-broadcast-packager-${target}`);
const env={...process.env,PATH:`${directory}:/usr/bin:/bin:/usr/sbin:/sbin:${process.env.PATH}`,ANANTA_MACOS_ARTIFACT:artifact};
const controller=(...args)=>{
  try { return run("launchctl",args,{env}); }
  catch(error) { throw new Error(`macOS launchctl ${args[0]} failed (exit ${error.status ?? "unknown"})`); }
};
const entries=[];
let holder;
const jobs=()=>new Map(controller("list").trim().split(/\r?\n/).map(line=>line.trim().split(/\s+/)).filter(fields=>fields.length===3).map(([pid,,label])=>[label,pid]));
const source=version=>`#!/bin/sh
set -eu
case "\${1:-}" in
enroll) printf '%s' "$NATIVE_PACKAGER_ID" > "$NATIVE_PACKAGER_IDENTITY_FILE"; exit 0 ;;
preflight) exit 0 ;;
esac
[ '${version}' != bad ] || exit 42
fixture_root=$(dirname "$0")
printf '%s' '${version}' > "$fixture_root/.fixture-version"
exec sleep 180
`;
const prepare=version=>{const bytes=source(version);fs.writeFileSync(artifact,bytes);return crypto.createHash("sha256").update(bytes).digest("hex");};
const verifyVersion=(index,version)=>assert.equal(fs.readFileSync(path.join(entries[index].root,".fixture-version"),"utf8"),version);
try {
  // Stock lockf/perl/mv/launchctl, but synthetic download, enrollment and media binary.
  // ffmpeg is only checked for existence by this installer; this gate never probes codecs.
  fs.writeFileSync(path.join(directory,"ffmpeg"),"#!/bin/sh\nexit 0\n",{mode:0o700});
  fs.writeFileSync(path.join(directory,"curl"),`#!/bin/sh
set -eu
while [ "$#" -gt 0 ]; do if [ "$1" = --output ]; then shift; destination=$1; fi; shift; done
cp "$ANANTA_MACOS_ARTIFACT" "$destination"
`,{mode:0o700});
  try { run("launchctl",["print",domain],{env,stdio:"ignore"}); }
  catch { throw new Error("macOS GUI launchd domain is unavailable"); }
  prepare("old");
  const installers=new NativePackagerInstallerService({directory});
  for(const id of ids) {
    const root=path.join(base,id),label=`de.ananta.native-packager.${id}`;
    const plist=path.join(os.homedir(),"Library/LaunchAgents",`${label}.plist`);
    assert.equal(fs.existsSync(root),false);assert.equal(fs.existsSync(plist),false);assert.equal(jobs().has(label),false);
    entries.push({id,root,label,plist});
    const {content}=installers.installer({enrollment:{packagerId:id,platform:"macos",enrollmentToken:"A".repeat(43)},targetId:target,publicOrigin:"https://webrtc.example"});
    run("sh",["-c",content],{env});
  }
  for(let attempt=0;attempt<100;attempt++) {
    if(entries.every(entry=>fs.existsSync(path.join(entry.root,".fixture-version"))&&/^\d+$/.test(jobs().get(entry.label)||""))) break;
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  verifyVersion(0,"old");verifyVersion(1,"old");
  const secondPID=jobs().get(entries[1].label);assert.match(secondPID,/^[1-9][0-9]*$/);
  const update=path.join(entries[0].root,`update-${ids[0]}`),uninstall=path.join(entries[0].root,`uninstall-${ids[0]}`);
  const hash=prepare("new");
  run("sh",[update,"update",hash],{env});verifyVersion(0,"new");
  run("sh",[update,"rollback"],{env});verifyVersion(0,"old");
  assert.throws(()=>run("sh",[update,"update",prepare("bad")],{env}));verifyVersion(0,"old");
  assert.equal(fs.existsSync(path.join(entries[0].root,".update-active")),false);
  console.log("PASS real macOS launchd install, update, rollback and crash-triggered recovery");
  holder=spawn("sh",["-c",'set -eu; exec 9>"$1"; lockf -s -t 0 9; echo ready; read answer',"sh",path.join(entries[0].root,".maintenance.lock")],{env,stdio:["pipe","pipe","pipe"]});
  let timer;
  try {
    await Promise.race([once(holder.stdout,"data"),once(holder,"exit").then(()=>{throw new Error("Real lockf fixture exited before readiness");}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error("Real lockf fixture timed out")),5000);})]);
  } finally {clearTimeout(timer);}
  assert.throws(()=>run("sh",[update,"update",hash],{env}),/maintenance operation/);
  assert.throws(()=>run("sh",[uninstall],{env}),/Maintenance aktiv/);
  holder.stdin.end("done\n");await once(holder,"exit");holder=undefined;
  assert.equal(jobs().get(entries[1].label),secondPID);
  for(const entry of entries) {
    assert.equal(fs.readFileSync(path.join(entry.root,`identity-${entry.id}.pem`),"utf8"),entry.id);
    assert.equal(fs.statSync(entry.root).mode&0o777,0o700);
    assert.equal(fs.statSync(path.join(entry.root,`identity-${entry.id}.pem`)).mode&0o777,0o600);
  }
  run("sh",[uninstall],{env});assert.equal(fs.existsSync(entries[0].root),false);
  assert.equal(jobs().get(entries[1].label),secondPID);
  run("sh",[path.join(entries[1].root,`uninstall-${ids[1]}`)],{env});
  console.log("PASS real macOS FD-lock exclusion, private permissions and independent second agent/uninstall");
  console.log(`macOS lifecycle environment: ${run("sw_vers",["-productVersion"]).trim()} ${process.arch}`);
} catch(error) {
  // Installer fixtures contain no real secrets; never emit a whole launchctl listing.
  if(error.cmd && String(error.cmd).includes("launchctl")) console.error("macOS launchctl operation failed");
  else {process.stderr.write(error.stdout?.toString()||"");process.stderr.write(error.stderr?.toString()||"");}
  throw error;
} finally {
  if(holder && holder.exitCode===null && holder.signalCode===null) {holder.kill();await once(holder,"exit");}
  let cleanupError;
  for(const entry of entries) {
    try {
      if(jobs().has(entry.label)) controller("bootout",`${domain}/${entry.label}`);
      assert.equal(jobs().has(entry.label),false);
      fs.rmSync(entry.plist,{force:true});fs.rmSync(entry.root,{recursive:true,force:true});
    } catch(error) {cleanupError=error;}
  }
  fs.rmSync(directory,{recursive:true,force:true});
  if(cleanupError) throw new Error("Synthetic macOS service cleanup failed; files preserved for inspection",{cause:cleanupError});
}
