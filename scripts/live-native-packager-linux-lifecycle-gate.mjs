import assert from "node:assert/strict";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NativePackagerInstallerService } from "../src/native-packager-installers.js";

if (process.env.RUN_LINUX_PACKAGER_LIFECYCLE !== "1") {
  console.log("SKIP real Linux user-service lifecycle: set RUN_LINUX_PACKAGER_LIFECYCLE=1 with an active systemd user manager and FFmpeg");
  process.exit(0);
}
assert.equal(process.platform,"linux");
execFileSync("systemctl",["--user","show-environment"],{stdio:"pipe"});
const directory=fs.mkdtempSync(path.join(os.tmpdir(),"packager-systemd-gate-"));
const base=path.join(os.homedir(),".local/share/ananta-native-packager");
const ids=Array.from({length:2},()=>`pkr_${crypto.randomBytes(12).toString("hex")}`);
const created=[];
const run=(command,args,options={})=>execFileSync(command,args,{encoding:"utf8",stdio:"pipe",timeout:60_000,...options});
const artifact=path.join(directory,"native-broadcast-packager-linux-amd64");
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
const setArtifact=version=>{const bytes=source(version);fs.writeFileSync(artifact,bytes);return crypto.createHash("sha256").update(bytes).digest("hex");};
const controller=(...args)=>run("systemctl",["--user",...args]);
const units=ids.map(id=>`ananta-native-packager-${id}.service`);
const env={...process.env,PATH:`${directory}:${process.env.PATH}`,ANANTA_LIFECYCLE_ARTIFACT:artifact};
const assertVersion=(index,version)=>assert.equal(fs.readFileSync(path.join(base,ids[index],".fixture-version"),"utf8"),version);
try {
  // Only artifact download/enrollment are synthetic; units and systemctl are real.
  fs.writeFileSync(path.join(directory,"curl"),`#!/bin/sh
set -eu
while [ "$#" -gt 0 ]; do if [ "$1" = --output ]; then shift; destination=$1; fi; shift; done
cp "$ANANTA_LIFECYCLE_ARTIFACT" "$destination"
`,{mode:0o700});
  setArtifact("old");
  const installers=new NativePackagerInstallerService({directory});
  for(const id of ids) {
    const root=path.join(base,id);
    assert.equal(fs.existsSync(root),false,"fixture root must not replace an installation");
    const unitFile=path.join(os.homedir(),".config/systemd/user",`ananta-native-packager-${id}.service`);
    assert.equal(fs.existsSync(unitFile),false);
    created.push({root,unitFile,id});
    const {content}=installers.installer({enrollment:{packagerId:id,platform:"linux",enrollmentToken:"A".repeat(43)},targetId:"linux-amd64",publicOrigin:"https://webrtc.example"});
    run("sh",["-c",content],{env});
  }
  // A finite wait for Type=simple fixture startup, not a sleep-based proof.
  for(let attempt=0;attempt<20;attempt++) {
    if(ids.every(id=>fs.existsSync(path.join(base,id,".fixture-version")))) break;
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  for(let index=0;index<2;index++) {controller("is-active","--quiet",units[index]);assertVersion(index,"old");}
  const secondPID=controller("show","--value","--property=MainPID",units[1]).trim();
  const update=path.join(base,ids[0],`update-${ids[0]}`);
  run("sh",[update,"update",setArtifact("new")],{env}); assertVersion(0,"new");
  run("sh",[update,"rollback"],{env}); assertVersion(0,"old");
  assert.throws(()=>run("sh",[update,"update",setArtifact("bad")],{env}));
  controller("is-active","--quiet",units[0]); assertVersion(0,"old");
  assert.equal(controller("show","--value","--property=MainPID",units[1]).trim(),secondPID);
  for(const id of ids) assert.equal(fs.readFileSync(path.join(base,id,`identity-${id}.pem`),"utf8"),id);
  console.log("PASS real systemd user-service install, update, rollback and crash-triggered recovery; second process and identities unchanged");
} catch(error) {
  process.stderr.write(error.stdout?.toString()||"");
  process.stderr.write(error.stderr?.toString()||"");
  throw error;
} finally {
  // Exact per-run test IDs only. A failed stop preserves its files for inspection.
  let cleanupError;
  for(const {root,unitFile,id} of created) {
    try {
      controller("disable","--now",`ananta-native-packager-${id}.service`);
      fs.rmSync(unitFile,{force:true});
      fs.rmSync(root,{recursive:true,force:true});
    } catch(error) {cleanupError=error;}
  }
  controller("daemon-reload");
  fs.rmSync(directory,{recursive:true,force:true});
  if(cleanupError) throw new Error("Synthetic service cleanup failed; inspect the per-run fixture units",{cause:cleanupError});
}
