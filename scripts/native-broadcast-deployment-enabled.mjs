import fs from "node:fs";

let source = "";
try { source = fs.readFileSync(".env", "utf8"); } catch { /* fail closed below */ }
const values = new Map();
for (const line of source.split(/\r?\n/)) {
  if (!line || /^\s*#/.test(line)) continue;
  const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
  if (match) values.set(match[1], match[2].trim());
}
const enabled = values.get("BROADCAST_NATIVE_OUTPUT_ENABLED") === "true"
  && /^pkr_[A-Za-z0-9_-]{16,64}$/.test(values.get("NATIVE_PACKAGER_ID") || "")
  && values.get("BROADCAST_GATEWAY_ORIGIN") === "http://broadcast-hls-origin:8081";
process.stdout.write(enabled ? "enabled\n" : "disabled\n");
