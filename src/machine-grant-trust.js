import { createPublicKey } from "node:crypto";
import { jwtVerify } from "jose";
import { MACHINE_GRANT_AUDIENCES, machineTrustScopeAllows, parseMachineTrustProfile } from "./machine-trust-profile.js";
import { parseMachineTrustJson } from "./machine-trust-json.js";

/** Fixed, bounded operator keys. No network key discovery or runtime reload. */
export class MachineGrantTrust {
  #profile;
  #keys = new Map();
  #legacyKey;
  #issuer;

  constructor({ publicKey = "", issuer = "", trustProfile = null } = {}) {
    if (trustProfile !== null) {
      if (publicKey || issuer) throw new Error("machine_trust_configuration_ambiguous");
      this.#profile = parseMachineTrustProfile(trustProfile);
      this.#issuer = this.#profile.issuer;
      for (const key of this.#profile.keys) this.#keys.set(key.kid, { ...key,
        publicKey: createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: key.x }, format: "jwk" }) });
      return;
    }
    if (Boolean(publicKey) !== Boolean(issuer)) throw new Error("machine_trust_incomplete");
    if (issuer && !/^https:\/\/[^\s|]+$/.test(issuer)) throw new Error("machine_issuer_invalid");
    this.#issuer = issuer;
    if (publicKey) {
      try {
        if (typeof publicKey !== "string" || publicKey.length > 4096
          || !publicKey.trim().startsWith("-----BEGIN PUBLIC KEY-----")) throw new Error();
        this.#legacyKey = createPublicKey(publicKey);
        if (this.#legacyKey.asymmetricKeyType !== "ed25519") throw new Error();
      } catch { throw new Error("machine_trust_public_key_invalid"); }
    }
  }

  get issuer() { return this.#issuer; }
  get enabled() { return Boolean(this.#legacyKey || this.#profile?.scopes.some(row => row.capabilities.length)); }

  async verify(token, now, requiredClaims) {
    let selected;
    if (!Number.isSafeInteger(now) || now < 0 || now > 8640000000000000) throw new Error("invalid_clock");
    if (this.#profile) {
      const parts = token.split(".");
      if (parts.length !== 3) throw new Error("invalid_token");
      const decode = part => {
        if (!/^[A-Za-z0-9_-]+$/.test(part)) throw new Error("invalid_token");
        const bytes = Buffer.from(part, "base64url");
        if (bytes.toString("base64url") !== part) throw new Error("invalid_token");
        return parseMachineTrustJson(new TextDecoder("utf-8", { fatal: true }).decode(bytes), 4096);
      };
      const header = decode(parts[0]);
      decode(parts[1]); // Reject duplicate claims before jose's JSON parser.
      if (!header || typeof header !== "object" || Array.isArray(header)
        || Object.keys(header).length !== 3 || !["alg", "typ", "kid"].every(key => Object.hasOwn(header, key))
        || header.alg !== "EdDSA" || typeof header.kid !== "string") throw new Error("invalid_header");
      selected = this.#keys.get(header.kid);
      if (!selected || now / 1000 < selected.notBefore || now / 1000 >= selected.notAfter) throw new Error("invalid_key");
    }
    const result = await jwtVerify(token, selected?.publicKey || this.#legacyKey, {
      algorithms: ["EdDSA"], issuer: this.#issuer, audience: this.#profile?.audiences || MACHINE_GRANT_AUDIENCES,
      currentDate: new Date(now), maxTokenAge: 60, requiredClaims,
    });
    if (selected && (result.payload.iat < selected.notBefore || result.payload.exp > selected.notAfter)) {
      throw new Error("invalid_key_window");
    }
    return result;
  }

  allows(payload, capabilities) {
    return !this.#profile || machineTrustScopeAllows(this.#profile, payload, capabilities);
  }
}
