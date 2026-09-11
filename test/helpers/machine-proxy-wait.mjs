// Private fixture observation only. Never expose arbitrary kernel symbols,
// addresses or strings. A matching symbol is a snapshot, not a diagnosis.
const SYMBOLS = new Set([
  "folio_wait_bit_common", "wait_on_page_bit_common", "wait_on_buffer",
  "io_schedule", "wait_for_random_bytes", "balance_dirty_pages",
  "__alloc_pages_slowpath", "try_to_free_pages", "futex_wait_queue",
  "futex_wait_queue_me", "do_epoll_wait", "ep_poll",
]);
export function projectMachineProxyWait(raw) {
  if (typeof raw !== "string" || Buffer.byteLength(raw) > 128) return null;
  // proc wchan need not end in a newline; accept at most its one final LF.
  const value = raw.endsWith("\n") ? raw.slice(0, -1) : raw;
  return SYMBOLS.has(value) ? value : null;
}
