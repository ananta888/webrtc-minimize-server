import { readFile } from "node:fs/promises";

/** Test-only observation of an already pinned owned Linux process. */
export async function ownedProcessStopped(pid, read = readFile) {
  if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error("invalid_owned_process");
  try {
    const status = await read(`/proc/${pid}/status`, "utf8");
    // An orphan may remain a zombie until init reaps it. A process disappearing
    // during the read can produce ESRCH, not only ENOENT at open time.
    return /^State:\s+Z\b/m.test(status);
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ESRCH") return true;
    throw error;
  }
}
