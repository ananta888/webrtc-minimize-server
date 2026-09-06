import assert from "node:assert/strict";
import crypto from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { NativePackagerInstallerService } from "../src/native-packager-installers.js";

const id="pkr_0123456789abcdef", other="pkr_fedcba9876543210";
const content=version=>`#!/bin/sh
set -eu
case "\${1:-}" in
enroll) printf '%s' "$NATIVE_PACKAGER_ID" > "$NATIVE_PACKAGER_IDENTITY_FILE" ;;
preflight) [ '${version}' != bad-preflight ] ;;
health) [ '${version}' != bad-start ] ;;
esac
# version=${version}
`;
function fixture(t) {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),"packager-macos-update-"));
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const fixtureHome=path.join(directory,"user with spaces");
  const commands=path.join(directory,"commands"), states=path.join(directory,"services");
  fs.mkdirSync(commands); fs.mkdirSync(states);
  const artifact=path.join(directory,"native-broadcast-packager-macos-amd64");
  fs.writeFileSync(artifact,content("old"));
  const root=path.join(fixtureHome,".local/share/ananta-native-packager",id);
  const command=(name,source)=>fs.writeFileSync(path.join(commands,name),`#!/bin/sh\nset -eu\n${source}\n`,{mode:0o700});
  command("ffmpeg","exit 0"); command("sleep","exit 0");
  command("lockf",'[ "${MAC_LOCKF_UNSUPPORTED:-0}" != 1 ] || exit 64; [ "$*" = "-s -t 0 9" ] || exit 1; exec flock -n 9');
  command("mv",'[ "$1" = -f ] && [ "$#" = 3 ] || exit 2; exec /bin/mv "$@"');
  command("curl",`while [ "$#" -gt 0 ]; do if [ "$1" = --output ]; then shift; destination=$1; fi; shift; done
cp "$MAC_ARTIFACT" "$destination"`);
  command("launchctl",`printf '%s\\n' "$*" >> "$MAC_SERVICE_LOG"
case "$1" in
list)
  [ "\${MAC_LIST_FAIL:-0}" != 1 ] || exit 1
  printf '%s\\n' 'PID Status Label'
  for label in de.ananta.native-packager.${id} de.ananta.native-packager.${other}; do
    if [ -f "$MAC_STATES/$label" ]; then
      value=$(cat "$MAC_STATES/$label")
      if [ "$label" = de.ananta.native-packager.${id} ] && grep -q '# version=churn' "$MAC_BINARY"; then value=$((value+1)); printf '%s' "$value" > "$MAC_STATES/$label"; fi
      printf '%s 0 %s\\n' "$value" "$label"
    fi
  done ;;
bootout)
  [ "\${MAC_STOP_FAIL:-0}" != 1 ] || exit 1
  [ "\${MAC_KILL_PHASE:-0}" != 1 ] || kill -KILL "$MAC_UPDATER_PID"
  label=\${2##*/}; rm -f "$MAC_STATES/$label" ;;
bootstrap)
  [ "\${MAC_KILL_PHASE:-0}" != 2 ] || kill -KILL "$MAC_UPDATER_PID"
  label=\${3##*/}; label=\${label%.plist}
  target=\${label#de.ananta.native-packager.}
  binary="$HOME/.local/share/ananta-native-packager/$target/native-broadcast-packager"
  "$binary" health || exit 1
  printf '%s' 500 > "$MAC_STATES/$label" ;;
*) exit 2 ;;
esac`);
  const env={...process.env,HOME:fixtureHome,PATH:`${commands}:${process.env.PATH}`,MAC_ARTIFACT:artifact,MAC_STATES:states,
    MAC_BINARY:path.join(root,"native-broadcast-packager"),MAC_SERVICE_LOG:path.join(directory,"calls")};
  const service=new NativePackagerInstallerService({directory});
  const install=packagerId=>service.installer({enrollment:{packagerId,platform:"macos",enrollmentToken:"A".repeat(43)},targetId:"macos-amd64",publicOrigin:"https://webrtc.example"}).content;
  for(const packagerId of [id,other]) execFileSync("sh",["-c",install(packagerId)],{env,stdio:"pipe"});
  fs.writeFileSync(env.MAC_SERVICE_LOG,"");
  const updater=path.join(root,`update-${id}`);
  const run=(args,extra={})=>execFileSync("sh",["-c",'MAC_UPDATER_PID=$$; export MAC_UPDATER_PID; exec sh "$@"',"sh",updater,...args],{env:{...env,...extra},encoding:"utf8",stdio:"pipe",timeout:15000});
  const prepare=version=>{fs.writeFileSync(artifact,content(version));return crypto.createHash("sha256").update(content(version)).digest("hex");};
  const read=name=>fs.readFileSync(path.join(root,name),"utf8");
  const unchanged=()=>{
    assert.equal(read(`identity-${id}.pem`),id);
    assert.equal(fs.readFileSync(path.join(path.dirname(root),other,`identity-${other}.pem`),"utf8"),other);
    assert.equal(fs.readFileSync(path.join(path.dirname(root),other,"native-broadcast-packager"),"utf8"),content("old"));
    assert.equal(fs.readFileSync(path.join(states,`de.ananta.native-packager.${other}`),"utf8"),"500");
  };
  return {directory,root,env,run,read,prepare,unchanged,install};
}

test("macOS adapter updates and rolls back with real hashes/renames and simulated launchd; second installation unchanged",t=>{
  const f=fixture(t);
  assert.match(f.run(["update",f.prepare("new")]),/Binary switched/);
  assert.equal(f.read("native-broadcast-packager"),content("new"));
  f.run(["rollback"]); assert.equal(f.read("native-broadcast-packager"),content("old"));
  assert.equal(fs.existsSync(path.join(f.root,".update-active")),false);
  const script=f.read(`update-${id}`);
  assert.match(script,/lockf -s -t 0 9/); assert.match(script,/shasum -a 256/);
  assert.doesNotMatch(script,/systemctl|mv -Tf|launchctl print|enrollmentToken/);
  assert.equal(script.includes("\r"),false); f.unchanged();
});
for(const scenario of ["bad-hash","bad-preflight","bad-start","churn","stop-fail","list-fail"]) {
  test(`macOS ${scenario} fails closed and preserves both identities`,t=>{
    const f=fixture(t); const hash=f.prepare(["bad-preflight","bad-start","churn"].includes(scenario)?scenario:"new");
    assert.throws(()=>f.run(["update",scenario==="bad-hash"?"0".repeat(64):hash],
      scenario==="stop-fail"?{MAC_STOP_FAIL:"1"}:scenario==="list-fail"?{MAC_LIST_FAIL:"1"}:{}));
    assert.equal(f.read("native-broadcast-packager"),content("old"));
    if(scenario==="stop-fail") {
      assert.equal(fs.existsSync(path.join(f.root,".update-active")),true);
      assert.match(f.run(["recover"]),/recovered/);
    }
    if(["bad-hash","bad-preflight","list-fail"].includes(scenario)) assert.doesNotMatch(fs.readFileSync(f.env.MAC_SERVICE_LOG,"utf8"),/bootout/);
    f.unchanged();
  });
}
for(const phase of ["1","2"]) test(`macOS simulated launchd phase ${phase}: real SIGKILL preserves journal for recovery`,t=>{
  const f=fixture(t), hash=f.prepare("new");
  assert.throws(()=>f.run(["update",hash],{MAC_KILL_PHASE:phase}),error=>error.signal==="SIGKILL");
  assert.equal(fs.existsSync(path.join(f.root,".update-active")),true);
  assert.throws(()=>f.run(["update",hash]),/Interrupted transaction/);
  assert.throws(()=>execFileSync("sh",[path.join(f.root,`uninstall-${id}`)],{env:f.env,stdio:"pipe"}),/Wiederherstellung/);
  f.run(["recover"]); assert.equal(f.read("native-broadcast-packager"),content("old")); f.unchanged();
});
test("macOS lockf capability rejection precedes enrollment and real flock excludes maintenance/uninstall",async t=>{
  const f=fixture(t), next="pkr_aaaaaaaaaaaaaaaa";
  assert.throws(()=>execFileSync("sh",["-c",f.install(next)],{env:{...f.env,MAC_LOCKF_UNSUPPORTED:"1"},stdio:"pipe"}),/FD-Unterstuetzung/);
  assert.equal(fs.existsSync(path.join(path.dirname(f.root),next,`identity-${next}.pem`)),false);
  const holder=spawn("flock",["-x",path.join(f.root,".maintenance.lock"),"sh","-c","echo ready; read answer"],{stdio:["pipe","pipe","pipe"]});
  t.after(()=>holder.kill()); await once(holder.stdout,"data");
  assert.throws(()=>f.run(["update",f.prepare("new")]),/Another maintenance/);
  assert.throws(()=>execFileSync("sh",[path.join(f.root,`uninstall-${id}`)],{env:f.env,stdio:"pipe"}),/Maintenance aktiv/);
  holder.stdin.end("done\n"); await once(holder,"exit"); f.unchanged();
});
test("macOS rejects symlinked plist and corrupt or escaping backup references",t=>{
  const f=fixture(t); f.run(["update",f.prepare("new")]);
  const reference=f.read(".rollback-ref").trim();
  fs.writeFileSync(path.join(f.root,reference,"old"),"tampered");
  assert.throws(()=>f.run(["rollback"]),/Invalid rollback backup/);
  fs.writeFileSync(path.join(f.root,".rollback-ref"),"../outside");
  assert.throws(()=>f.run(["rollback"]),/Invalid rollback backup/);
  const plist=path.join(f.env.HOME,`Library/LaunchAgents/de.ananta.native-packager.${id}.plist`);
  fs.renameSync(plist,`${plist}.saved`); fs.symlinkSync(`${plist}.saved`,plist);
  assert.throws(()=>f.run(["update",f.prepare("newer")]),/service configuration is unavailable/); f.unchanged();
});

test("POSIX bounded helper propagates status and bounds a real child process group",()=>{
  const helper=path.resolve("src/native-packager-bounded-command.pl");
  assert.throws(()=>execFileSync("perl",[helper,"5","sh","-c","exit 7"],{stdio:"pipe"}),error=>error.status===7);
  const started=Date.now();
  assert.throws(()=>execFileSync("perl",[helper,"1","sh","-c","sleep 30 & wait"],{stdio:"pipe",timeout:6000}),error=>error.status===124);
  assert.ok(Date.now()-started<5000,"descendant pipes must close before the outer deadline");
  assert.throws(()=>execFileSync("perl",[helper,"31","sh","-c","exit 0"],{stdio:"pipe"}),/Invalid command deadline/);
});

test("POSIX bounded helper forwards TERM to its group without stopping an unrelated process",{timeout:8000},async t=>{
  const unrelated=spawn("sleep",["30"],{stdio:"ignore"});
  const bounded=spawn("perl",[path.resolve("src/native-packager-bounded-command.pl"),"30","sh","-c","echo ready; sleep 30 & wait"],{stdio:["ignore","pipe","pipe"]});
  t.after(async()=>{
    for(const child of [bounded,unrelated]) if(child.exitCode===null&&child.signalCode===null) {
      const ended=once(child,"exit"); child.kill("SIGTERM"); await ended;
    }
  });
  await once(bounded.stdout,"data");
  const ended=once(bounded,"exit");bounded.kill("SIGTERM");
  const [status]=await ended;assert.equal(status,124);
  assert.equal(unrelated.exitCode,null);assert.equal(unrelated.signalCode,null);
});
