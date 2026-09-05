import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readFile, readlink, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import test from "node:test";

const run = promisify(execFile);
const script = new URL("../scripts/sync-turn-tls-certificate.sh", import.meta.url).pathname;

async function certificate(directory, name, hostname) {
  const key = path.join(directory, `${name}.key`);
  const cert = path.join(directory, `${name}.crt`);
  await run("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "30",
    "-subj", `/CN=${hostname}`, "-addext", `subjectAltName=DNS:${hostname}`, "-keyout", key, "-out", cert]);
  await chmod(key, 0o600);
  await chmod(cert, 0o600);
  return { key, cert };
}

function environment(pair, target) {
  return {
    ...process.env,
    TURN_TLS_SOURCE_CERT: pair.cert,
    TURN_TLS_SOURCE_KEY: pair.key,
    TURN_TLS_TARGET_DIR: target,
    TURN_TLS_SERVER_NAME: "webrtc.ananta.de",
    TURN_TLS_MIN_VALID_SECONDS: "3600",
    TURN_TLS_SOURCE_UID: String(process.getuid()),
    TURN_TLS_TARGET_UID: String(process.getuid()),
    TURN_TLS_TARGET_GID: String(process.getgid()),
    TURN_TLS_RESTART_ENABLED: "0",
  };
}

test("TURN TLS sync validates and atomically activates a matching certificate", async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), "turn-tls-sync-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const target = path.join(directory, "target");
  const pair = await certificate(directory, "valid", "webrtc.ananta.de");

  const first = await run(script, { env: environment(pair, target) });
  assert.match(first.stdout, /updated and validated/);
  assert.equal((await lstat(path.join(target, "current"))).isSymbolicLink(), true);
  assert.match(await readlink(path.join(target, "current")), /^releases\/[a-f0-9]{64}$/);
  assert.equal((await stat(path.join(target, "current", "certificate.pem"))).mode & 0o777, 0o444);
  assert.equal((await stat(path.join(target, "current", "private-key.pem"))).mode & 0o777, 0o440);
  assert.equal(await readFile(path.join(target, "current", "certificate.pem"), "utf8"), await readFile(pair.cert, "utf8"));

  await chmod(path.join(target, "current", "private-key.pem"), 0o600);
  const second = await run(script, { env: environment(pair, target) });
  assert.match(second.stdout, /already current/);
  assert.equal((await stat(path.join(target, "current", "private-key.pem"))).mode & 0o777, 0o440);
});

test("TURN TLS sync rejects a hostname mismatch without activating material", async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), "turn-tls-host-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const target = path.join(directory, "target");
  const pair = await certificate(directory, "wrong-host", "other.example.test");

  await assert.rejects(run(script, { env: environment(pair, target) }), /does not cover/);
  await assert.rejects(lstat(path.join(target, "current")), { code: "ENOENT" });
});

test("TURN TLS sync rejects a mismatched private key", async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), "turn-tls-key-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const target = path.join(directory, "target");
  const pair = await certificate(directory, "valid", "webrtc.ananta.de");
  const other = await certificate(directory, "other", "webrtc.ananta.de");
  await writeFile(pair.key, await readFile(other.key));
  await chmod(pair.key, 0o600);

  await assert.rejects(run(script, { env: environment(pair, target) }), /do not match/);
  await assert.rejects(lstat(path.join(target, "current")), { code: "ENOENT" });
});

test("TURN TLS sync retries a failed Coturn restart after certificate activation", async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), "turn-tls-restart-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const target = path.join(directory, "target");
  const binaryDirectory = path.join(directory, "bin");
  const failMarker = path.join(directory, "fail-restart");
  const pair = await certificate(directory, "valid", "webrtc.ananta.de");
  await mkdir(binaryDirectory);
  const docker = path.join(binaryDirectory, "docker");
  await writeFile(docker, `#!/bin/sh
case "$1" in
  ps) printf 'container-id\\n' ;;
  restart) [ ! -e "$FAKE_DOCKER_FAIL" ] ;;
  inspect) printf 'true\\n' ;;
  *) exit 2 ;;
esac
`);
  await chmod(docker, 0o755);
  await writeFile(failMarker, "fail");
  const env = {
    ...environment(pair, target),
    TURN_TLS_RESTART_ENABLED: "1",
    FAKE_DOCKER_FAIL: failMarker,
    PATH: `${binaryDirectory}:${process.env.PATH}`,
  };

  await assert.rejects(run(script, { env }));
  assert.equal((await stat(path.join(target, "restart-required"))).isFile(), true);
  assert.equal((await lstat(path.join(target, "current"))).isSymbolicLink(), true);

  await rm(failMarker);
  const retry = await run(script, { env });
  assert.match(retry.stdout, /pending restart completed/);
  await assert.rejects(stat(path.join(target, "restart-required")), { code: "ENOENT" });
});
