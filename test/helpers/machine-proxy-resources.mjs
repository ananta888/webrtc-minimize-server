// Failure-only numeric projection for the owned Linux fixture. Neither /proc
// command lines/environment nor raw kernel records may enter diagnostics.
const integer = value => typeof value === "string" && /^(0|[1-9][0-9]{0,15})$/.test(value)
  && Number.isSafeInteger(Number(value)) ? Number(value) : null;
const CPU = ["usage_usec", "user_usec", "system_usec", "nr_periods", "nr_throttled", "throttled_usec"];
const MEMORY = ["low", "high", "max", "oom", "oom_kill", "oom_group_kill"];

export function projectMachineProxyResources(raw) {
  if (typeof raw !== "string" || Buffer.byteLength(raw) > 4096) return null;
  const lines = raw.trimEnd().split("\n");
  const stat = /^1 \(node\) ([RSDZTtXxKWIP]) (.*)$/.exec(lines[0]);
  let process = null;
  if (stat) {
    // stat fields 4.. onward. Expose no PID, executable, address or start time.
    const rest = stat[2].split(" ");
    const userTicks = integer(rest[10]), systemTicks = integer(rest[11]), threads = integer(rest[16]);
    if (userTicks !== null && systemTicks !== null && threads !== null && threads >= 1 && threads <= 32) {
      process = Object.freeze({ state: stat[1], userTicks, systemTicks, threads });
    }
  }
  const fields = new Map();
  for (const line of lines.slice(1)) {
    const [key, value, extra] = line.split(" ");
    if (!CPU.includes(key) && !MEMORY.includes(key)) continue;
    fields.set(key, fields.has(key) || extra !== undefined ? null : integer(value));
  }
  const group = keys => keys.some(key => fields.has(key))
    ? Object.freeze(Object.fromEntries(keys.map(key => [key, fields.get(key) ?? null]))) : null;
  return Object.freeze({ process, cpu: group(CPU), memory: group(MEMORY) });
}
