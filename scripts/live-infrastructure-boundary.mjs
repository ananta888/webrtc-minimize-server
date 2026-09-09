/** No device delegation: an accidental capture request fails without a prompt. */
export function forbidLiveCapture() {
  window.__captureCalls = [];
  const devices = navigator.mediaDevices;
  if (!devices) return;
  for (const method of ["getUserMedia", "getDisplayMedia"]) {
    Object.defineProperty(devices, method, { configurable: false, writable: false, value: async () => {
      if (window.__captureCalls.length < 8) window.__captureCalls.push(method);
      throw new Error("live_human_capture_forbidden");
    } });
  }
}

/** HTTP requests stay within the explicitly configured application/issuer. */
export function liveRequestAllowed(value, origins) {
  try { return origins.has(new URL(value).origin); }
  catch { return false; }
}

/** Discovery/keys are bounded documents, never redirects or raw diagnostics. */
export async function liveJson(url, { fetchImpl = fetch, timeoutMs = 5000 } = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 5000) throw new Error("live_document_unavailable");
  const controller = new AbortController();
  let timer;
  try {
    return await Promise.race([
      (async () => {
        const response = await fetchImpl(url, { redirect: "error", signal: controller.signal });
        if (response.status !== 200 || !response.body) throw new Error();
        const chunks = []; let bytes = 0;
        for await (const chunk of response.body) {
          bytes += chunk.length;
          if (bytes > 65536) throw new Error();
          chunks.push(chunk);
        }
        return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
      })(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error()), timeoutMs); }),
    ]);
  } catch { throw new Error("live_document_unavailable"); }
  finally { clearTimeout(timer); controller.abort(); }
}
