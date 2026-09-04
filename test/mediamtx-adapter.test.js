import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import YAML from "yaml";

const ROOT = new URL("../", import.meta.url);
const DIGEST = "sha256:1b029d11049be75630e9b73bb0d5f47b08a7db4eaee89a80bf8f53bc40e56414";

test("MediaMTX adapter is digest-pinned, least-privilege and recording-free", async () => {
  const [composeText, configText, sbomText, license] = await Promise.all([
    readFile(new URL("infra/mediamtx/compose.yaml", ROOT), "utf8"),
    readFile(new URL("infra/mediamtx/mediamtx.yml", ROOT), "utf8"),
    readFile(new URL("infra/mediamtx/sbom.cdx.json", ROOT), "utf8"),
    readFile(new URL("infra/mediamtx/LICENSE", ROOT), "utf8"),
  ]);
  const compose = YAML.parse(composeText);
  const config = YAML.parse(configText);
  const sbom = JSON.parse(sbomText);
  const service = compose.services["broadcast-gateway"];

  assert.equal(service.image, `bluenviron/mediamtx:1.20.1@${DIGEST}`);
  assert.deepEqual(service.profiles, ["broadcast-gateway"]);
  assert.equal(service.user, "65532:65532");
  assert.equal(service.read_only, true);
  assert.deepEqual(service.cap_drop, ["ALL"]);
  assert.ok(service.security_opt.includes("no-new-privileges:true"));
  assert.ok(service.ports.every((mapping) => String(mapping).startsWith("127.0.0.1:")));
  assert.ok(!service.ports.some((mapping) => /999[789]/.test(String(mapping))));
  assert.equal(compose.networks["broadcast-control"].internal, true);
  assert.equal(config.api, true);
  assert.equal(config.metrics, true);
  assert.equal(config.hls, true);
  assert.equal(config.hlsVariant, "lowLatency");
  assert.equal(config.webrtc, true);
  for (const disabled of ["rtsp", "rtmp", "srt", "moq", "pprof", "playback"]) {
    assert.equal(config[disabled], false, `${disabled} must remain disabled`);
  }
  assert.equal(config.pathDefaults.record, false);
  assert.equal(config.hlsDirectory, "");
  assert.equal(config.paths["~^res_[A-Za-z0-9_-]{16,64}$"].overridePublisher, false);
  const mediaUser = config.authInternalUsers.find((entry) => entry.ips?.includes("172.16.0.0/12"));
  assert.ok(mediaUser);
  assert.ok(mediaUser.permissions.every(({ path }) => path === "~^res_[A-Za-z0-9_-]{16,64}$"));
  assert.equal(sbom.components[0].version, "1.20.1");
  assert.equal(sbom.components[0].hashes[0].content, DIGEST.slice("sha256:".length));
  assert.equal(sbom.components[0].licenses[0].license.id, "MIT");
  assert.match(license, /^MIT License/);
  assert.doesNotMatch(`${composeText}\n${configText}`, /(?:password|token|secret)\s*:\s*[^"'\s][^\r\n]*/i);
});

test("MediaMTX secure overlay binds external auth to its isolated control network", async () => {
  const overlayText = await readFile(new URL("infra/mediamtx/compose.secure.yaml", ROOT), "utf8");
  const overlay = YAML.parse(overlayText);
  const web = overlay.services.webrtc;
  const gateway = overlay.services["broadcast-gateway"];

  assert.equal(web.environment.BROADCAST_GATEWAY_AUTH_ENABLED, "true");
  assert.equal(web.environment.BROADCAST_GATEWAY_AUTH_ADDRESSES, "${BROADCAST_GATEWAY_CONTROL_ADDRESS:-10.255.254.3}");
  assert.equal(web.networks["broadcast-control"].ipv4_address, "${BROADCAST_WEB_CONTROL_ADDRESS:-10.255.254.2}");
  assert.equal(gateway.environment.MTX_AUTHMETHOD, "http");
  assert.equal(
    gateway.environment.MTX_AUTHHTTPADDRESS,
    "http://webrtc:8080/internal/broadcast/mediamtx-auth",
  );
  assert.equal(gateway.networks["broadcast-control"].ipv4_address, "${BROADCAST_GATEWAY_CONTROL_ADDRESS:-10.255.254.3}");
  assert.equal(overlay.networks["broadcast-control"].internal, true);
  assert.match(gateway.environment.MTX_AUTHHTTPEXCLUDE, /"api"/);
  assert.match(gateway.environment.MTX_AUTHHTTPEXCLUDE, /"metrics"/);
  assert.doesNotMatch(overlayText, /(?:token|password|secret)\s*:/i);
});
