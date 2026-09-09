const scope = ["commandId", "assignmentId", "programId", "programEpoch", "leaseId", "fencingRevision"];
const baseFields = ["version", "type", ...scope];
const closed = (value, keys) => value && typeof value === "object" && !Array.isArray(value)
  && Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key));
const positive = value => Number.isSafeInteger(value) && value > 0;
const ref = (value, prefix) => typeof value === "string" && new RegExp(`^${prefix}_[A-Za-z0-9_-]{16,64}$`).test(value);
const fail = () => { throw new Error("invalid_native_source_audio"); };
export const NATIVE_AUDIO_STRATEGIES = Object.freeze(["unprocessed", "balanced", "speech-first", "screen-first"]);
const gain = value => Number.isSafeInteger(value) && value >= 0 && value <= 32768;

function mix(value) {
  if (!closed(value, ["strategy", "microphoneGainQ15", "screenAudioGainQ15", "limiterGainQ15", "peakQ15"])
    || !NATIVE_AUDIO_STRATEGIES.includes(value.strategy)
    || [value.microphoneGainQ15, value.screenAudioGainQ15, value.limiterGainQ15, value.peakQ15].some(v => !gain(v))) fail();
  return Object.freeze({ ...value });
}

function encoding(value) {
  if (!closed(value, ["codec", "sampleRate", "channels", "renditions"]) || value.codec !== "aac" || value.sampleRate !== 48000 || value.channels !== 2
    || !Array.isArray(value.renditions) || value.renditions.length < 1 || value.renditions.length > 3
    || value.renditions.some(r => !closed(r, ["id", "targetBitsPerSecond"]) || !["low", "medium", "high"].includes(r.id)
      || !Number.isSafeInteger(r.targetBitsPerSecond) || r.targetBitsPerSecond < 16000 || r.targetBitsPerSecond > 320000)
    || new Set(value.renditions.map(r => r.id)).size !== value.renditions.length) fail();
  return Object.freeze({ ...value, renditions: Object.freeze(value.renditions.map(r => Object.freeze({ ...r }))) });
}

function base(value, type, fields, now) {
  if (!closed(value, [...baseFields, "issuedAt", "expiresAt", ...fields]) || ![1, 2].includes(value.version) || value.type !== type
    || !ref(value.commandId, "aud") || !ref(value.assignmentId, "asn") || !ref(value.programId, "prg") || !ref(value.leaseId, "lea")
    || !positive(value.programEpoch) || !positive(value.fencingRevision) || !positive(now)
    || !positive(value.issuedAt) || !positive(value.expiresAt) || value.issuedAt > now + 1000
    || value.expiresAt <= now || value.expiresAt <= value.issuedAt || value.expiresAt - value.issuedAt > 4000) fail();
}

function sources(value, observed, allowEmpty = observed) {
  const fields = ["sourceLeaseId", "leftGainQ15", "rightGainQ15", "muted", ...(observed ? ["sourceKind"] : [])];
  if (!Array.isArray(value) || value.length > 80 || !allowEmpty && value.length === 0
    || value.some(s => !closed(s, fields) || !ref(s.sourceLeaseId, "sls") || !gain(s.leftGainQ15) || !gain(s.rightGainQ15)
      || typeof s.muted !== "boolean" || observed && !["microphone", "screen-audio"].includes(s.sourceKind))
    || new Set(value.map(s => s.sourceLeaseId)).size !== value.length) fail();
  return Object.freeze(value.map(s => Object.freeze({ ...s })));
}

/** Presentation metadata only, never director/source/socket authority. */
export function normalizeNativeAudioSelection(value, version = 1) {
  if (![1, 2].includes(version) || !closed(value, ["expectedAudioRevision", "sources", ...(version === 2 ? ["strategy"] : [])])
    || !positive(value.expectedAudioRevision) || value.expectedAudioRevision === Number.MAX_SAFE_INTEGER
    || version === 2 && !NATIVE_AUDIO_STRATEGIES.includes(value.strategy)) fail();
  return Object.freeze({ ...value, sources: sources(value.sources, false, version === 2) });
}

export function normalizeNativeSourceAudio(value, now = Date.now()) {
  base(value, "source-program-audio", ["expectedAudioRevision", "sources", ...(value?.version === 2 ? ["strategy"] : [])], now);
  const selection = normalizeNativeAudioSelection({ expectedAudioRevision: value.expectedAudioRevision, sources: value.sources,
    ...(value.version === 2 ? { strategy: value.strategy } : {}) }, value.version);
  return Object.freeze({ ...value, ...selection });
}

export function normalizeNativeSourceAudioQuery(value, now = Date.now()) {
  base(value, "source-program-audio-query", [], now);
  return Object.freeze({ ...value });
}

/** Correlates one fresh request. A historical receipt does not renew source authority. */
export function normalizeNativeSourceAudioReply(value, request, now = Date.now()) {
  const query = request?.type === "source-program-audio-query";
  const command = query ? normalizeNativeSourceAudioQuery(request, now) : normalizeNativeSourceAudio(request, now);
  const applied = !query && value?.type === "source-program-audio-applied";
  const type = query ? "source-program-audio-state" : applied ? "source-program-audio-applied" : "source-program-audio-rejected";
  const at = applied ? "appliedAt" : "observedAt";
  const extra = query ? ["audioRevision", "sources"] : applied ? ["audioRevision"] : ["reasonCode"];
  if (query && command.version === 2) extra.push("mix", "encoding");
  if (!closed(value, [...baseFields, at, ...extra]) || value.version !== command.version || value.type !== type
    || scope.some(key => value[key] !== command[key]) || !positive(value[at])
    || value[at] < command.issuedAt - 1000 || value[at] > now + 1000 || value[at] >= command.expiresAt) fail();
  if (query && !positive(value.audioRevision) || applied && value.audioRevision !== command.expectedAudioRevision + 1
    || !query && !applied && value.reasonCode !== "AUDIO_NOT_APPLIED") fail();
  return Object.freeze({ ...value, ...(query ? { sources: sources(value.sources, true) } : {}),
    ...(query && command.version === 2 ? { mix: mix(value.mix), encoding: encoding(value.encoding) } : {}) });
}
