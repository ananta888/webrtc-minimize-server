export interface NativePackagerReleaseArtifact {
  readonly target: string;
  readonly filename: string;
  readonly sha256: string;
  readonly bytes: number;
}
export interface NativePackagerRelease {
  readonly version: 1;
  readonly type: "native-packager-release";
  readonly repository: string;
  readonly workflow: string;
  readonly revision: string;
  readonly builtAt: string;
  readonly agentVersion: string;
  readonly goVersion: string;
  readonly artifacts: readonly NativePackagerReleaseArtifact[];
}
const REPOSITORY = "ananta888/webrtc-minimize-server";
const WORKFLOW = `${REPOSITORY}/.github/workflows/ci.yml`;
const TARGETS = ["linux-amd64", "linux-arm64", "macos-amd64", "macos-arm64", "windows-amd64"];
function closed(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
export function parseNativePackagerRelease(value: unknown): NativePackagerRelease {
  if (!closed(value, ["version", "type", "repository", "workflow", "revision", "builtAt", "agentVersion", "goVersion", "artifacts"])
    || value["version"] !== 1 || value["type"] !== "native-packager-release"
    || value["repository"] !== REPOSITORY || value["workflow"] !== WORKFLOW
    || typeof value["revision"] !== "string" || !/^[a-f0-9]{40}$/.test(value["revision"])
    || typeof value["builtAt"] !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value["builtAt"])
    || !Number.isFinite(Date.parse(value["builtAt"])) || new Date(value["builtAt"]).toISOString() !== value["builtAt"].replace("Z", ".000Z")
    || typeof value["agentVersion"] !== "string" || !/^\d+\.\d+\.\d+$/.test(value["agentVersion"]) || value["agentVersion"].length > 32
    || typeof value["goVersion"] !== "string" || !/^go\d+\.\d+\.\d+$/.test(value["goVersion"]) || value["goVersion"].length > 32
    || !Array.isArray(value["artifacts"]) || value["artifacts"].length !== TARGETS.length) throw new Error("native_packager_release_invalid");
  value["artifacts"].forEach((artifact: unknown, index: number) => {
    const target = TARGETS[index];
    if (!closed(artifact, ["target", "filename", "sha256", "bytes"]) || artifact["target"] !== target
      || artifact["filename"] !== `native-broadcast-packager-${target}${target === "windows-amd64" ? ".exe" : ""}`
      || typeof artifact["sha256"] !== "string" || !/^[a-f0-9]{64}$/.test(artifact["sha256"])
      || !Number.isSafeInteger(artifact["bytes"]) || Number(artifact["bytes"]) < 1 || Number(artifact["bytes"]) > 134_217_728) throw new Error("native_packager_release_invalid");
    Object.freeze(artifact);
  });
  Object.freeze(value["artifacts"]);
  return Object.freeze(value) as unknown as NativePackagerRelease;
}
export function nativePackagerVerificationCommand(release: NativePackagerRelease, artifact?: NativePackagerReleaseArtifact): string {
  parseNativePackagerRelease(release);
  if (artifact && !release.artifacts.includes(artifact)) throw new Error("native_packager_release_invalid");
  return `gh attestation verify ./${artifact?.filename || "native-packager-release.v1.json"} --repo ${REPOSITORY} --signer-workflow ${WORKFLOW} --source-digest ${release.revision} --source-ref refs/heads/main --deny-self-hosted-runners`;
}
export function nativePackagerDigestCommand(artifact: NativePackagerReleaseArtifact, platform = "linux"): string {
  if (!TARGETS.includes(artifact.target) || !/^[a-f0-9]{64}$/.test(artifact.sha256)
    || artifact.filename !== `native-broadcast-packager-${artifact.target}${artifact.target === "windows-amd64" ? ".exe" : ""}`
    || !["windows", "linux", "macos"].includes(platform) || !artifact.target.startsWith(`${platform}-`)) {
    throw new Error("native_packager_update_invalid");
  }
  return platform === "windows"
    ? `(Get-FileHash -Algorithm SHA256 .\\${artifact.filename}).Hash.ToLower() -eq '${artifact.sha256}'`
    : `printf '%s  %s\\n' '${artifact.sha256}' '${artifact.filename}' | sha256sum -c -`;
}
export function nativePackagerUpdateCommand(id: string, platform: string, artifact: NativePackagerReleaseArtifact): string {
  if (!/^pkr_[A-Za-z0-9_-]{16,64}$/.test(id) || !["windows", "linux", "macos"].includes(platform)
    || !TARGETS.includes(artifact.target) || !artifact.target.startsWith(`${platform}-`) || !/^[a-f0-9]{64}$/.test(artifact.sha256)) throw new Error("native_packager_update_invalid");
  return platform === "windows"
    ? `& "$env:LOCALAPPDATA\\Ananta\\NativePackager\\${id}\\update-${id}.ps1" update ${artifact.sha256}`
    : `"$HOME/.local/share/ananta-native-packager/${id}/update-${id}" update ${artifact.sha256}`;
}
