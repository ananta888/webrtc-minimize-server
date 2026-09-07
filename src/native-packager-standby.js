const PACKAGER = /^pkr_[A-Za-z0-9_-]{16,64}$/;
const FIELDS = new Set(["requestVersion", "trigger", "expectedProgramRevision", "expectedProgramEpoch",
  "expectedStandbyRevision", "standbyPackagerIds", "requestedRenditions", "allowHardwareAcceleration"]);

export class NativePackagerStandbyError extends Error {
  constructor(code, status = 400) { super(code); this.code = code; this.status = status; }
}

export function normalizeNativeStandbySelection(value) {
  const fail = () => { throw new NativePackagerStandbyError("invalid_native_standby_selection"); };
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).length !== FIELDS.size || Object.keys(value).some(key => !FIELDS.has(key))
    || value.requestVersion !== 1 || value.trigger !== "user-action"
    || ![value.expectedProgramRevision, value.expectedProgramEpoch].every(n => Number.isSafeInteger(n) && n > 0)
    || !Number.isSafeInteger(value.expectedStandbyRevision) || value.expectedStandbyRevision < 0
    || !Array.isArray(value.standbyPackagerIds) || value.standbyPackagerIds.length > 2
    || value.standbyPackagerIds.some(id => typeof id !== "string" || !PACKAGER.test(id))
    || new Set(value.standbyPackagerIds).size !== value.standbyPackagerIds.length
    || !Number.isSafeInteger(value.requestedRenditions) || value.requestedRenditions < 1 || value.requestedRenditions > 3
    || typeof value.allowHardwareAcceleration !== "boolean") fail();
  return Object.freeze({ ...value, standbyPackagerIds: Object.freeze([...value.standbyPackagerIds]) });
}

// Metadata only: this projection is never an assignment, lease or admission grant.
export function nativeStandbyProjection(machine, plan) {
  const current = plan?.programEpoch === machine.program.programEpoch ? plan : null;
  return Object.freeze({
    controlVersion: 1, programId: machine.program.programId,
    programRevision: machine.program.revision, programEpoch: machine.program.programEpoch,
    standbyRevision: current?.revision || 0,
    standbyPackagerIds: Object.freeze([...(current?.packagerIds || [])]),
  });
}
