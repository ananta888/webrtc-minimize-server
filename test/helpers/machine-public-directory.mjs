import fs from "node:fs/promises";
import path from "node:path";

/** Explicit private test build only; never rewrites the serving dist directory. */
export async function machinePublicDirectory(value) {
  if (value === undefined) return undefined; // Existing fixture callers remain compatible.
  if (typeof value !== "string" || !path.isAbsolute(value) || value.length > 4096) {
    throw new Error("test_public_directory_invalid");
  }
  try {
    const directory = await fs.realpath(value);
    if (!(await fs.stat(path.join(directory, "index.html"))).isFile()) throw new Error();
    return directory;
  } catch { throw new Error("test_public_directory_unavailable"); }
}
