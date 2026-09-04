import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

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
  const root = "$HOME/.local/share/ananta-native-packager";
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
    'mkdir -p "$packager_root"', 'chmod 700 "$packager_root"',
    'command -v ffmpeg >/dev/null 2>&1 || { printf "%s\\n" "FFmpeg 6 oder neuer wird benötigt." >&2; exit 1; }',
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
  ];
  if (target.platform === "linux") {
    lines.push(
      `systemctl --user disable --now ${quote(`${service}.service`)} >/dev/null 2>&1 || true`,
      `rm -f "$HOME/.config/systemd/user/${service}.service"`, "systemctl --user daemon-reload >/dev/null 2>&1 || true",
    );
  } else {
    const launchLabel = `de.ananta.native-packager.${enrollment.packagerId}`;
    lines.push(`launchctl bootout "gui/$(id -u)/${launchLabel}" >/dev/null 2>&1 || true`, `rm -f "$HOME/Library/LaunchAgents/${launchLabel}.plist"`);
  }
  lines.push('rm -rf -- "$HOME/.local/share/ananta-native-packager"', "ANANTA_PACKAGER_UNINSTALL", `chmod 700 "$packager_root/${uninstall}"`);
  if (target.platform === "linux") {
    lines.push(
      'unit_dir="$HOME/.config/systemd/user"', 'mkdir -p "$unit_dir"',
      `cat > "$unit_dir/${service}.service" <<'ANANTA_PACKAGER_UNIT'`, "[Unit]", "Description=Ananta voluntary trusted broadcast packager", "After=network-online.target", "Wants=network-online.target", "", "[Service]", "Type=simple",
      `ExecStart=%h/.local/share/ananta-native-packager/${launcher}`, "Restart=on-failure", "RestartSec=5", "NoNewPrivileges=true", "PrivateTmp=true", "ProtectSystem=strict", "ProtectHome=read-only", "ReadWritePaths=%h/.local/share/ananta-native-packager", "MemoryMax=2G", "TasksMax=128", "", "[Install]", "WantedBy=default.target", "ANANTA_PACKAGER_UNIT",
      `systemctl --user daemon-reload && systemctl --user enable --now ${quote(`${service}.service`)}`,
    );
  } else {
    const launchLabel = `de.ananta.native-packager.${enrollment.packagerId}`;
    lines.push(
      'launch_dir="$HOME/Library/LaunchAgents"', 'mkdir -p "$launch_dir"', `plist="$launch_dir/${launchLabel}.plist"`,
      `cat > "$plist" <<'ANANTA_PACKAGER_PLIST'`, '<?xml version="1.0" encoding="UTF-8"?>', '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">', '<plist version="1.0"><dict>', `<key>Label</key><string>${launchLabel}</string>`, `<key>ProgramArguments</key><array><string>/bin/sh</string><string>${root}/${launcher}</string></array>`, '<key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>5</integer>', '</dict></plist>', "ANANTA_PACKAGER_PLIST", 'launchctl bootstrap "gui/$(id -u)" "$plist"',
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
    "$root = Join-Path $env:LOCALAPPDATA 'Ananta\\NativePackager'", "New-Item -ItemType Directory -Force -Path $root | Out-Null",
    "$binary = Join-Path $root 'native-broadcast-packager.exe'", "$temporary = Join-Path $root 'native-broadcast-packager.download.exe'",
    `Invoke-WebRequest -UseBasicParsing -Uri ${psQuote(artifactUrl)} -OutFile $temporary`, `$expected = ${psQuote(sha256)}`,
    "$actual = (Get-FileHash -Algorithm SHA256 -Path $temporary).Hash.ToLowerInvariant()", "if ($actual -ne $expected) { Remove-Item -Force $temporary; throw 'SHA-256-Prüfung fehlgeschlagen.' }", "Move-Item -Force $temporary $binary",
    `$env:NATIVE_PACKAGER_CONTROL_URL = ${psQuote(controlUrl)}`, `$env:NATIVE_PACKAGER_ID = ${psQuote(id)}`,
    `$env:NATIVE_PACKAGER_IDENTITY_FILE = Join-Path $root ${psQuote(`identity-${id}.pem`)}`, `$env:NATIVE_PACKAGER_ENROLLMENT_TOKEN = ${psQuote(enrollment.enrollmentToken)}`,
    "try { & $binary enroll; if ($LASTEXITCODE -ne 0) { throw 'Registrierung fehlgeschlagen.' } } finally { Remove-Item Env:NATIVE_PACKAGER_ENROLLMENT_TOKEN -ErrorAction SilentlyContinue }",
    `$launcher = Join-Path $root ${psQuote(`run-${id}.ps1`)}`, "$launcherContent = @'",
    `$env:NATIVE_PACKAGER_CONTROL_URL = ${psQuote(controlUrl)}`, `$env:NATIVE_PACKAGER_ID = ${psQuote(id)}`,
    `$env:NATIVE_PACKAGER_IDENTITY_FILE = Join-Path $env:LOCALAPPDATA ${psQuote(`Ananta\\NativePackager\\identity-${id}.pem`)}`,
    `$env:NATIVE_PACKAGER_STUN_URLS = ${psQuote(stunUrls.join(","))}`,
    "& (Join-Path $env:LOCALAPPDATA 'Ananta\\NativePackager\\native-broadcast-packager.exe')", "'@", "Set-Content -Encoding UTF8 -Path $launcher -Value $launcherContent",
    "$startup = Join-Path $env:APPDATA 'Microsoft\\Windows\\Start Menu\\Programs\\Startup'", `$startupFile = Join-Path $startup ${psQuote(`ananta-native-packager-${id}.cmd`)}`,
    `$startupContent = ${psQuote(`@start "" /min powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "%LOCALAPPDATA%\\Ananta\\NativePackager\\run-${id}.ps1"`)}`,
    "Set-Content -Encoding ASCII -Path $startupFile -Value $startupContent", "Start-Process powershell.exe -WindowStyle Hidden -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',$launcher)",
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
