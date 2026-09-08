import { constants, closeSync, fstatSync, openSync, readSync, statSync } from "node:fs";

const MAXIMUM = 65536;
const snapshot = stat => [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
const valid = (stat, maximum) => stat.isFile() && stat.size >= 1n && stat.size <= BigInt(maximum);

/** Public configuration only: bounded bytes, regular file, same opened snapshot. */
export function readMachineTrustFile(path, maximum = MAXIMUM) {
  let descriptor;
  try {
    if (typeof path !== "string" || !path || path.includes("\0")
      || !Number.isSafeInteger(maximum) || maximum < 1 || maximum > MAXIMUM) throw new Error();
    const before = statSync(path, { bigint: true });
    if (!valid(before, maximum)) throw new Error();
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_CLOEXEC);
    const opened = fstatSync(descriptor, { bigint: true });
    if (!valid(opened, maximum) || snapshot(before) !== snapshot(opened)) throw new Error();
    const buffer = Buffer.alloc(maximum + 1);
    const count = readSync(descriptor, buffer, 0, buffer.length, 0);
    if (BigInt(count) !== opened.size || count > maximum
      || snapshot(opened) !== snapshot(fstatSync(descriptor, { bigint: true }))) throw new Error();
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, count));
  } catch { throw new Error("machine_trust_file_invalid"); }
  finally { if (descriptor !== undefined) closeSync(descriptor); }
}
