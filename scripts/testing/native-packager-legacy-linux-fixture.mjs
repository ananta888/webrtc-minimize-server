// Historical installer layout from d8ebb4c^; never run its destructive uninstaller.
export function legacyLinuxRuntime(id) {
  if (!/^pkr_[A-Za-z0-9_-]{16,64}$/.test(id)) throw new Error("Invalid synthetic identity");
  const base = "$HOME/.local/share/ananta-native-packager";
  return {
    launcher: `#!/bin/sh\nset -eu\nexport NATIVE_PACKAGER_CONTROL_URL='wss://webrtc.example/native-packager'\nexport NATIVE_PACKAGER_ID='${id}'\nexport NATIVE_PACKAGER_IDENTITY_FILE="${base}/identity-${id}.pem"\nexport NATIVE_PACKAGER_STUN_URLS=''\nexec "${base}/native-broadcast-packager"\n`,
    uninstall: `#!/bin/sh\nset -eu\nsystemctl --user disable --now 'ananta-native-packager-${id}.service' >/dev/null 2>&1 || true\nrm -f "$HOME/.config/systemd/user/ananta-native-packager-${id}.service"\nsystemctl --user daemon-reload >/dev/null 2>&1 || true\nrm -rf -- "${base}"\n`,
    unit: `[Unit]\nDescription=Ananta voluntary trusted broadcast packager\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=simple\nExecStart=%h/.local/share/ananta-native-packager/run-${id}\nRestart=on-failure\nRestartSec=5\nNoNewPrivileges=true\nPrivateTmp=true\nProtectSystem=strict\nProtectHome=read-only\nReadWritePaths=%h/.local/share/ananta-native-packager\nMemoryMax=2G\nTasksMax=128\n\n[Install]\nWantedBy=default.target\n`,
  };
}
