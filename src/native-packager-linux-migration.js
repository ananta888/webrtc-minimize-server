import fs from "node:fs";

const body = fs.readFileSync(new URL("./native-packager-linux-migration.sh", import.meta.url), "utf8").replaceAll("\r\n", "\n");
const quote = value => `'${String(value).replaceAll("'", `'"'"'`)}'`;
function section(script, name) {
  const delimiter = `ANANTA_PACKAGER_${name}`;
  const parts = script.split(`<<'${delimiter}'\n`);
  if (parts.length !== 2) throw new Error("native_packager_runtime_template_invalid");
  const end = parts[1].split(`\n${delimiter}\n`);
  if (end.length !== 2) throw new Error("native_packager_runtime_template_invalid");
  return `${end[0]}\n`;
}

// Infrastructure bridge: extract only closed runtime sections from the existing
// installer renderer. No enrollment block is copied or executed by migration.
export function linuxPackagerMigration({ id, installer, artifactUrl, sha256, controlUrl, stunUrls }) {
  if (!/^pkr_[A-Za-z0-9_-]{16,64}$/.test(id) || !/^[a-f0-9]{64}$/.test(sha256)) throw new Error("native_packager_migration_invalid");
  const runtime = Object.fromEntries(["LAUNCHER", "UNINSTALL", "UPDATER", "UNIT"].map(name => [name, section(installer, name)]));
  const legacyLauncher = runtime.LAUNCHER.replaceAll(`/${id}/`, "/");
  const legacyUnit = runtime.UNIT.replaceAll(`/${id}/`, "/")
    .replace(/^ExecStart="([^"]+)"$/m, "ExecStart=$1")
    .replace(`ReadWritePaths="%h/.local/share/ananta-native-packager/${id}"`, "ReadWritePaths=%h/.local/share/ananta-native-packager");
  const legacyUninstall = ["#!/bin/sh", "set -eu",
    `systemctl --user disable --now 'ananta-native-packager-${id}.service' >/dev/null 2>&1 || true`,
    `rm -f "$HOME/.config/systemd/user/ananta-native-packager-${id}.service"`,
    "systemctl --user daemon-reload >/dev/null 2>&1 || true",
    'rm -rf -- "$HOME/.local/share/ananta-native-packager"', ""].join("\n");
  const guard = `#!/bin/sh\nprintf '%s\\n' 'This legacy entry was migrated. Use the ID-local user service or uninstaller for ${id}.' >&2\nexit 1\n`;
  const literals = { legacy_launcher: legacyLauncher, legacy_unit: legacyUnit, legacy_uninstall: legacyUninstall, guard,
    new_launcher: runtime.LAUNCHER, new_uninstall: runtime.UNINSTALL, new_updater: runtime.UPDATER, new_unit: runtime.UNIT };
  return ["#!/bin/sh", "set -eu", "umask 077", `packager_id=${quote(id)}`, `artifact_url=${quote(artifactUrl)}`, `artifact_sha256=${quote(sha256)}`,
    `export NATIVE_PACKAGER_CONTROL_URL=${quote(controlUrl)}`, `export NATIVE_PACKAGER_STUN_URLS=${quote(stunUrls.join(","))}`,
    "export NATIVE_PACKAGER_ID=$packager_id", "unset NATIVE_PACKAGER_ENROLLMENT_TOKEN",
    ...Object.entries(literals).map(([key, value]) => `${key}=${quote(value)}`), body].join("\n");
}
