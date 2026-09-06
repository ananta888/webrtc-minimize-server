import { importSPKI, jwtVerify } from "jose";
import { AuthenticationError, bearerToken } from "./oidc-verifier.js";

const FIELDS = new Set(["iss", "aud", "sub", "iat", "exp", "jti", "roomId", "taskId", "tenantId", "projectId"]);
const ID = /^[A-Za-z0-9_.:-]{1,160}$/;
export const MACHINE_CAPABILITIES = Object.freeze(["audio.receive", "chat.read", "chat.send",
  "screen.publish", "screen-audio.publish", "avatar.publish", "speech.publish"]);
const V2_FIELDS = new Set([...FIELDS, "runtimeId", "sessionId", "capabilities"]);

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
        algorithms: ["EdDSA"], issuer: this.#issuer, audience: ["ananta-meet-machine-v1", "ananta-meet-machine-v2"],
        currentDate: new Date(now), maxTokenAge: 60,
        requiredClaims: [...FIELDS],
      });
      const v2 = payload.aud === "ananta-meet-machine-v2";
      const allowedFields = v2 ? V2_FIELDS : FIELDS;
      if (protectedHeader.typ !== (v2 ? "ananta-meet-machine-v2+jwt" : "ananta-meet-machine+jwt")
          || Object.keys(payload).length !== allowedFields.size || Object.keys(payload).some(key => !allowedFields.has(key))
          || !["ananta-meet-machine-v1", "ananta-meet-machine-v2"].includes(payload.aud) || payload.iss !== this.#issuer
          || !Number.isSafeInteger(payload.iat) || !Number.isSafeInteger(payload.exp)
          || payload.iat > now / 1000 || payload.exp - payload.iat > 600
          || payload.exp <= payload.iat || mode !== "room" || displayName !== "Ananta (KI)"
          || payload.roomId !== roomId || !/^room-[a-f0-9]{18}$/.test(roomId)
          || ![payload.sub, payload.jti, payload.taskId, payload.tenantId, payload.projectId].every(v => typeof v === "string" && ID.test(v))) {
        throw new Error("invalid");
      }
      if (v2 && (![payload.runtimeId, payload.sessionId].every(v => typeof v === "string" && ID.test(v))
        || !Array.isArray(payload.capabilities) || !payload.capabilities.length
        || payload.capabilities.length > MACHINE_CAPABILITIES.length
        || new Set(payload.capabilities).size !== payload.capabilities.length
        || payload.capabilities.some(value => !MACHINE_CAPABILITIES.includes(value)))) throw new Error("invalid");
      const capabilities = v2 ? [...payload.capabilities].sort() : ["avatar.publish", "chat.send", "speech.publish"];
      for (const [id, expiry] of this.#used) if (expiry <= now) this.#used.delete(id);
      if (this.#used.has(payload.jti) || this.#used.size >= 10_000) throw new Error("replayed_or_full");
      this.#used.set(payload.jti, payload.exp * 1000);
      return Object.freeze({ issuer: this.#issuer, subject: `machine:${payload.sub}`, displayName: "Ananta (KI)",
        machineBinding: Object.freeze({ issuer: this.#issuer, subject: `machine:${payload.sub}`,
          roomId: payload.roomId, taskId: payload.taskId, tenantId: payload.tenantId, projectId: payload.projectId,
          protocolVersion: v2 ? "v2" : "v1", runtimeId: v2 ? payload.runtimeId : "",
          hubSessionId: v2 ? payload.sessionId : "", capabilitySet: capabilities.join(",") }),
        machineCapabilities: Object.freeze(capabilities),
        machineExpiresAt: payload.exp * 1000, controllerOrigin: new URL(this.#issuer).origin });
    } catch {
      throw new AuthenticationError("machine_grant_invalid");
    }
  }
}

/** A machine participant is not a relay, recorder or room-control principal. */
export function machineMessageAllowed(message, capabilities = null) {
  if (["leave", "signal", "overlay-key"].includes(message.type)) return true;
  // Route/source/subscription authorization remains in the normal server handlers.
  if (["media-agent-signal", "media-agent-peer-state"].includes(message.type)) return Boolean(capabilities?.some(
    value => value === "audio.receive" || value.endsWith(".publish")));
  if (["media-agent-subscription-intent", "media-agent-subscription-ack"].includes(message.type)) {
    return capabilities?.includes("audio.receive") === true;
  }
  if (message.type === "media-state") {
    if (!capabilities) return ["camera", "microphone"].includes(message.source);
    const permission = { camera: "avatar.publish", microphone: "speech.publish", screen: "screen.publish", "screen-audio": "screen-audio.publish" }[message.source];
    return Boolean(permission && (message.active === false || capabilities.includes(permission)));
  }
  if (message.type === "relay-consent") return message.enabled === false;
  if (message.type === "relay-capability") return message.selfCapacity === 0;
  return false;
}
