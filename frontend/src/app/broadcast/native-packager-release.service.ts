import { Injectable, signal } from "@angular/core";
import { NativePackagerRelease, parseNativePackagerRelease } from "./native-packager-release";

@Injectable({ providedIn: "root" })
export class NativePackagerReleaseService {
  readonly release = signal<NativePackagerRelease | null>(null);
  readonly busy = signal(false);
  readonly error = signal("");

  async load(): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true); this.error.set(""); this.release.set(null);
    const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 15_000);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const response = await fetch("/downloads/native-packager/release.json", { signal: controller.signal, redirect: "error", cache: "no-store", credentials: "omit" });
      if (!response.ok || response.headers.get("content-type")?.split(";", 1)[0] !== "application/json" || !response.body) throw new Error("unavailable");
      reader = response.body.getReader();
      const bytes = new Uint8Array(32_768);
      let length = 0;
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        if (length + next.value.length > bytes.length) throw new Error("oversize");
        bytes.set(next.value, length); length += next.value.length;
      }
      this.release.set(parseNativePackagerRelease(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length)))));
    } catch {
      this.release.set(null); this.error.set("Release-Nachweis nicht verfügbar oder ungültig. Kein Update empfohlen.");
    } finally {
      clearTimeout(timeout); controller.abort();
      try { await reader?.cancel(); } catch { /* Stream may already be closed. */ }
      reader?.releaseLock(); this.busy.set(false);
    }
  }
}
