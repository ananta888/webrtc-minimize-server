import { createPublicKey } from "node:crypto";
import { isAbsolute, join } from "node:path";
import { machineCapabilityEnvironment } from "./machine-capabilities.js";
import { parseMachineTrustProfile } from "./machine-trust-profile.js";

const fields = ["mode", "issuer", "publicKeyFile", "profileFile", "inlineKey", "inlineProfile", "capabilities", "authMode", "mediaE2eeMode"];

/** Structural deployment validation only, not Hub/room authorization or delivery. */
export function machineDeploymentConfig(value, readFile) {
  try {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const directory = Object.hasOwn(value, "profileDirectory") ? value.profileDirectory : "";
      if (typeof directory !== "string" || directory.includes("\0") || directory.length > 4096
        || (value.mode === "profile-reload"
          ? !isAbsolute(directory) || value.profileFile !== join(directory, "machine-trust.json")
          : directory !== "")) throw new Error();
      const { profileDirectory: _directory, ...rest } = value;
      value = rest;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).length !== fields.length || fields.some(key => typeof value[key] !== "string")
      || Object.keys(value).some(key => !fields.includes(key))
      || !["disabled", "legacy", "profile", "profile-reload"].includes(value.mode) || value.inlineKey || value.inlineProfile) throw new Error();
    const capabilities = machineCapabilityEnvironment(value.capabilities);
    const read = file => {
      if (!isAbsolute(file) || file.includes("\0") || file.length > 4096) throw new Error();
      return readFile(file);
    };
    if (value.mode === "disabled") {
      if (value.issuer || value.publicKeyFile || value.profileFile) throw new Error();
    } else {
      if (value.authMode !== "required" || value.mediaE2eeMode !== "required") throw new Error();
      if (["profile", "profile-reload"].includes(value.mode)) {
        if (value.issuer || value.publicKeyFile || !value.profileFile) throw new Error();
        parseMachineTrustProfile(read(value.profileFile));
      } else {
        if (value.profileFile || !value.publicKeyFile) throw new Error();
        const issuer = new URL(value.issuer);
        if (issuer.protocol !== "https:" || issuer.origin !== value.issuer || issuer.username || issuer.password) throw new Error();
        const pem = read(value.publicKeyFile);
        if (!/^-----BEGIN PUBLIC KEY-----\r?\n[A-Za-z0-9+/=\r\n]+-----END PUBLIC KEY-----\s*$/.test(pem)
          || createPublicKey(pem).asymmetricKeyType !== "ed25519") throw new Error();
      }
    }
    return Object.freeze({ mode: value.mode, admission: value.mode !== "disabled" && capabilities.length ? "enabled" : "disabled" });
  } catch { throw new Error("machine_deployment_config_invalid"); }
}
