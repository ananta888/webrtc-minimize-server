import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { windowsPackagerPrivateAcl, windowsPackagerUninstaller } from "./native-packager-windows-lifecycle.js";
import { linuxPackagerUpdater } from "./native-packager-linux-updater.js";
import { posixPackagerUpdater } from "./native-packager-posix-updater.js";
import { windowsPackagerUpdater } from "./native-packager-windows-updater.js";

const TARGETS = Object.freeze([
  Object.freeze({ id: "linux-amd64", platform: "linux", label: "Linux · Intel/AMD 64-Bit", artifact: "native-broadcast-packager-linux-amd64", installer: "ananta-native-packager-linux-amd64.sh" }),
  Object.freeze({ id: "linux-arm64", platform: "linux", label: "Linux · ARM64", artifact: "native-broadcast-packager-linux-arm64", installer: "ananta-native-packager-linux-arm64.sh" }),
  Object.freeze({ id: "macos-amd64", platform: "macos", label: "macOS · Intel", artifact: "native-broadcast-packager-macos-amd64", installer: "ananta-native-packager-macos-amd64.sh" }),
  Object.freeze({ id: "macos-arm64", platform: "macos", label: "macOS · Apple Silicon", artifact: "native-broadcast-packager-macos-arm64", installer: "ananta-native-packager-macos-arm64.sh" }),
  Object.freeze({ id: "windows-amd64", platform: "windows", label: "Windows · Intel/AMD 64-Bit", artifact: "native-broadcast-packager-windows-amd64.exe", installer: "ananta-native-packager-windows-amd64.ps1" }),
]);

export class NativePackagerInstallerError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.name = "NativePackagerInstallerError";
    this.code = code;
    this.status = status;
  }
}

function quote(value) { return `'${String(value).replaceAll("'", `'"'"'`)}'`; }
function psQuote(value) { return `'${String(value).replaceAll("'", "''")}'`; }

function endpoints(publicOrigin) {
  const origin = new URL(publicOrigin);
  if (origin.protocol !== "https:" || origin.pathname !== "/") {
    throw new NativePackagerInstallerError("secure_native_packager_origin_required", 503);
  }
  const control = new URL(origin);
  control.protocol = "wss:";
  control.pathname = "/native-packager";
  return { origin: origin.origin, controlUrl: control.href };
}

function posix({ enrollment, target, sha256, artifactUrl, controlUrl, stunUrls }) {
  const base = "$HOME/.local/share/ananta-native-packager";
  const root = `${base}/${enrollment.packagerId}`;
  const service = `ananta-native-packager-${enrollment.packagerId}`;
  const launcher = `run-${enrollment.packagerId}`;
  const identity = `identity-${enrollment.packagerId}.pem`;
  const uninstall = `uninstall-${enrollment.packagerId}`;
  const lines = [
    "#!/bin/sh", "set -eu", "umask 077", "",
    `expected_sha256=${quote(sha256)}`,
    `artifact_url=${quote(artifactUrl)}`,
    `packager_id=${quote(enrollment.packagerId)}`,
    `enrollment_token=${quote(enrollment.enrollmentToken)}`,
    `packager_root="${root}"`,
    'binary="$packager_root/native-broadcast-packager"',
    `identity="$packager_root/${identity}"`,
    'temporary="$packager_root/native-broadcast-packager.download"',
    ...(target.platform === "linux" ? ['command -v flock >/dev/null 2>&1 || { printf "%s\\n" "flock wird fuer sichere Wartung benoetigt." >&2; exit 1; }'] : []),
    ...(target.platform === "macos" ? ['for utility in lockf perl shasum launchctl; do command -v "$utility" >/dev/null 2>&1 || { printf "%s\\n" "macOS-Wartungswerkzeug fehlt." >&2; exit 1; }; done'] : []),
    'command -v ffmpeg >/dev/null 2>&1 || { printf "%s\\n" "FFmpeg 6 oder neuer wird benötigt." >&2; exit 1; }',
    `packager_base="${base}"`,
    '[ ! -L "$packager_base" ] || { printf "%s\\n" "Agent-Basis darf kein Symlink sein." >&2; exit 1; }',
    'mkdir -p "$packager_base"',
    'mkdir "$packager_root" || { printf "%s\\n" "Installation existiert bereits; keine Identität wird überschrieben." >&2; exit 1; }',
    'chmod 700 "$packager_root"',
    ...(target.platform === "macos" ? ['(exec 9>"$packager_root/.maintenance.lock"; lockf -s -t 0 9) || { printf "%s\\n" "lockf ohne FD-Unterstuetzung; keine Registrierung." >&2; exit 1; }'] : []),
    'curl --fail --location --proto "=https" --tlsv1.2 --output "$temporary" "$artifact_url"',
    'if command -v sha256sum >/dev/null 2>&1; then actual_sha256=$(sha256sum "$temporary" | awk \'{print $1}\'); else actual_sha256=$(shasum -a 256 "$temporary" | awk \'{print $1}\'); fi',
    'if [ "$actual_sha256" != "$expected_sha256" ]; then rm -f "$temporary"; printf "%s\\n" "SHA-256-Prüfung fehlgeschlagen." >&2; exit 1; fi',
    'chmod 700 "$temporary"', 'mv -f "$temporary" "$binary"',
    `NATIVE_PACKAGER_CONTROL_URL=${quote(controlUrl)} NATIVE_PACKAGER_ID="$packager_id" NATIVE_PACKAGER_IDENTITY_FILE="$identity" NATIVE_PACKAGER_ENROLLMENT_TOKEN="$enrollment_token" "$binary" enroll`,
    "unset enrollment_token",
    `cat > "$packager_root/${launcher}" <<'ANANTA_PACKAGER_LAUNCHER'`, "#!/bin/sh", "set -eu",
    `export NATIVE_PACKAGER_CONTROL_URL=${quote(controlUrl)}`,
    `export NATIVE_PACKAGER_ID=${quote(enrollment.packagerId)}`,
    `export NATIVE_PACKAGER_IDENTITY_FILE="${root}/${identity}"`,
    `export NATIVE_PACKAGER_STUN_URLS=${quote(stunUrls.join(","))}`,
    `exec "${root}/native-broadcast-packager"`, "ANANTA_PACKAGER_LAUNCHER", `chmod 700 "$packager_root/${launcher}"`,
    `cat > "$packager_root/${uninstall}" <<'ANANTA_PACKAGER_UNINSTALL'`, "#!/bin/sh", "set -eu",
    `packager_root="${root}"`,
    `[ ! -L "${base}" ] && [ ! -L "$packager_root" ] || { printf "%s\\n" "Agent-Pfad darf kein Symlink sein." >&2; exit 1; }`,
    '[ ! -L "$packager_root/.maintenance.lock" ] || exit 1',
    '[ ! -e "$packager_root/.maintenance.lock" ] || [ -f "$packager_root/.maintenance.lock" ] || exit 1',
    'exec 9>"$packager_root/.maintenance.lock"',
    `${target.platform === "linux" ? "flock -n 9" : "lockf -s -t 0 9"} || { printf "%s\\n" "Maintenance aktiv; keine Entfernung." >&2; exit 1; }`,
    '[ ! -e "$packager_root/.update-active" ] && [ ! -L "$packager_root/.update-active" ] || { printf "%s\\n" "Update-Wiederherstellung erforderlich; keine Entfernung." >&2; exit 1; }',
  ];
  if (target.platform === "linux") {
    lines.push(
      `systemctl --user disable --now ${quote(`${service}.service`)}`,
      `rm -f "$HOME/.config/systemd/user/${service}.service"`, "systemctl --user daemon-reload >/dev/null 2>&1 || true",
    );
  } else {
    const launchLabel = `de.ananta.native-packager.${enrollment.packagerId}`;
    lines.push(`launchctl bootout "gui/$(id -u)/${launchLabel}"`, `rm -f "$HOME/Library/LaunchAgents/${launchLabel}.plist"`);
  }
  lines.push(
    'rm -rf -- "$packager_root"', "ANANTA_PACKAGER_UNINSTALL", `chmod 700 "$packager_root/${uninstall}"`,
    `cat > "$packager_root/update-${enrollment.packagerId}" <<'ANANTA_PACKAGER_UPDATER'`,
    target.platform === "linux" ? linuxPackagerUpdater({ enrollment, artifactUrl, controlUrl, stunUrls })
      : posixPackagerUpdater({ platform: "macos", enrollment, artifactUrl, controlUrl, stunUrls }),
    "ANANTA_PACKAGER_UPDATER", `chmod 700 "$packager_root/update-${enrollment.packagerId}"`,
  );
  if (target.platform === "linux") {
    lines.push(
      'unit_dir="$HOME/.config/systemd/user"', 'mkdir -p "$unit_dir"',
      `cat > "$unit_dir/${service}.service" <<'ANANTA_PACKAGER_UNIT'`, "[Unit]", "Description=Ananta voluntary trusted broadcast packager", "After=network-online.target", "Wants=network-online.target", "", "[Service]", "Type=simple",
      `ExecStart="%h/.local/share/ananta-native-packager/${enrollment.packagerId}/${launcher}"`, "Restart=on-failure", "RestartSec=5", "NoNewPrivileges=true", "PrivateTmp=true", "ProtectSystem=strict", "ProtectHome=read-only", `ReadWritePaths="%h/.local/share/ananta-native-packager/${enrollment.packagerId}"`, "MemoryMax=2G", "TasksMax=128", "", "[Install]", "WantedBy=default.target", "ANANTA_PACKAGER_UNIT",
      `systemctl --user daemon-reload && systemctl --user enable --now ${quote(`${service}.service`)}`,
    );
  } else {
    const launchLabel = `de.ananta.native-packager.${enrollment.packagerId}`;
    lines.push(
      'launch_dir="$HOME/Library/LaunchAgents"', 'mkdir -p "$launch_dir"', `plist="$launch_dir/${launchLabel}.plist"`,
      `cat > "$plist" <<'ANANTA_PACKAGER_PLIST'`, '<?xml version="1.0" encoding="UTF-8"?>', '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">', '<plist version="1.0"><dict>', `<key>Label</key><string>${launchLabel}</string>`, `<key>ProgramArguments</key><array><string>/bin/sh</string><string>-c</string><string>exec "${root}/${launcher}"</string></array>`, '<key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>5</integer>', '</dict></plist>', "ANANTA_PACKAGER_PLIST", 'launchctl bootstrap "gui/$(id -u)" "$plist"',
    );
  }
  lines.push(
    'printf "%s\\n" "Native-Packager installiert. Er öffnet keinen eingehenden Port."',
    'printf "%s\\n" "Er verarbeitet erst nach einer ausdrücklichen Raumfreigabe in der Web-App Medien."',
    'case "$0" in /*|*/*) rm -f -- "$0" || true ;; esac', "",
  );
  return lines.join("\n");
}

function windows({ enrollment, sha256, artifactUrl, controlUrl, stunUrls }) {
  const id = enrollment.packagerId;
  return [
    "$ErrorActionPreference = 'Stop'", "$ProgressPreference = 'SilentlyContinue'",
    "if (-not (Get-Command ffmpeg.exe -ErrorAction SilentlyContinue)) { throw 'FFmpeg 6 oder neuer wird benoetigt.' }",
    "$base = Join-Path $env:LOCALAPPDATA 'Ananta\\NativePackager'",
    "if ((Test-Path -LiteralPath (Split-Path -Parent $base)) -and ((Get-Item -LiteralPath (Split-Path -Parent $base)).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Agent-Basis darf kein Reparse Point sein.' }",
    "if ((Test-Path -LiteralPath $base) -and ((Get-Item -LiteralPath $base).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Agent-Basis darf kein Reparse Point sein.' }",
    "New-Item -ItemType Directory -Force -Path $base | Out-Null",
    `$root = Join-Path $base ${psQuote(id)}`,
    "if (Test-Path -LiteralPath $root) { throw 'Installation existiert bereits; keine Identität wird überschrieben.' }",
    "New-Item -ItemType Directory -Path $root | Out-Null",
    ...windowsPackagerPrivateAcl(),
    "$binary = Join-Path $root 'native-broadcast-packager.exe'", "$temporary = Join-Path $root 'native-broadcast-packager.download.exe'",
    `Invoke-WebRequest -UseBasicParsing -Uri ${psQuote(artifactUrl)} -OutFile $temporary`, `$expected = ${psQuote(sha256)}`,
    "$actual = (Get-FileHash -Algorithm SHA256 -Path $temporary).Hash.ToLowerInvariant()", "if ($actual -ne $expected) { Remove-Item -Force $temporary; throw 'SHA-256-Prüfung fehlgeschlagen.' }", "Move-Item -Force $temporary $binary",
    `$env:NATIVE_PACKAGER_CONTROL_URL = ${psQuote(controlUrl)}`, `$env:NATIVE_PACKAGER_ID = ${psQuote(id)}`,
    "$env:NATIVE_PACKAGER_OUTPUT_ROOT = Join-Path $root 'output'",
    `$env:NATIVE_PACKAGER_IDENTITY_FILE = Join-Path $root ${psQuote(`identity-${id}.pem`)}`, `$env:NATIVE_PACKAGER_ENROLLMENT_TOKEN = ${psQuote(enrollment.enrollmentToken)}`,
    "try { & $binary enroll; if ($LASTEXITCODE -ne 0) { throw 'Registrierung fehlgeschlagen.' } } finally { Remove-Item Env:NATIVE_PACKAGER_ENROLLMENT_TOKEN -ErrorAction SilentlyContinue }",
    `$launcher = Join-Path $root ${psQuote(`run-${id}.ps1`)}`, "$launcherContent = @'",
    "param([string]$MaintenanceTransaction)",
    "$ErrorActionPreference = 'Stop'",
    `$agentRoot = Join-Path $env:LOCALAPPDATA ${psQuote(`Ananta\\NativePackager\\${id}`)}`,
    "$runningLock = $null",
    "try { $runningLock = [IO.File]::Open((Join-Path $agentRoot '.running.lock'), [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None) } catch [IO.IOException] { exit 0 }",
    "try {",
    "if (Test-Path -LiteralPath (Join-Path $agentRoot '.uninstalling')) { exit 0 }",
    "$transactionFile = Join-Path $agentRoot '.update-active'",
    "if (Test-Path -LiteralPath $transactionFile) {",
    "  $entry = Get-Item -LiteralPath $transactionFile -Force",
    "  if ($entry.PSIsContainer -or ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $entry.Length -gt 48) { exit 1 }",
    "  if ($MaintenanceTransaction -cnotmatch '^\\.update-[0-9a-f]{32}$' -or [IO.File]::ReadAllText($transactionFile).TrimEnd(\"`r\",\"`n\") -cne $MaintenanceTransaction) { exit 0 }",
    "} elseif ($MaintenanceTransaction) { exit 0 }",
    `$env:NATIVE_PACKAGER_CONTROL_URL = ${psQuote(controlUrl)}`, `$env:NATIVE_PACKAGER_ID = ${psQuote(id)}`,
    `$env:NATIVE_PACKAGER_IDENTITY_FILE = Join-Path $env:LOCALAPPDATA ${psQuote(`Ananta\\NativePackager\\${id}\\identity-${id}.pem`)}`,
    `$env:NATIVE_PACKAGER_STUN_URLS = ${psQuote(stunUrls.join(","))}`,
    "$env:NATIVE_PACKAGER_OUTPUT_ROOT = Join-Path $agentRoot 'output'",
    `& (Join-Path $env:LOCALAPPDATA ${psQuote(`Ananta\\NativePackager\\${id}\\native-broadcast-packager.exe`)})`,
    "} finally { $runningLock.Dispose() }", "'@", "Set-Content -Encoding UTF8 -Path $launcher -Value $launcherContent",
    `$uninstaller = Join-Path $root ${psQuote(`uninstall-${id}.ps1`)}`, "$uninstallerContent = @'",
    windowsPackagerUninstaller(id), "'@", "Set-Content -Encoding UTF8 -Path $uninstaller -Value $uninstallerContent",
    `$updater = Join-Path $root ${psQuote(`update-${id}.ps1`)}`, "$updaterContent = @'",
    windowsPackagerUpdater({ enrollment, artifactUrl, controlUrl, stunUrls }), "'@", "Set-Content -Encoding UTF8 -Path $updater -Value $updaterContent",
    "$startup = Join-Path $env:APPDATA 'Microsoft\\Windows\\Start Menu\\Programs\\Startup'", `$startupFile = Join-Path $startup ${psQuote(`ananta-native-packager-${id}.cmd`)}`,
    "if (Test-Path -LiteralPath $startupFile) { throw 'Autostart existiert bereits; er wird nicht ueberschrieben.' }",
    `$startupContent = ${psQuote(`@start "" /min powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "%LOCALAPPDATA%\\Ananta\\NativePackager\\${id}\\run-${id}.ps1"`)}`,
    "Set-Content -Encoding ASCII -Path $startupFile -Value $startupContent", "Start-Process powershell.exe -WindowStyle Hidden -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File', ('\"' + $launcher + '\"'))",
    "Write-Host 'Native-Packager installiert. Kein eingehender Port ist erforderlich; Raumfreigaben bleiben aus.'", "if ($PSCommandPath) { Remove-Item -Force $PSCommandPath -ErrorAction SilentlyContinue }", "",
  ].join("\r\n");
}

export class NativePackagerInstallerService {
  #artifacts = new Map();
  constructor({ directory }) {
    const root = path.resolve(directory);
    for (const target of TARGETS) {
      const filename = path.join(root, target.artifact);
      try {
        const stat = fs.statSync(filename);
        if (!stat.isFile() || stat.size < 1) continue;
        this.#artifacts.set(target.id, Object.freeze({ ...target, filename, size: stat.size,
          sha256: crypto.createHash("sha256").update(fs.readFileSync(filename)).digest("hex") }));
      } catch (error) { if (error.code !== "ENOENT") throw error; }
    }
  }
  availableTargets() { return TARGETS.filter(({ id }) => this.#artifacts.has(id)).map(({ id, platform, label }) => Object.freeze({ id, platform, label })); }
  target(id) { const target = this.#artifacts.get(String(id || "")); if (!target) throw new NativePackagerInstallerError("native_packager_artifact_unavailable", 409); return target; }
  artifact(id) { return this.target(id); }
  installer({ enrollment, targetId, publicOrigin, stunUrls = [] }) {
    if (typeof enrollment.packagerId !== "string" || !/^pkr_[A-Za-z0-9_-]{16,64}$/.test(enrollment.packagerId)) {
      throw new NativePackagerInstallerError("invalid_native_packager_id");
    }
    const target = this.target(targetId); if (target.platform !== enrollment.platform) throw new NativePackagerInstallerError("invalid_native_packager_platform");
    const { origin, controlUrl } = endpoints(publicOrigin); const artifactUrl = `${origin}/downloads/native-packager/${target.id}`;
    if (!Array.isArray(stunUrls) || stunUrls.length > 8
      || stunUrls.some((value) => typeof value !== "string" || !/^stuns?:[^\s,]{1,500}$/.test(value))) {
      throw new NativePackagerInstallerError("invalid_native_packager_stun_configuration", 500);
    }
    const input = { enrollment, target, sha256: target.sha256, artifactUrl, controlUrl,
      stunUrls: Object.freeze([...new Set(stunUrls)]) };
    return Object.freeze({ target: target.id, filename: target.installer, artifactSha256: target.sha256,
      artifactBytes: target.size, content: target.platform === "windows" ? windows(input) : posix(input) });
  }
}
