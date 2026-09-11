const states = {
  "assignment-status": ["ready", "starting", "running", "degraded", "draining", "stopped", "failed"],
  "trusted-source-status": ["receiver-prepared", "failed", "stopped"],
};

/** Test-only bounded status history; repeated renewals cannot hide transitions. */
export function recordNativeStatus(rows, value) {
  if (!Object.hasOwn(states, value?.type ?? "") || !states[value.type].includes(value.state)) return;
  const code = value.type === "assignment-status" && typeof value.reasonCode === "string"
    && /^[A-Z][A-Z0-9_]{1,63}$/.test(value.reasonCode) ? value.reasonCode : null;
  const last = rows.at(-1);
  if (last?.type === value.type && last.state === value.state && last.code === code) {
    rows[rows.length - 1] = Object.freeze({ ...last, count: Math.min(1000, last.count + 1) });
    return;
  }
  rows.push(Object.freeze({ type: value.type, state: value.state, code, count: 1 }));
  if (rows.length > 32) rows.shift();
}
