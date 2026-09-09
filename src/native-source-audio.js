const scope = ["commandId", "assignmentId", "programId", "programEpoch", "leaseId", "fencingRevision"];
const baseFields = ["version", "type", ...scope];
const closed = (value, keys) => value && typeof value === "object" && !Array.isArray(value)
  && Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key));
const positive = value => Number.isSafeInteger(value) && value > 0;
const ref = (value, prefix) => typeof value === "string" && new RegExp(`^${prefix}_[A-Za-z0-9_-]{16,64}$`).test(value);
const fail = () => { throw new Error("invalid_native_source_audio"); };

function base(value, type, fields, now) {
  if (!closed(value, [...baseFields, "issuedAt", "expiresAt", ...fields]) || value.version !== 1 || value.type !== type
    || !ref(value.commandId, "aud") || !ref(value.assignmentId, "asn") || !ref(value.programId, "prg") || !ref(value.leaseId, "lea")
    || !positive(value.programEpoch) || !positive(value.fencingRevision) || !positive(now)
    || !positive(value.issuedAt) || !positive(value.expiresAt) || value.issuedAt > now + 1000
    || value.expiresAt <= now || value.expiresAt <= value.issuedAt || value.expiresAt - value.issuedAt > 4000) fail();
}

function sources(value, observed) {
  const fields = ["sourceLeaseId", "leftGainQ15", "rightGainQ15", "muted", ...(observed ? ["sourceKind"] : [])];
  const gain = value => Number.isSafeInteger(value) && value >= 0 && value <= 32768;
  if (!Array.isArray(value) || value.length > 80 || !observed && value.length === 0
    || value.some(s => !closed(s, fields) || !ref(s.sourceLeaseId, "sls") || !gain(s.leftGainQ15) || !gain(s.rightGainQ15)
      || typeof s.muted !== "boolean" || observed && !["microphone", "screen-audio"].includes(s.sourceKind))
    || new Set(value.map(s => s.sourceLeaseId)).size !== value.length) fail();
  return Object.freeze(value.map(s => Object.freeze({ ...s })));
}

/** Presentation metadata only, never director/source/socket authority. */
export function normalizeNativeAudioSelection(value) {
  if (!closed(value, ["expectedAudioRevision", "sources"]) || !positive(value.expectedAudioRevision)
    || value.expectedAudioRevision === Number.MAX_SAFE_INTEGER) fail();
  return Object.freeze({ ...value, sources: sources(value.sources, false) });
}

export function normalizeNativeSourceAudio(value, now = Date.now()) {
  base(value, "source-program-audio", ["expectedAudioRevision", "sources"], now);
  if (!positive(value.expectedAudioRevision) || value.expectedAudioRevision === Number.MAX_SAFE_INTEGER) fail();
  return Object.freeze({ ...value, sources: sources(value.sources, false) });
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
  if (!closed(value, [...baseFields, at, ...extra]) || value.version !== 1 || value.type !== type
    || scope.some(key => value[key] !== command[key]) || !positive(value[at])
    || value[at] < command.issuedAt - 1000 || value[at] > now + 1000 || value[at] >= command.expiresAt) fail();
  if (query && !positive(value.audioRevision) || applied && value.audioRevision !== command.expectedAudioRevision + 1
    || !query && !applied && value.reasonCode !== "AUDIO_NOT_APPLIED") fail();
  return Object.freeze({ ...value, ...(query ? { sources: sources(value.sources, true) } : {}) });
}
