import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { MediaAgentInstallerService } from "../src/media-agent-installers.js";

const ARTIFACTS = [
  "media-edge-agent-linux-amd64",
  "media-edge-agent-linux-arm64",
  "media-edge-agent-macos-amd64",
  "media-edge-agent-macos-arm64",
  "media-edge-agent-windows-amd64.exe",
];

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "media-agent-installers-"));
  for (const name of ARTIFACTS) fs.writeFileSync(path.join(directory, name), `binary:${name}`);
  return { directory, service: new MediaAgentInstallerService({ directory }) };
}

function enrollment(platform) {
  return {
    agentId: "edge-0123456789abcdef",
    label: "Robert'); Remove Everything",
    platform,
    token: "A".repeat(43),
    expiresAt: Date.now() + 600_000,
  };
}

test("installer catalog exposes only verified exact artifacts", (context) => {
  const { directory, service } = fixture();
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  assert.deepEqual(service.availableTargets().map(({ id }) => id), [
    "linux-amd64", "linux-arm64", "macos-amd64", "macos-arm64", "windows-amd64",
  ]);
  const artifact = service.artifact("linux-amd64");
  assert.match(artifact.sha256, /^[a-f0-9]{64}$/);
  assert.equal(artifact.size, Buffer.byteLength("binary:media-edge-agent-linux-amd64"));
  assert.throws(() => service.artifact("../secret"), /media_agent_artifact_unavailable/);
});

test("POSIX installers are syntax-valid, checksum-bound and use a one-time enrollment", (context) => {
  const { directory, service } = fixture();
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  for (const [targetId, platform] of [["linux-amd64", "linux"], ["macos-arm64", "macos"]]) {
    const installer = service.installer({
      enrollment: enrollment(platform),
      targetId,
      publicOrigin: "https://webrtc.example",
    });
    execFileSync("sh", ["-n", "-c", installer.content]);
    assert.match(installer.content, /curl --fail --location --proto "=https" --tlsv1\.2/);
    assert.match(installer.content, /MEDIA_AGENT_ENROLLMENT_TOKEN/);
    assert.match(installer.content, /wss:\/\/webrtc\.example\/media-agent/);
    assert.match(installer.content, new RegExp(installer.artifactSha256));
    if (platform === "linux") {
      assert.match(installer.content, /loginctl enable-linger "\$\(id -un\)"/);
      assert.match(installer.content, /Dauerhafter Benutzerbetrieb wurde aktiviert/);
    } else {
      assert.doesNotMatch(installer.content, /enable-linger/);
    }
    assert.doesNotMatch(installer.content, /Remove Everything/);
    assert.doesNotMatch(installer.content, /MEDIA_AGENT_SHARED_SECRET/);
    assert.match(installer.content, /Raumfreigabe bleibt .* standardmäßig AUS/);
    assert.match(installer.content, /rm -f -- "\$0"/);
  }
});

test("Windows installer is checksum-bound and starts only after explicit execution", (context) => {
  const { directory, service } = fixture();
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const installer = service.installer({
    enrollment: enrollment("windows"),
    targetId: "windows-amd64",
    publicOrigin: "https://webrtc.example",
  });
  assert.equal(installer.filename.endsWith(".ps1"), true);
  assert.match(installer.content, /Get-FileHash -Algorithm SHA256/);
  assert.match(installer.content, /MEDIA_AGENT_ENROLLMENT_TOKEN/);
  assert.match(installer.content, /Microsoft\\Windows\\Start Menu\\Programs\\Startup/);
  assert.match(installer.content, /Remove-Item -Force \$PSCommandPath/);
  assert.doesNotMatch(installer.content, /MEDIA_AGENT_SHARED_SECRET/);
});
