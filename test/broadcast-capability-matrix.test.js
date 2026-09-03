import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const matrixUrl = new URL("../docs/broadcast-capability-matrix.v1.json", import.meta.url);

const parseMatrix = async () => JSON.parse(await readFile(matrixUrl, "utf8"));

const sorted = (values) => [...values].sort();

const assertClosedKeys = (value, expected, label) => {
  assert.deepEqual(sorted(Object.keys(value)), sorted(expected), `${label} contains unknown or missing fields`);
};

const indexById = (values, label) => {
  const index = new Map(values.map((value) => [value.id, value]));
  assert.equal(index.size, values.length, `${label} ids must be unique`);
  return index;
};

test("broadcast capability evidence is versioned, closed and source-resolvable", async () => {
  const matrix = await parseMatrix();
  assertClosedKeys(matrix, [
    "version",
    "snapshotDate",
    "evidencePolicy",
    "standards",
    "players",
    "browsers",
    "codecs",
    "adapters",
    "sources",
  ], "matrix");
  assert.equal(matrix.version, 1);
  assert.match(matrix.snapshotDate, /^\d{4}-\d{2}-\d{2}$/);

  assertClosedKeys(matrix.evidencePolicy, [
    "statusValues",
    "statusMeaning",
    "productRule",
    "hardwareRule",
    "legalRule",
  ], "evidencePolicy");
  const statuses = ["supported", "degraded", "experimental", "unavailable"];
  assert.deepEqual(matrix.evidencePolicy.statusValues, statuses);
  assertClosedKeys(matrix.evidencePolicy.statusMeaning, statuses, "statusMeaning");

  const sourceIndex = indexById(matrix.sources, "source");
  for (const source of matrix.sources) {
    assertClosedKeys(source, ["id", "url", "retrieved"], `source ${source.id}`);
    assert.match(source.id, /^SRC-[A-Z0-9.-]+$/);
    assert.equal(source.retrieved, matrix.snapshotDate);
    assert.match(source.url, /^(https:\/\/|\.\/)/);
  }

  const referenced = new Set();
  const validateSourceIds = (value, label) => {
    assert.ok(value.sourceIds.length > 0, `${label} requires evidence`);
    assert.equal(new Set(value.sourceIds).size, value.sourceIds.length, `${label} repeats a source`);
    for (const sourceId of value.sourceIds) {
      assert.ok(sourceIndex.has(sourceId), `${label} references unknown ${sourceId}`);
      referenced.add(sourceId);
    }
  };

  for (const standard of matrix.standards) {
    assertClosedKeys(standard, [
      "id",
      "version",
      "kind",
      "published",
      "expires",
      "status",
      "productStatus",
      "sourceIds",
      "note",
    ], `standard ${standard.id}`);
    assert.ok(statuses.includes(standard.status));
    assert.ok(statuses.includes(standard.productStatus));
    validateSourceIds(standard, `standard ${standard.id}`);
  }

  for (const player of matrix.players) {
    assertClosedKeys(player, [
      "id",
      "version",
      "engine",
      "upstreamStatus",
      "productStatus",
      "runtimeVerified",
      "outputs",
      "sourceIds",
      "note",
    ], `player ${player.id}`);
    assert.ok(statuses.includes(player.upstreamStatus));
    assert.ok(statuses.includes(player.productStatus));
    assert.equal(typeof player.runtimeVerified, "boolean");
    assert.ok(player.outputs.length > 0);
    validateSourceIds(player, `player ${player.id}`);
  }

  for (const [collectionName, collection] of [
    ["browser", matrix.browsers],
    ["codec", matrix.codecs],
    ["adapter", matrix.adapters],
  ]) {
    for (const value of collection) {
      validateSourceIds(value, `${collectionName} ${value.id}`);
    }
  }
  assert.deepEqual(sorted(referenced), sorted(sourceIndex.keys()),
    "every pinned source must support at least one inventory claim");
});

test("standards and player pins cannot silently drift", async () => {
  const matrix = await parseMatrix();
  const standards = indexById(matrix.standards, "standard");
  const players = indexById(matrix.players, "player");

  assert.deepEqual(sorted(standards.keys()), sorted([
    "whip",
    "whep",
    "hls",
    "ll-hls",
    "moqt",
    "loc",
    "moq-secure-objects",
    "sframe",
  ]));
  assert.equal(standards.get("whip").version, "RFC 9725");
  assert.equal(standards.get("whep").version, "draft-ietf-wish-whep-04");
  assert.equal(standards.get("moqt").version, "draft-ietf-moq-transport-20");
  assert.equal(standards.get("loc").version, "draft-ietf-moq-loc-04");
  assert.equal(standards.get("moq-secure-objects").version, "draft-ietf-moq-secure-objects-01");
  for (const draft of ["whep", "moqt", "loc", "moq-secure-objects"]) {
    assert.equal(standards.get(draft).status, "experimental");
    assert.equal(standards.get(draft).productStatus, "unavailable");
  }

  assert.equal(players.get("hls-js").version, "1.7.2");
  assert.equal(players.get("mediamtx-embedded-hls").version, "MediaMTX 1.20.1 with hls.js 1.7.0");
  assert.equal(players.get("mediamtx-moq-browser-demo").version,
    "MediaMTX 1.20.1 / MOQT draft-19 preference");
  for (const player of matrix.players) {
    assert.equal(player.productStatus, "unavailable");
    assert.equal(player.runtimeVerified, false);
  }
});

test("browser matrix covers every required platform and capability without claiming broadcast readiness", async () => {
  const matrix = await parseMatrix();
  const browserIndex = indexById(matrix.browsers, "browser");
  const statuses = new Set(matrix.evidencePolicy.statusValues);
  const featureKeys = [
    "captureAudioVideo",
    "screenVideo",
    "systemAudio",
    "encodedTransforms",
    "whipPublish",
    "hlsPlayback",
    "llHlsPlayback",
    "webTransport",
    "moqPublish",
    "moqPlayback",
    "audibleAutoplay",
  ];
  assert.deepEqual(sorted(browserIndex.keys()), sorted([
    "chromium-desktop-linux",
    "edge-desktop",
    "firefox-desktop-linux",
    "safari-desktop",
    "chrome-android",
    "firefox-android",
    "safari-ios",
  ]));

  for (const browser of matrix.browsers) {
    assertClosedKeys(browser, [
      "id",
      "family",
      "platform",
      "testedVersion",
      "compatibilityBasis",
      "features",
      "sourceIds",
    ], `browser ${browser.id}`);
    assertClosedKeys(browser.features, featureKeys, `browser ${browser.id} features`);
    for (const [featureName, feature] of Object.entries(browser.features)) {
      assertClosedKeys(feature, ["upstreamStatus", "productStatus", "runtimeVerified", "note"],
        `${browser.id}.${featureName}`);
      assert.ok(statuses.has(feature.upstreamStatus));
      assert.ok(statuses.has(feature.productStatus));
      assert.equal(typeof feature.runtimeVerified, "boolean");
      if (feature.productStatus === "supported") {
        assert.equal(feature.runtimeVerified, true,
          `${browser.id}.${featureName} cannot be product-supported without a runtime gate`);
      }
    }
    for (const featureName of [
      "whipPublish",
      "hlsPlayback",
      "llHlsPlayback",
      "moqPublish",
      "moqPlayback",
    ]) {
      assert.equal(browser.features[featureName].productStatus, "unavailable",
        `${browser.id}.${featureName} must stay disabled before implementation gates`);
    }
  }

  assert.equal(browserIndex.get("chromium-desktop-linux").testedVersion, "151.0.7922.34");
  assert.equal(browserIndex.get("firefox-desktop-linux").testedVersion, "153.0");
  assert.equal(browserIndex.get("firefox-desktop-linux").features.systemAudio.upstreamStatus, "unavailable");
  assert.equal(browserIndex.get("safari-desktop").features.hlsPlayback.upstreamStatus, "supported");
  assert.equal(browserIndex.get("chrome-android").features.screenVideo.upstreamStatus, "unavailable");
  assert.equal(browserIndex.get("safari-ios").features.screenVideo.upstreamStatus, "unavailable");
  assert.equal(browserIndex.get("safari-ios").features.audibleAutoplay.upstreamStatus, "degraded");
});

test("codec matrix separates passthrough, transcoding, Safari output and operational risk", async () => {
  const matrix = await parseMatrix();
  const codecs = indexById(matrix.codecs, "codec");
  const statuses = new Set(matrix.evidencePolicy.statusValues);
  assert.deepEqual(sorted(codecs.keys()), sorted(["opus", "aac", "vp8", "vp9", "h264", "av1"]));

  for (const codec of matrix.codecs) {
    assertClosedKeys(codec, [
      "id",
      "kind",
      "browserWhipIngest",
      "mediamtxWhipIngest",
      "whipToHlsPassthrough",
      "mediamtxTranscoding",
      "safariHlsOutput",
      "baselineTranscoding",
      "hardwareAcceleration",
      "licensing",
      "operations",
      "sourceIds",
    ], `codec ${codec.id}`);
    for (const property of [
      "browserWhipIngest",
      "mediamtxWhipIngest",
      "whipToHlsPassthrough",
      "mediamtxTranscoding",
      "safariHlsOutput",
      "hardwareAcceleration",
    ]) {
      assert.ok(statuses.has(codec[property]), `${codec.id}.${property} has an unknown status`);
    }
    assert.ok(["required", "conditional", "not-required"].includes(codec.baselineTranscoding));
    assert.equal(codec.mediamtxTranscoding, "unavailable",
      `${codec.id} must not present MediaMTX remuxing as transcoding`);
    assert.ok(codec.licensing.length > 30);
    assert.ok(codec.operations.length > 50);
  }

  assert.equal(codecs.get("opus").baselineTranscoding, "required");
  assert.equal(codecs.get("aac").mediamtxWhipIngest, "unavailable");
  assert.equal(codecs.get("vp8").whipToHlsPassthrough, "unavailable");
  assert.equal(codecs.get("vp8").baselineTranscoding, "required");
  assert.equal(codecs.get("vp9").safariHlsOutput, "unavailable");
  assert.equal(codecs.get("h264").safariHlsOutput, "supported");
  assert.equal(codecs.get("h264").baselineTranscoding, "conditional");
  assert.equal(codecs.get("av1").safariHlsOutput, "degraded");
});

test("adapter inventory is closed, default-off and denies unsupported protocol combinations", async () => {
  const matrix = await parseMatrix();
  const adapters = indexById(matrix.adapters, "adapter");
  const statuses = new Set(matrix.evidencePolicy.statusValues);
  const adapterIds = [
    "mediamtx-self-hosted",
    "cloudflare-stream-webrtc",
    "cloudflare-stream-live",
    "cloudflare-moq",
    "native-ffmpeg-packager",
  ];
  assert.deepEqual(sorted(adapters.keys()), sorted(adapterIds));

  for (const adapter of matrix.adapters) {
    assertClosedKeys(adapter, [
      "id",
      "vendor",
      "version",
      "apiVersion",
      "lifecycle",
      "productStatus",
      "runtimeVerified",
      "enabledByDefault",
      "capabilities",
      "constraints",
      "sourceIds",
    ], `adapter ${adapter.id}`);
    assert.ok(statuses.has(adapter.productStatus));
    assert.equal(adapter.productStatus, "unavailable");
    assert.equal(adapter.runtimeVerified, false);
    assert.equal(adapter.enabledByDefault, false);
    assert.ok(adapter.constraints.length > 0);
    assertClosedKeys(adapter.capabilities, [
      "ingest",
      "output",
      "auth",
      "recording",
      "captions",
      "e2ee",
      "remux",
      "transcoding",
    ], `${adapter.id}.capabilities`);
    assertClosedKeys(adapter.capabilities.ingest, ["whip", "rtmps", "srt", "moq"],
      `${adapter.id}.ingest`);
    assertClosedKeys(adapter.capabilities.output, ["hls", "llHls", "whep", "moq", "dash"],
      `${adapter.id}.output`);
    assertClosedKeys(adapter.capabilities.auth, [
      "bearerHeader",
      "externalHttp",
      "jwt",
      "pathScoped",
      "shortLivedGrantNative",
    ], `${adapter.id}.auth`);
    assertClosedKeys(adapter.capabilities.recording, [
      "available",
      "defaultEnabled",
      "requiredForLlHls",
    ], `${adapter.id}.recording`);
    assertClosedKeys(adapter.capabilities.captions, ["webVttLive", "imsc1Live"],
      `${adapter.id}.captions`);
    assertClosedKeys(adapter.capabilities.e2ee, ["sframePassthroughProven", "moqSecureObjects"],
      `${adapter.id}.e2ee`);
    for (const capability of [
      ...Object.values(adapter.capabilities.ingest),
      ...Object.values(adapter.capabilities.output),
      ...Object.values(adapter.capabilities.auth),
      ...Object.values(adapter.capabilities.recording),
      ...Object.values(adapter.capabilities.captions),
      ...Object.values(adapter.capabilities.e2ee),
      adapter.capabilities.remux,
      adapter.capabilities.transcoding,
    ]) {
      assert.equal(typeof capability, "boolean");
    }
    assert.equal(adapter.capabilities.recording.defaultEnabled, false);
    assert.equal(adapter.capabilities.e2ee.sframePassthroughProven, false);
    assert.equal(adapter.capabilities.e2ee.moqSecureObjects, false);
  }

  const mediamtx = adapters.get("mediamtx-self-hosted");
  assert.equal(mediamtx.version, "1.20.1");
  assert.equal(mediamtx.apiVersion, "Control API v3 bundled with 1.20.1");
  assert.equal(mediamtx.capabilities.ingest.whip, true);
  assert.equal(mediamtx.capabilities.output.llHls, true);
  assert.equal(mediamtx.capabilities.remux, true);
  assert.equal(mediamtx.capabilities.transcoding, false);

  const cloudflareWebRtc = adapters.get("cloudflare-stream-webrtc");
  assert.equal(cloudflareWebRtc.apiVersion, "Cloudflare API v4");
  assert.equal(cloudflareWebRtc.capabilities.ingest.whip, true);
  assert.equal(cloudflareWebRtc.capabilities.output.whep, true);
  assert.equal(cloudflareWebRtc.capabilities.output.hls, false);
  assert.equal(cloudflareWebRtc.capabilities.output.llHls, false);
  assert.equal(cloudflareWebRtc.capabilities.recording.available, false);

  const cloudflareLive = adapters.get("cloudflare-stream-live");
  assert.equal(cloudflareLive.capabilities.ingest.whip, false);
  assert.equal(cloudflareLive.capabilities.ingest.rtmps, true);
  assert.equal(cloudflareLive.capabilities.output.llHls, true);
  assert.equal(cloudflareLive.capabilities.recording.requiredForLlHls, true);

  const cloudflareMoq = adapters.get("cloudflare-moq");
  assert.equal(cloudflareMoq.capabilities.ingest.moq, true);
  assert.equal(cloudflareMoq.capabilities.output.moq, true);
  assert.equal(cloudflareMoq.capabilities.output.hls, false);

  const plannedNative = adapters.get("native-ffmpeg-packager");
  assert.equal(plannedNative.version, "not-selected");
  const plannedClaims = [
    ...Object.values(plannedNative.capabilities.ingest),
    ...Object.values(plannedNative.capabilities.output),
    ...Object.values(plannedNative.capabilities.auth),
    ...Object.values(plannedNative.capabilities.recording),
    ...Object.values(plannedNative.capabilities.captions),
    ...Object.values(plannedNative.capabilities.e2ee),
    plannedNative.capabilities.remux,
    plannedNative.capabilities.transcoding,
  ];
  assert.equal(plannedClaims.every((value) => value === false), true,
    "planned native adapter cannot advertise capabilities before a build/runtime gate");
});
