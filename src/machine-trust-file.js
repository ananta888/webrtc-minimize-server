import { constants, closeSync, fstatSync, openSync, readSync, statSync } from "node:fs";

const MAXIMUM = 65536;
const snapshot = stat => [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
const valid = stat => stat.isFile() && stat.size >= 1n && stat.size <= BigInt(MAXIMUM);

/** Public configuration only: bounded bytes, regular file, same opened snapshot. */
export function readMachineTrustFile(path) {
  let descriptor;
  try {
    if (typeof path !== "string" || !path || path.includes("\0")) throw new Error();
    const before = statSync(path, { bigint: true });
    if (!valid(before)) throw new Error();
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_CLOEXEC);
    const opened = fstatSync(descriptor, { bigint: true });
    if (!valid(opened) || snapshot(before) !== snapshot(opened)) throw new Error();
    const buffer = Buffer.alloc(MAXIMUM + 1);
    const count = readSync(descriptor, buffer, 0, buffer.length, 0);
    if (BigInt(count) !== opened.size || count > MAXIMUM
      || snapshot(opened) !== snapshot(fstatSync(descriptor, { bigint: true }))) throw new Error();
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, count));
  } catch { throw new Error("machine_trust_file_invalid"); }
  finally { if (descriptor !== undefined) closeSync(descriptor); }
}
