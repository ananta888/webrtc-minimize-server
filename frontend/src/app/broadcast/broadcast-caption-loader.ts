const MAX_BYTES = 64 * 1024;
const unavailable = () => new Error("broadcast_caption_unavailable");

/** Optional captions only: null removes current cues, undefined preserves them. */
export async function loadBroadcastCaption(url: string, signal: AbortSignal): Promise<string | null | undefined> {
  signal.throwIfAborted();
  const target = new URL(url, location.origin);
  if (target.origin !== location.origin || target.username || target.password || target.search || target.hash
    || !/^\/broadcast\/play\/res_[A-Za-z0-9_-]{16,64}\/captions_live\.vtt$/.test(target.pathname)) throw unavailable();
  const controller = new AbortController();
  const abort = () => controller.abort(new DOMException("caption-aborted", "AbortError"));
  signal.addEventListener("abort", abort, { once: true });
  let rejectAbort: () => void = () => {};
  const cancelled = new Promise<never>((_, reject) => {
    rejectAbort = () => reject(controller.signal.reason);
    controller.signal.addEventListener("abort", rejectAbort, { once: true });
  });
  const timer = setTimeout(() => controller.abort(unavailable()), 5000);
  try {
    return await Promise.race([fetchCaption(target.href, controller.signal), cancelled]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
    controller.signal.removeEventListener("abort", rejectAbort);
    controller.abort();
  }
}

async function fetchCaption(url: string, signal: AbortSignal): Promise<string | null | undefined> {
  const response = await fetch(url, { method: "GET", credentials: "same-origin", cache: "no-store", redirect: "error", signal });
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const cancel = () => { void (reader ? reader.cancel() : response.body?.cancel())?.catch(() => undefined); };
  signal.addEventListener("abort", cancel, { once: true });
  let complete = false;
  try {
    signal.throwIfAborted();
    if ([401, 403, 404].includes(response.status)) return null;
    if (!response.ok) return undefined;
    const declared = response.headers.get("content-length");
    if (!response.body || response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "text/vtt"
      || (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_BYTES))) throw unavailable();
    reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let bytes = 0, body = "";
    for (;;) {
      const chunk = await reader.read();
      signal.throwIfAborted();
      if (chunk.done) { complete = true; break; }
      bytes += chunk.value.byteLength;
      if (bytes > MAX_BYTES) throw unavailable();
      body += decoder.decode(chunk.value, { stream: true });
    }
    body += decoder.decode();
    if (bytes < 8 || !body.startsWith("WEBVTT\n\n")) throw unavailable();
    return body;
  } finally {
    signal.removeEventListener("abort", cancel);
    if (!complete) cancel();
    reader?.releaseLock();
  }
}
