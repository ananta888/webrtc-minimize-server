import assert from "node:assert/strict";
import crypto from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { NativePackagerInstallerService } from "../src/native-packager-installers.js";

const id = "pkr_0123456789abcdef";
const other = "pkr_fedcba9876543210";
const content = version => `#!/bin/sh
set -eu
case "\${1:-}" in
enroll) printf '%s' "$NATIVE_PACKAGER_ID" > "$NATIVE_PACKAGER_IDENTITY_FILE" ;;
preflight) echo '${version}-preflight' >> "$UPDATER_TEST_LOG"; [ '${version}' != bad-preflight ] ;;
health) [ '${version}' != bad-start ] ;;
esac
# version=${version}
`;

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "packager-update-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const fixtureHome = path.join(directory, "user with spaces");
  const commands = path.join(directory,"commands"); fs.mkdirSync(commands);
  const artifacts = path.join(directory,"artifacts"); fs.mkdirSync(artifacts);
  const artifact = path.join(artifacts,"native-broadcast-packager-linux-amd64");
  fs.writeFileSync(artifact, content("old"));
  const root = path.join(fixtureHome,".local/share/ananta-native-packager",id);
  const binary = path.join(root,"native-broadcast-packager");
  const command = (name, source) => fs.writeFileSync(path.join(commands,name), `#!/bin/sh\nset -eu\n${source}\n`, { mode: 0o700 });
  command("ffmpeg", "exit 0"); command("sleep", "exit 0"); command("timeout", 'shift; exec "$@"');
  command("curl", `echo download >> "$UPDATER_TEST_LOG"
while [ "$#" -gt 0 ]; do if [ "$1" = --output ]; then shift; destination=$1; fi; shift; done
cp "$UPDATER_TEST_ARTIFACT" "$destination"`);
  command("systemctl", `echo "$*" >> "$UPDATER_TEST_LOG"
case "$*" in
  *'stop '*)
    if [ "\${UPDATER_TEST_KILL:-0}" = 1 ]; then kill -KILL "$PPID"; exit 0; fi
    [ "\${UPDATER_TEST_STOP_FAIL:-0}" != 1 ] ;;
  *'start '*)
    if [ "\${UPDATER_TEST_KILL:-0}" = 2 ]; then kill -KILL "$PPID"; exit 0; fi
    "$UPDATER_TEST_BINARY" health
    echo 0 > "$UPDATER_TEST_LOG.health" ;;
  *'is-active '*)
    if [ "\${UPDATER_TEST_DELAYED_FAIL:-0}" = 1 ] && [ -f "$UPDATER_TEST_LOG.health" ] && grep -q '# version=new' "$UPDATER_TEST_BINARY"; then
      checks=$(cat "$UPDATER_TEST_LOG.health"); checks=$((checks+1)); echo "$checks" > "$UPDATER_TEST_LOG.health"; [ "$checks" -lt 3 ]
    fi ;;
esac`);
  const env = { ...process.env, HOME: fixtureHome, PATH: `${commands}:${process.env.PATH}`,
    UPDATER_TEST_ARTIFACT: artifact, UPDATER_TEST_BINARY: binary, UPDATER_TEST_LOG: path.join(directory,"calls") };
  const service = new NativePackagerInstallerService({ directory: artifacts });
  for (const packagerId of [id,other]) {
    const generated = service.installer({ enrollment: { packagerId, platform:"linux", enrollmentToken:"A".repeat(43) },
      targetId:"linux-amd64", publicOrigin:"https://webrtc.example" });
    execFileSync("sh", ["-c",generated.content], { env, stdio:"pipe" });
  }
  fs.writeFileSync(env.UPDATER_TEST_LOG, "");
  const updater = path.join(root,`update-${id}`);
  const run = (args, extra = {}) => execFileSync("sh", [updater,...args], { env:{...env,...extra}, stdio:"pipe", encoding:"utf8", timeout:5000 });
  const prepare = version => { fs.writeFileSync(artifact,content(version)); return crypto.createHash("sha256").update(content(version)).digest("hex"); };
  const read = name => fs.readFileSync(path.join(root,name),"utf8");
  const unchanged = () => {
    assert.equal(read(`identity-${id}.pem`), id);
    const otherRoot = path.join(path.dirname(root),other);
    assert.equal(fs.readFileSync(path.join(otherRoot,`identity-${other}.pem`),"utf8"),other);
    assert.equal(fs.readFileSync(path.join(otherRoot,"native-broadcast-packager"),"utf8"),content("old"));
  };
  return { directory, root, binary, updater, env, run, prepare, read, unchanged };
}

test("generated Linux updater atomically switches, retains exactly one referenced backup and rolls back without enrollment", t => {
  const f=fixture(t);
  assert.match(f.run(["update",f.prepare("new")]), /Binary switched/);
  assert.equal(f.read("native-broadcast-packager"),content("new"));
  assert.equal(fs.statSync(f.binary).mode & 0o777,0o700);
  const first=f.read(".rollback-ref").trim();
  assert.equal(f.read(`${first}/old`),content("old"));
  f.run(["update",f.prepare("newer")]);
  assert.equal(fs.existsSync(path.join(f.root,first)),false);
  f.run(["rollback"]);
  assert.equal(f.read("native-broadcast-packager"),content("new"));
  assert.equal(fs.existsSync(path.join(f.root,".update-active")),false);
  f.unchanged();
  assert.doesNotMatch(fs.readFileSync(f.env.UPDATER_TEST_LOG,"utf8"),/enroll/);
  const script=fs.readFileSync(f.updater,"utf8");
  assert.equal(script.includes("\r"),false);
  assert.match(script,/--max-time 120 --max-filesize 134217728/);
  assert.match(script,/--proto-redir '=https'/);
});

for (const scenario of ["bad-hash","bad-preflight","bad-start","stop-fail","delayed-fail"]) {
  test(`Linux ${scenario} keeps or restores the original executable and both identities`, t => {
    const f=fixture(t);
    const hash=f.prepare(scenario === "bad-preflight" || scenario === "bad-start" ? scenario : "new");
    assert.throws(()=>f.run(["update",scenario === "bad-hash" ? "0".repeat(64) : hash],
      scenario === "stop-fail" ? { UPDATER_TEST_STOP_FAIL:"1" } : scenario === "delayed-fail" ? { UPDATER_TEST_DELAYED_FAIL:"1" } : {}));
    assert.equal(f.read("native-broadcast-packager"),content("old"));
    if(scenario === "stop-fail") {
      assert.equal(fs.existsSync(path.join(f.root,".update-active")),true);
      assert.match(f.run(["recover"]),/recovered/);
    }
    if(scenario === "bad-hash" || scenario === "bad-preflight")
      assert.doesNotMatch(fs.readFileSync(f.env.UPDATER_TEST_LOG,"utf8"),/--user stop/);
    f.unchanged();
  });
}

for (const phase of ["1","2"]) test(`Linux SIGKILL at phase ${phase} leaves a recoverable journal and prevents uninstall or another update`, t => {
  const f=fixture(t); const hash=f.prepare("new");
  assert.throws(()=>f.run(["update",hash], { UPDATER_TEST_KILL:phase }), error => error.signal === "SIGKILL");
  assert.equal(fs.existsSync(path.join(f.root,".update-active")),true);
  assert.throws(()=>f.run(["update",hash]),/Interrupted transaction/);
  assert.throws(()=>execFileSync("sh",[path.join(f.root,`uninstall-${id}`)], {env:f.env,stdio:"pipe"}),/Wiederherstellung/);
  assert.match(f.run(["recover"]),/recovered/);
  assert.equal(f.read("native-broadcast-packager"),content("old"));
  f.unchanged();
});

test("Linux recovery after backup publication retains its referenced backup", t => {
  const f=fixture(t); f.run(["update",f.prepare("new")]);
  const ref=f.read(".rollback-ref");
  fs.writeFileSync(path.join(f.root,".update-active"),ref);
  fs.writeFileSync(path.join(f.root,ref.trim(),"restore"),"interrupted-copy");
  f.run(["recover"]);
  assert.equal(f.read("native-broadcast-packager"),content("old"));
  assert.equal(f.read(`${ref.trim()}/old`),content("old"));
  f.run(["rollback"]); f.unchanged();
});

test("Linux maintenance rejects corrupt backups, traversals and identity symlinks before stopping services", t => {
  const f=fixture(t); f.run(["update",f.prepare("new")]);
  const ref=f.read(".rollback-ref").trim();
  fs.writeFileSync(path.join(f.root,ref,"old"),"tampered");
  assert.throws(()=>f.run(["rollback"]),/Invalid rollback backup/);
  fs.writeFileSync(path.join(f.root,".rollback-ref"),"../outside\n");
  assert.throws(()=>f.run(["rollback"]),/Invalid rollback backup/);
  fs.unlinkSync(path.join(f.root,".rollback-ref"));
  const identity=path.join(f.root,`identity-${id}.pem`); fs.renameSync(identity,`${identity}.saved`); fs.symlinkSync(`${identity}.saved`,identity);
  assert.throws(()=>f.run(["update",f.prepare("newer")]),/Existing binary and identity/);
  assert.equal(f.read("native-broadcast-packager"),content("new")); f.unchanged();
});

test("Linux updater and uninstaller share the same real nonblocking process lock", async t => {
  const f=fixture(t);
  const holder=spawn("flock",["-x",path.join(f.root,".maintenance.lock"),"sh","-c","echo ready; read answer"], {stdio:["pipe","pipe","pipe"]});
  t.after(()=>holder.kill());
  await once(holder.stdout,"data");
  assert.throws(()=>f.run(["update",f.prepare("new")]),/Another maintenance/);
  assert.throws(()=>execFileSync("sh",[path.join(f.root,`uninstall-${id}`)],{env:f.env,stdio:"pipe"}),/Maintenance aktiv/);
  holder.stdin.end("done\n"); await once(holder,"exit"); f.unchanged();
});
