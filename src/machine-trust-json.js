// Bounded security configuration/JWT JSON. Never log the input or parser errors.
export function parseMachineTrustJson(raw, maximum = 65536) {
  try {
    if (typeof raw !== "string" || !raw.length || Buffer.byteLength(raw) > maximum) throw new Error();
    const result = JSON.parse(raw);
    // JSON.parse validates grammar; this independent token walk preserves
    // duplicate/escaped property names before last-write-wins can hide them.
    const tokens = /"(?:[^"\\]|\\.)*"|[{}\[\]]/g;
    const stack = [];
    for (const match of raw.matchAll(tokens)) {
      const value = match[0];
      if (value === "{" || value === "[") {
        if (stack.length >= 8) throw new Error();
        stack.push(value === "{" ? new Set() : null);
      } else if (value === "}" || value === "]") stack.pop();
      else if (/^[\x20\t\r\n]*:/.test(raw.slice(match.index + value.length))) {
        const key = JSON.parse(value), names = stack.at(-1);
        if (!names || names.has(key)) throw new Error();
        names.add(key);
      }
    }
    return result;
  } catch { throw new Error("machine_trust_json_invalid"); }
}
