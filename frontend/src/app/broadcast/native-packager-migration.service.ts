import { Injectable, signal } from "@angular/core";
import { OidcAuthService } from "../auth/oidc-auth.service";
import { NativePackagerRelease, NativePackagerReleaseArtifact, parseNativePackagerRelease } from "./native-packager-release";

@Injectable()
export class NativePackagerMigrationService {
  readonly busy = signal(false);
  readonly error = signal("");
  readonly filename = signal("");
  private readonly downloadedContext = signal("");
  constructor(private readonly auth: OidcAuthService) {}

  filenameFor(id: string, release: NativePackagerRelease, artifact: NativePackagerReleaseArtifact): string {
    return this.downloadedContext() === `${id}:${release.revision}:${artifact.target}:${artifact.sha256}` ? this.filename() : "";
  }

  async download(id: string, release: NativePackagerRelease, artifact: NativePackagerReleaseArtifact): Promise<void> {
    if (this.busy()) return;
    this.error.set(""); this.filename.set(""); this.busy.set(true);
    const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 15_000);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      parseNativePackagerRelease(release);
      if (!/^pkr_[A-Za-z0-9_-]{16,64}$/.test(id) || !release.artifacts.includes(artifact) || !/^linux-(amd64|arm64)$/.test(artifact.target)) throw new Error("invalid");
      const response = await fetch(`/api/native-packagers/${id}/migration`, { method: "POST", signal: controller.signal, redirect: "error", cache: "no-store",
        headers: { "content-type": "application/json", ...this.auth.authorizationHeader() },
        body: JSON.stringify({ target: artifact.target, revision: release.revision, sha256: artifact.sha256 }) });
      if (!response.ok || response.headers.get("content-type")?.split(";", 1)[0] !== "application/json" || !response.body) throw new Error("unavailable");
      reader = response.body.getReader(); const buffer = new Uint8Array(262_144); let length = 0;
      for (;;) {
        const next = await reader.read(); if (next.done) break;
        if (length + next.value.length > buffer.length) throw new Error("oversize");
        buffer.set(next.value, length); length += next.value.length;
      }
      const body: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length)));
      const fields = ["version", "type", "packagerId", "target", "revision", "artifactSha256", "filename", "script"];
      if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== fields.length || !fields.every(key => Object.hasOwn(body, key))) throw new Error("invalid");
      const data = body as Record<string, unknown>, filename = `migrate-${id}.sh`;
      if (data["version"] !== 1 || data["type"] !== "native-packager-migration" || data["packagerId"] !== id || data["target"] !== artifact.target
        || data["revision"] !== release.revision || data["artifactSha256"] !== artifact.sha256 || data["filename"] !== filename
        || typeof data["script"] !== "string" || !data["script"].startsWith("#!/bin/sh\n") || data["script"].length < 100 || data["script"].length > 131_072) throw new Error("invalid");
      const url = URL.createObjectURL(new Blob([data["script"]], { type: "text/plain;charset=utf-8" }));
      const anchor = document.createElement("a"); anchor.href = url; anchor.download = filename; anchor.hidden = true; document.body.append(anchor);
      try { anchor.click(); } finally { anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 0); }
      this.filename.set(filename);
      this.downloadedContext.set(`${id}:${release.revision}:${artifact.target}:${artifact.sha256}`);
    } catch {
      this.error.set("Migration nicht verfügbar. Eigener Linux-Agent, unverändertes Release und beendete Broadcast-Zuweisungen sind erforderlich.");
    } finally {
      clearTimeout(timeout); controller.abort(); try { await reader?.cancel(); } catch { /* Aborted stream. */ }
      reader?.releaseLock(); this.busy.set(false);
    }
  }
}
