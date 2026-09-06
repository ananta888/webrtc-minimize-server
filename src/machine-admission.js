import { importSPKI, jwtVerify } from "jose";
import { AuthenticationError, bearerToken } from "./oidc-verifier.js";

const FIELDS = new Set(["iss", "aud", "sub", "iat", "exp", "jti", "roomId", "taskId", "tenantId", "projectId"]);
const ID = /^[A-Za-z0-9_.:-]{1,160}$/;

/** Dedicated operator-pinned machine issuer; never accepts Human/Hub service JWTs. */
export class MachineAdmission {
  #key;
  #issuer;
  #used = new Map();

  constructor({ publicKey = "", issuer = "" } = {}) {
    if (Boolean(publicKey) !== Boolean(issuer)) throw new Error("machine_trust_incomplete");
    if (issuer && !/^https:\/\/[^\s|]+$/.test(issuer)) throw new Error("machine_issuer_invalid");
    this.#key = publicKey ? importSPKI(publicKey, "EdDSA") : null;
    this.#issuer = issuer;
  }

  async verify(header, { roomId, mode, displayName }, now = Date.now()) {
    if (!this.#key) throw new AuthenticationError("machine_admission_disabled");
    const token = bearerToken(header);
    if (!token || token.length > 4096) throw new AuthenticationError("machine_grant_invalid");
    try {
      const { payload, protectedHeader } = await jwtVerify(token, await this.#key, {
        algorithms: ["EdDSA"], issuer: this.#issuer, audience: "ananta-meet-machine-v1",
        currentDate: new Date(now), maxTokenAge: 60,
        requiredClaims: [...FIELDS],
      });
      if (protectedHeader.typ !== "ananta-meet-machine+jwt" || Object.keys(payload).some(key => !FIELDS.has(key))
          || payload.aud !== "ananta-meet-machine-v1" || payload.iss !== this.#issuer
          || !Number.isSafeInteger(payload.iat) || !Number.isSafeInteger(payload.exp)
          || payload.iat > now / 1000 || payload.exp - payload.iat > 600
          || payload.exp <= payload.iat || mode !== "room" || displayName !== "Ananta (KI)"
          || payload.roomId !== roomId || !/^room-[a-f0-9]{18}$/.test(roomId)
          || ![payload.sub, payload.jti, payload.taskId, payload.tenantId, payload.projectId].every(v => typeof v === "string" && ID.test(v))) {
        throw new Error("invalid");
      }
      for (const [id, expiry] of this.#used) if (expiry <= now) this.#used.delete(id);
      if (this.#used.has(payload.jti) || this.#used.size >= 10_000) throw new Error("replayed_or_full");
      this.#used.set(payload.jti, payload.exp * 1000);
      return Object.freeze({ issuer: this.#issuer, subject: `machine:${payload.sub}`, displayName: "Ananta (KI)",
        machineExpiresAt: payload.exp * 1000, controllerOrigin: new URL(this.#issuer).origin });
    } catch {
      throw new AuthenticationError("machine_grant_invalid");
    }
  }
}

/** A machine participant is not a relay, recorder or room-control principal. */
export function machineMessageAllowed(message) {
  if (["leave", "signal", "overlay-key"].includes(message.type)) return true;
  if (message.type === "media-state") return ["camera", "microphone"].includes(message.source);
  if (message.type === "relay-consent") return message.enabled === false;
  if (message.type === "relay-capability") return message.selfCapacity === 0;
  return false;
}
