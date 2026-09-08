/** Best-effort wipe of an owned transferable buffer, including rejected input.
 * Does not claim erasure of browser-native copies or already exported strings. */
export function wipeMachinePcm(value: unknown): void {
  if (!(value instanceof ArrayBuffer)) return;
  try { new Uint8Array(value).fill(0); } catch { /* A transferred/detached buffer is no longer locally owned. */ }
}
