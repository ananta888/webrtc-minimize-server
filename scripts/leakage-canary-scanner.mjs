import { createReadStream, lstatSync, readdirSync } from "node:fs";
import path from "node:path";

export const BROADCAST_LEAKAGE_CANARIES = Object.freeze([
  "BCAST_TOKEN_CANARY_4edc348bf982",
  "BCAST_SECRET_CANARY_f69009a18d61",
  "BCAST_PRIVATE_KEY_CANARY_0b72cc3b8a11",
  "BCAST_ROOM_CANARY_a173f4d8720c",
  "BCAST_SDP_CANARY_021eb9cde117",
  "BCAST_ICE_CANARY_45a8dd2b79cc",
  "BCAST_CAPTION_CANARY_e725c0041681",
  "-----BEGIN PRIVATE KEY-----",
]);

function collect(input, files, budget) {
  const stat = lstatSync(input);
  if (stat.isSymbolicLink()) throw new Error("leakage_scan_symlink_forbidden");
  if (stat.isDirectory()) {
    for (const entry of readdirSync(input).sort()) collect(path.join(input, entry), files, budget);
    return;
  }
  if (!stat.isFile()) return;
  budget.total += stat.size;
  if (budget.total > budget.maximum) throw new Error("leakage_scan_budget_exceeded");
  files.push(input);
}

export async function scanPathsForCanaries(paths, {
  canaries = BROADCAST_LEAKAGE_CANARIES,
  maximumBytes = 1024 * 1024 * 1024,
} = {}) {
  if (!Array.isArray(paths) || paths.length < 1 || !Array.isArray(canaries) || canaries.length < 1) {
    throw new Error("invalid_leakage_scan");
  }
  const needles = canaries.map((value) => Buffer.from(String(value)));
  const overlap = Math.max(...needles.map((needle) => needle.length)) - 1;
  const files = [];
  const budget = { total: 0, maximum: maximumBytes };
  for (const input of paths) collect(path.resolve(input), files, budget);
  for (const file of files) {
    let tail = Buffer.alloc(0);
    for await (const chunk of createReadStream(file, { highWaterMark: 64 * 1024 })) {
      const searchable = Buffer.concat([tail, chunk]);
      const found = needles.findIndex((needle) => searchable.includes(needle));
      if (found >= 0) throw new Error(`broadcast_leakage_canary_found:${canaries[found]}:${path.basename(file)}`);
      tail = searchable.subarray(Math.max(0, searchable.length - overlap));
    }
  }
  return Object.freeze({ files: files.length, bytes: budget.total });
}
