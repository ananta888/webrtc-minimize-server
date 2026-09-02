import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const TARGET_DEFINITIONS = Object.freeze([
  Object.freeze({ id: "linux-amd64", platform: "linux", label: "Linux · Intel/AMD 64-Bit", artifact: "media-edge-agent-linux-amd64", installer: "ananta-media-agent-linux-amd64.sh" }),
  Object.freeze({ id: "linux-arm64", platform: "linux", label: "Linux · ARM64", artifact: "media-edge-agent-linux-arm64", installer: "ananta-media-agent-linux-arm64.sh" }),
  Object.freeze({ id: "macos-amd64", platform: "macos", label: "macOS · Intel", artifact: "media-edge-agent-macos-amd64", installer: "ananta-media-agent-macos-amd64.sh" }),
  Object.freeze({ id: "macos-arm64", platform: "macos", label: "macOS · Apple Silicon", artifact: "media-edge-agent-macos-arm64", installer: "ananta-media-agent-macos-arm64.sh" }),
  Object.freeze({ id: "windows-amd64", platform: "windows", label: "Windows · Intel/AMD 64-Bit", artifact: "media-edge-agent-windows-amd64.exe", installer: "ananta-media-agent-windows-amd64.ps1" }),
]);

export class MediaAgentInstallerError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.name = "MediaAgentInstallerError";
    this.code = code;
    this.status = status;
  }
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

function publicEndpoints(publicOrigin) {
  const origin = new URL(publicOrigin);
  if (origin.protocol !== "https:") throw new MediaAgentInstallerError("secure_agent_origin_required", 503);
  const websocket = new URL(publicOrigin);
  websocket.protocol = "wss:";
  websocket.pathname = "/media-agent";
  return Object.freeze({ origin: origin.origin, signalUrl: websocket.href });
}

function posixInstaller({ enrollment, target, sha256, artifactUrl, signalUrl }) {
  const serviceId = `ananta-media-agent-${enrollment.agentId}`;
  const launcherName = `run-${enrollment.agentId}`;
  const identityName = `identity-${enrollment.agentId}.pem`;
  const lines = [
    "#!/bin/sh",
    "set -eu",
    "umask 077",
    "",
    `expected_sha256=${shellQuote(sha256)}`,
    `artifact_url=${shellQuote(artifactUrl)}`,
    `agent_id=${shellQuote(enrollment.agentId)}`,
    `enrollment_token=${shellQuote(enrollment.token)}`,
    'agent_root="$HOME/.local/share/ananta-media-agent"',
    'binary="$agent_root/media-edge-agent"',
    `identity="$agent_root/${identityName}"`,
    `launcher="$agent_root/${launcherName}"`,
    'temporary="$agent_root/media-edge-agent.download"',
    'mkdir -p "$agent_root"',
    'chmod 700 "$agent_root"',
    'printf "%s\\n" "Ananta lädt den Media-Agent über HTTPS und prüft SHA-256 …"',
    'curl --fail --location --proto "=https" --tlsv1.2 --output "$temporary" "$artifact_url"',
    'if command -v sha256sum >/dev/null 2>&1; then actual_sha256=$(sha256sum "$temporary" | awk \'{print $1}\'); else actual_sha256=$(shasum -a 256 "$temporary" | awk \'{print $1}\'); fi',
    'if [ "$actual_sha256" != "$expected_sha256" ]; then rm -f "$temporary"; printf "%s\\n" "SHA-256-Prüfung fehlgeschlagen." >&2; exit 1; fi',
    'chmod 700 "$temporary"',
    'mv -f "$temporary" "$binary"',
    `MEDIA_AGENT_SIGNAL_URL=${shellQuote(signalUrl)} MEDIA_AGENT_ID="$agent_id" MEDIA_AGENT_IDENTITY_FILE="$identity" MEDIA_AGENT_ENROLLMENT_TOKEN="$enrollment_token" "$binary" enroll`,
    "unset enrollment_token",
    'cat > "$launcher" <<\'ANANTA_AGENT_LAUNCHER\'',
    "#!/bin/sh",
    `export MEDIA_AGENT_SIGNAL_URL=${shellQuote(signalUrl)}`,
    `export MEDIA_AGENT_ID=${shellQuote(enrollment.agentId)}`,
    `export MEDIA_AGENT_IDENTITY_FILE="$HOME/.local/share/ananta-media-agent/${identityName}"`,
    "export MEDIA_AGENT_UDP_PORT=0",
    "export MEDIA_AGENT_CAPACITY=70",
    "export MEDIA_AGENT_BATTERY=unknown",
    "export MEDIA_AGENT_NETWORK=unknown",
    'exec "$HOME/.local/share/ananta-media-agent/media-edge-agent"',
    "ANANTA_AGENT_LAUNCHER",
    'chmod 700 "$launcher"',
  ];
  if (target.platform === "linux") {
    lines.push(
      'unit_dir="$HOME/.config/systemd/user"',
      'mkdir -p "$unit_dir"',
      `cat > "$unit_dir/${serviceId}.service" <<'ANANTA_AGENT_UNIT'`,
      "[Unit]",
      "Description=Ananta voluntary media edge agent",
      "After=network-online.target",
      "Wants=network-online.target",
      "",
      "[Service]",
      "Type=simple",
      `ExecStart=%h/.local/share/ananta-media-agent/${launcherName}`,
      "Restart=on-failure",
      "RestartSec=5",
      "NoNewPrivileges=true",
      "PrivateTmp=true",
      "",
      "[Install]",
      "WantedBy=default.target",
      "ANANTA_AGENT_UNIT",
      'if command -v loginctl >/dev/null 2>&1; then',
      '  if loginctl enable-linger "$(id -un)"; then',
      '    printf "%s\\n" "Dauerhafter Benutzerbetrieb wurde aktiviert."',
      '  else',
      '    printf "%s\\n" "Dauerhafter Benutzerbetrieb konnte nicht aktiviert werden; der Agent benötigt eine aktive Anmeldung." >&2',
      '  fi',
      'fi',
      `if command -v systemctl >/dev/null 2>&1 && systemctl --user daemon-reload && systemctl --user enable --now ${shellQuote(`${serviceId}.service`)}; then`,
      '  printf "%s\\n" "Media-Agent ist als systemd-Benutzerdienst installiert und gestartet."',
      "else",
      '  nohup "$launcher" >"$agent_root/agent.log" 2>&1 &',
      '  printf "%s\\n" "Kein systemd-Benutzerdienst verfügbar; der Agent läuft jetzt, automatischer Start ist nicht bestätigt."',
      "fi",
    );
  } else {
    const launchLabel = `de.ananta.media-agent.${enrollment.agentId}`;
    lines.push(
      'launch_dir="$HOME/Library/LaunchAgents"',
      'mkdir -p "$launch_dir"',
      `plist="$launch_dir/${launchLabel}.plist"`,
      "cat > \"$plist\" <<'ANANTA_AGENT_PLIST'",
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
      '<plist version="1.0"><dict>',
      '<key>Label</key><string>' + launchLabel + "</string>",
      '<key>ProgramArguments</key><array><string>/bin/sh</string><string>-c</string><string>exec &quot;$HOME/.local/share/ananta-media-agent/' + launcherName + '&quot;</string></array>',
      "<key>RunAtLoad</key><true/>",
      "<key>KeepAlive</key><true/>",
      "<key>ThrottleInterval</key><integer>5</integer>",
      "</dict></plist>",
      "ANANTA_AGENT_PLIST",
      `launchctl bootout "gui/$(id -u)/${launchLabel}" >/dev/null 2>&1 || true`,
      'launchctl bootstrap "gui/$(id -u)" "$plist"',
      `launchctl kickstart -k "gui/$(id -u)/${launchLabel}"`,
      'printf "%s\\n" "Media-Agent ist installiert und startet automatisch mit deiner Anmeldung."',
    );
  }
  lines.push(
    'printf "%s\\n" "Die Raumfreigabe bleibt in der Web-App standardmäßig AUS und muss je Raum bewusst aktiviert werden."',
    'case "$0" in /*|*/*) rm -f -- "$0" || true ;; esac',
    'printf "%s\\n" "Das kurzlebige Enrollment-Material wurde nach erfolgreicher Installation entfernt."',
    "",
  );
  return lines.join("\n");
}

function powershellQuote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function windowsInstaller({ enrollment, sha256, artifactUrl, signalUrl }) {
  const identityName = `identity-${enrollment.agentId}.pem`;
  const launcherName = `run-${enrollment.agentId}.ps1`;
  return [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    "$agentRoot = Join-Path $env:LOCALAPPDATA 'Ananta\\MediaAgent'",
    "$binary = Join-Path $agentRoot 'media-edge-agent.exe'",
    `$identity = Join-Path $agentRoot ${powershellQuote(identityName)}`,
    `$launcher = Join-Path $agentRoot ${powershellQuote(launcherName)}`,
    "$temporary = Join-Path $agentRoot 'media-edge-agent.download.exe'",
    "New-Item -ItemType Directory -Force -Path $agentRoot | Out-Null",
    `Invoke-WebRequest -UseBasicParsing -Uri ${powershellQuote(artifactUrl)} -OutFile $temporary`,
    `$expected = ${powershellQuote(sha256)}`,
    "$actual = (Get-FileHash -Algorithm SHA256 -Path $temporary).Hash.ToLowerInvariant()",
    "if ($actual -ne $expected) { Remove-Item -Force $temporary; throw 'SHA-256-Prüfung fehlgeschlagen.' }",
    "Move-Item -Force $temporary $binary",
    `$env:MEDIA_AGENT_SIGNAL_URL = ${powershellQuote(signalUrl)}`,
    `$env:MEDIA_AGENT_ID = ${powershellQuote(enrollment.agentId)}`,
    "$env:MEDIA_AGENT_IDENTITY_FILE = $identity",
    `$env:MEDIA_AGENT_ENROLLMENT_TOKEN = ${powershellQuote(enrollment.token)}`,
    "try { & $binary enroll; if ($LASTEXITCODE -ne 0) { throw 'Registrierung fehlgeschlagen.' } } finally { Remove-Item Env:MEDIA_AGENT_ENROLLMENT_TOKEN -ErrorAction SilentlyContinue }",
    "$launcherContent = @'",
    `$env:MEDIA_AGENT_SIGNAL_URL = ${powershellQuote(signalUrl)}`,
    `$env:MEDIA_AGENT_ID = ${powershellQuote(enrollment.agentId)}`,
    `$env:MEDIA_AGENT_IDENTITY_FILE = Join-Path $env:LOCALAPPDATA ${powershellQuote(`Ananta\\MediaAgent\\${identityName}`)}`,
    "$env:MEDIA_AGENT_UDP_PORT = '0'",
    "$env:MEDIA_AGENT_CAPACITY = '70'",
    "& (Join-Path $env:LOCALAPPDATA 'Ananta\\MediaAgent\\media-edge-agent.exe')",
    "'@",
    "Set-Content -Encoding UTF8 -Path $launcher -Value $launcherContent",
    "$startup = Join-Path $env:APPDATA 'Microsoft\\Windows\\Start Menu\\Programs\\Startup'",
    `$startupFile = Join-Path $startup ${powershellQuote(`ananta-media-agent-${enrollment.agentId}.cmd`)}`,
    `$startupContent = ${powershellQuote(`@start "" /min powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "%LOCALAPPDATA%\\Ananta\\MediaAgent\\${launcherName}"`)}`,
    "Set-Content -Encoding ASCII -Path $startupFile -Value $startupContent",
    "Start-Process powershell.exe -WindowStyle Hidden -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',$launcher)",
    "Write-Host 'Media-Agent ist installiert und startet automatisch mit deiner Anmeldung.'",
    "Write-Host 'Die Raumfreigabe bleibt in der Web-App standardmäßig AUS und muss je Raum bewusst aktiviert werden.'",
    "if ($PSCommandPath) { Remove-Item -Force $PSCommandPath -ErrorAction SilentlyContinue }",
    "Write-Host 'Das kurzlebige Enrollment-Material wurde nach erfolgreicher Installation entfernt.'",
    "",
  ].join("\r\n");
}

export class MediaAgentInstallerService {
  #directory;
  #artifacts = new Map();

  constructor({ directory }) {
    this.#directory = path.resolve(directory);
    for (const definition of TARGET_DEFINITIONS) {
      const filename = path.join(this.#directory, definition.artifact);
      try {
        const stat = fs.statSync(filename);
        if (!stat.isFile() || stat.size < 1) continue;
        const sha256 = crypto.createHash("sha256").update(fs.readFileSync(filename)).digest("hex");
        this.#artifacts.set(definition.id, Object.freeze({ ...definition, filename, size: stat.size, sha256 }));
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
  }

  availableTargets() {
    return TARGET_DEFINITIONS.filter((target) => this.#artifacts.has(target.id)).map((target) => Object.freeze({
      id: target.id,
      platform: target.platform,
      label: target.label,
    }));
  }

  target(id) {
    const target = this.#artifacts.get(String(id || ""));
    if (!target) throw new MediaAgentInstallerError("media_agent_artifact_unavailable", 409);
    return target;
  }

  installer({ enrollment, targetId, publicOrigin }) {
    const target = this.target(targetId);
    if (target.platform !== enrollment.platform) {
      throw new MediaAgentInstallerError("invalid_agent_platform");
    }
    const { origin, signalUrl } = publicEndpoints(publicOrigin);
    const artifactUrl = `${origin}/downloads/media-edge-agent/${target.id}`;
    const parameters = { enrollment, target, sha256: target.sha256, artifactUrl, signalUrl };
    return Object.freeze({
      target: target.id,
      filename: target.installer,
      artifactSha256: target.sha256,
      artifactBytes: target.size,
      content: target.platform === "windows" ? windowsInstaller(parameters) : posixInstaller(parameters),
    });
  }

  artifact(id) {
    return this.target(id);
  }
}
