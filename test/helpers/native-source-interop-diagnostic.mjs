const fields = ["fixture", "frames", "keyframes", "decoded", "closed", "failure", "phase", "renewals", "leaseRemainingMs", "parentAllowed"];
const phases = ["prepare", "waiting", "receiver-ended", "deadline", "renewal", "control", "media-validation"];
const bounded = (value, minimum, maximum) => Number.isSafeInteger(value) && value >= minimum && value <= maximum;

/** Project only the closed synthetic fixture diagnostic; never forward raw data. */
export function nativeSourceInteropDiagnostic(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== fields.length
    || !fields.every(key => Object.hasOwn(value, key)) || value.fixture !== "diagnostic"
    || ![value.frames, value.keyframes, value.decoded].every(n => bounded(n, 0, 100000))
    || !bounded(value.failure, 0, 8) || !phases.includes(value.phase) || !bounded(value.renewals, 0, 32)
    || !bounded(value.leaseRemainingMs, -35000, 5000) || typeof value.closed !== "boolean" || typeof value.parentAllowed !== "boolean") return null;
  return { frames: value.frames, keyframes: value.keyframes, decoded: value.decoded, closed: value.closed,
    failure: value.failure, phase: value.phase, renewals: value.renewals,
    leaseRemainingMs: value.leaseRemainingMs, parentAllowed: value.parentAllowed };
}
