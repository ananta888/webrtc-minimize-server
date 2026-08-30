export type OverlayTrafficClass = "control" | "rekey" | "event" | "bulk";

export interface OverlayPacket {
  readonly version: 1;
  readonly type: "overlay-packet";
  readonly packetId: string;
  readonly originPeerId: string;
  readonly destinationPeerId: string;
  readonly membershipEpoch: number;
  readonly routeEpoch: number;
  readonly trafficClass: OverlayTrafficClass;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly path: readonly string[];
  readonly hop: number;
  readonly chunkIndex: number;
  readonly chunkCount: number;
  readonly nonce: string;
  readonly ciphertext: string;
  readonly digest: string;
}

export type OverlayReceiveResult =
  | Readonly<{ action: "forward"; nextPeerId: string; packet: OverlayPacket }>
  | Readonly<{ action: "delivered"; packetId: string; originPeerId: string; trafficClass: OverlayTrafficClass; data: Uint8Array }>
  | Readonly<{ action: "pending"; packetId: string; originPeerId: string; missing: readonly number[] }>
  | Readonly<{ action: "drop"; reason: string }>;

const PEER_ID = /^[a-f0-9]{16}$/;
const TOKEN = /^[A-Za-z0-9_-]{16,64}$/;
const TRAFFIC_CLASSES = new Set<OverlayTrafficClass>(["control", "rekey", "event", "bulk"]);
const MAX_CHUNK_BYTES = 12 * 1024;
const MAX_CHUNKS = 96;
const MAX_PATH = 5;
const MAX_TTL_MS = 60_000;

function encode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function decode(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("invalid_base64url");
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function bufferSource(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function aad(packet: Omit<OverlayPacket, "hop" | "nonce" | "ciphertext" | "digest">): Uint8Array {
  return new TextEncoder().encode(JSON.stringify([
    packet.version,
    packet.type,
    packet.packetId,
    packet.originPeerId,
    packet.destinationPeerId,
    packet.membershipEpoch,
    packet.routeEpoch,
    packet.trafficClass,
    packet.createdAt,
    packet.expiresAt,
    packet.path,
    packet.chunkIndex,
    packet.chunkCount,
  ]));
}

async function sha256(bytes: Uint8Array): Promise<string> {
  return encode(new Uint8Array(await crypto.subtle.digest("SHA-256", bufferSource(bytes))));
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key)) && allowed.every((key) => key in value);
}

export function parseOverlayPacket(raw: unknown, now = Date.now()): OverlayPacket | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (!exactKeys(value, [
    "version", "type", "packetId", "originPeerId", "destinationPeerId", "membershipEpoch",
    "routeEpoch", "trafficClass", "createdAt", "expiresAt", "path", "hop", "chunkIndex",
    "chunkCount", "nonce", "ciphertext", "digest",
  ])) return null;
  if (value["version"] !== 1 || value["type"] !== "overlay-packet") return null;
  const packetId = String(value["packetId"]);
  const originPeerId = String(value["originPeerId"]);
  const destinationPeerId = String(value["destinationPeerId"]);
  const membershipEpoch = Number(value["membershipEpoch"]);
  const routeEpoch = Number(value["routeEpoch"]);
  const trafficClass = String(value["trafficClass"]) as OverlayTrafficClass;
  const createdAt = Number(value["createdAt"]);
  const expiresAt = Number(value["expiresAt"]);
  const hop = Number(value["hop"]);
  const chunkIndex = Number(value["chunkIndex"]);
  const chunkCount = Number(value["chunkCount"]);
  const path = value["path"];
  const nonce = String(value["nonce"]);
  const ciphertext = String(value["ciphertext"]);
  const digest = String(value["digest"]);
  if (!TOKEN.test(packetId) || !PEER_ID.test(originPeerId) || !PEER_ID.test(destinationPeerId)
    || !Number.isSafeInteger(membershipEpoch) || membershipEpoch < 1
    || !Number.isSafeInteger(routeEpoch) || routeEpoch < 1 || !TRAFFIC_CLASSES.has(trafficClass)
    || !Number.isSafeInteger(createdAt) || !Number.isSafeInteger(expiresAt)
    || createdAt > now + 5_000 || expiresAt <= now || expiresAt - createdAt > MAX_TTL_MS
    || !Array.isArray(path) || path.length < 2 || path.length > MAX_PATH
    || path.some((peerId) => typeof peerId !== "string" || !PEER_ID.test(peerId))
    || new Set(path).size !== path.length || path[0] !== originPeerId || path.at(-1) !== destinationPeerId
    || !Number.isSafeInteger(hop) || hop < 1 || hop >= path.length
    || !Number.isSafeInteger(chunkIndex) || chunkIndex < 0
    || !Number.isSafeInteger(chunkCount) || chunkCount < 1 || chunkCount > MAX_CHUNKS || chunkIndex >= chunkCount
    || !TOKEN.test(nonce) || !TOKEN.test(digest) || ciphertext.length > 24_000) return null;
  return {
    version: 1, type: "overlay-packet", packetId, originPeerId, destinationPeerId,
    membershipEpoch, routeEpoch, trafficClass, createdAt, expiresAt, path: [...path] as string[],
    hop, chunkIndex, chunkCount, nonce, ciphertext, digest,
  };
}

export class OpaqueDataOverlay {
  #ownPeerId = "";
  #keyPair: CryptoKeyPair | null = null;
  #peerKeys = new Map<string, CryptoKey>();
  #derivedKeys = new Map<string, CryptoKey>();
  #seen = new Map<string, number>();
  #assemblies = new Map<string, { expiresAt: number; parts: Map<number, Uint8Array>; count: number; bytes: number; originPeerId: string; trafficClass: OverlayTrafficClass }>();
  #outbound = new Map<string, { expiresAt: number; packets: readonly OverlayPacket[] }>();

  async initialize(ownPeerId: string): Promise<JsonWebKey> {
    if (!PEER_ID.test(ownPeerId)) throw new Error("invalid_own_peer");
    this.destroy();
    this.#ownPeerId = ownPeerId;
    this.#keyPair = await crypto.subtle.generateKey(
      { name: "ECDH", namedCurve: "P-256" },
      false,
      ["deriveKey"],
    );
    const exported = await crypto.subtle.exportKey("jwk", this.#keyPair.publicKey);
    return { kty: "EC", crv: "P-256", x: exported.x, y: exported.y, ext: true };
  }

  async setPeerKey(peerId: string, publicKey: JsonWebKey): Promise<void> {
    if (!PEER_ID.test(peerId) || peerId === this.#ownPeerId || publicKey.kty !== "EC"
      || publicKey.crv !== "P-256" || typeof publicKey.x !== "string" || typeof publicKey.y !== "string") {
      throw new Error("invalid_overlay_key");
    }
    const key = await crypto.subtle.importKey(
      "jwk",
      { kty: "EC", crv: "P-256", x: publicKey.x, y: publicKey.y, ext: true },
      { name: "ECDH", namedCurve: "P-256" },
      false,
      [],
    );
    this.#peerKeys.set(peerId, key);
    this.#derivedKeys.delete(peerId);
  }

  removePeer(peerId: string): void {
    this.#peerKeys.delete(peerId);
    this.#derivedKeys.delete(peerId);
  }

  hasPeerKey(peerId: string): boolean {
    return this.#peerKeys.has(peerId);
  }

  async encrypt(
    destinationPeerId: string,
    data: Uint8Array,
    context: Readonly<{ membershipEpoch: number; routeEpoch: number; trafficClass: OverlayTrafficClass; path: readonly string[] }>,
    now = Date.now(),
  ): Promise<readonly OverlayPacket[]> {
    if (data.byteLength > MAX_CHUNK_BYTES * MAX_CHUNKS) throw new Error("overlay_payload_too_large");
    if (context.path[0] !== this.#ownPeerId || context.path.at(-1) !== destinationPeerId) {
      throw new Error("invalid_overlay_path");
    }
    const key = await this.#derive(destinationPeerId);
    const packetId = encode(crypto.getRandomValues(new Uint8Array(18)));
    const chunkCount = Math.max(1, Math.ceil(data.byteLength / MAX_CHUNK_BYTES));
    const createdAt = now;
    const expiresAt = now + MAX_TTL_MS;
    const packets: OverlayPacket[] = [];
    for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex += 1) {
      const cleartext = data.slice(chunkIndex * MAX_CHUNK_BYTES, (chunkIndex + 1) * MAX_CHUNK_BYTES);
      const immutable = {
        version: 1 as const,
        type: "overlay-packet" as const,
        packetId,
        originPeerId: this.#ownPeerId,
        destinationPeerId,
        membershipEpoch: context.membershipEpoch,
        routeEpoch: context.routeEpoch,
        trafficClass: context.trafficClass,
        createdAt,
        expiresAt,
        path: [...context.path],
        chunkIndex,
        chunkCount,
      };
      const nonceBytes = crypto.getRandomValues(new Uint8Array(12));
      const ciphertextBytes = new Uint8Array(await crypto.subtle.encrypt(
        { name: "AES-GCM", iv: bufferSource(nonceBytes), additionalData: bufferSource(aad(immutable)) },
        key,
        cleartext,
      ));
      packets.push({
        ...immutable,
        hop: 1,
        nonce: encode(nonceBytes),
        ciphertext: encode(ciphertextBytes),
        digest: await sha256(ciphertextBytes),
      });
    }
    this.#outbound.set(packetId, { expiresAt, packets });
    return packets;
  }

  resume(packetId: string, missing: readonly number[]): readonly OverlayPacket[] {
    const outbound = this.#outbound.get(packetId);
    if (!outbound || missing.length > MAX_CHUNKS
      || missing.some((index) => !Number.isSafeInteger(index) || index < 0 || index >= outbound.packets.length)) return [];
    if (missing.length === 0) {
      this.#outbound.delete(packetId);
      return [];
    }
    return [...new Set(missing)].map((index) => outbound.packets[index]);
  }

  async receive(
    raw: unknown,
    previousPeerId: string,
    context: Readonly<{ membershipEpoch: number; routeEpoch: number; memberPeerIds: ReadonlySet<string> }>,
    now = Date.now(),
  ): Promise<OverlayReceiveResult> {
    this.#prune(now);
    const packet = parseOverlayPacket(raw, now);
    if (!packet) return { action: "drop", reason: "invalid_packet" };
    if (packet.membershipEpoch !== context.membershipEpoch || packet.routeEpoch !== context.routeEpoch) {
      return { action: "drop", reason: "stale_epoch" };
    }
    if (packet.path.some((peerId) => !context.memberPeerIds.has(peerId))
      || packet.path[packet.hop] !== this.#ownPeerId || packet.path[packet.hop - 1] !== previousPeerId) {
      return { action: "drop", reason: "unauthorized_path" };
    }
    const replayKey = `${packet.packetId}:${packet.chunkIndex}`;
    if (this.#seen.has(replayKey)) return { action: "drop", reason: "replay" };
    const ciphertext = decode(packet.ciphertext);
    if (await sha256(ciphertext) !== packet.digest) return { action: "drop", reason: "digest_mismatch" };
    this.#seen.set(replayKey, packet.expiresAt);
    if (this.#ownPeerId !== packet.destinationPeerId) {
      const nextPeerId = packet.path[packet.hop + 1];
      if (!nextPeerId) return { action: "drop", reason: "hop_limit" };
      return { action: "forward", nextPeerId, packet: { ...packet, hop: packet.hop + 1 } };
    }
    try {
      const key = await this.#derive(packet.originPeerId);
      const { hop: _hop, nonce: _nonce, ciphertext: _ciphertext, digest: _digest, ...immutable } = packet;
      const cleartext = new Uint8Array(await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: bufferSource(decode(packet.nonce)), additionalData: bufferSource(aad(immutable)) },
        key,
        bufferSource(ciphertext),
      ));
      const assemblyKey = `${packet.originPeerId}:${packet.packetId}`;
      let assembly = this.#assemblies.get(assemblyKey);
      if (!assembly) {
        assembly = { expiresAt: packet.expiresAt, parts: new Map(), count: packet.chunkCount, bytes: 0, originPeerId: packet.originPeerId, trafficClass: packet.trafficClass };
        this.#assemblies.set(assemblyKey, assembly);
      }
      if (assembly.count !== packet.chunkCount || assembly.bytes + cleartext.byteLength > MAX_CHUNK_BYTES * MAX_CHUNKS) {
        this.#assemblies.delete(assemblyKey);
        return { action: "drop", reason: "assembly_limit" };
      }
      assembly.parts.set(packet.chunkIndex, cleartext);
      assembly.bytes += cleartext.byteLength;
      if (assembly.parts.size !== assembly.count) {
        const missing = Array.from({ length: assembly.count }, (_, index) => index)
          .filter((index) => !assembly.parts.has(index));
        return { action: "pending", packetId: packet.packetId, originPeerId: packet.originPeerId, missing };
      }
      const data = new Uint8Array(assembly.bytes);
      let offset = 0;
      for (let index = 0; index < assembly.count; index += 1) {
        const part = assembly.parts.get(index);
        if (!part) return { action: "drop", reason: "assembly_incomplete" };
        data.set(part, offset);
        offset += part.byteLength;
      }
      this.#assemblies.delete(assemblyKey);
      return { action: "delivered", packetId: packet.packetId, originPeerId: assembly.originPeerId, trafficClass: assembly.trafficClass, data };
    } catch {
      return { action: "drop", reason: "decrypt_failed" };
    }
  }

  destroy(): void {
    this.#ownPeerId = "";
    this.#keyPair = null;
    this.#peerKeys.clear();
    this.#derivedKeys.clear();
    this.#seen.clear();
    this.#assemblies.clear();
    this.#outbound.clear();
  }

  async #derive(peerId: string): Promise<CryptoKey> {
    const cached = this.#derivedKeys.get(peerId);
    if (cached) return cached;
    const peerKey = this.#peerKeys.get(peerId);
    if (!this.#keyPair || !peerKey) throw new Error("overlay_key_unavailable");
    const key = await crypto.subtle.deriveKey(
      { name: "ECDH", public: peerKey },
      this.#keyPair.privateKey,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
    this.#derivedKeys.set(peerId, key);
    return key;
  }

  #prune(now: number): void {
    for (const [key, expiresAt] of this.#seen) if (expiresAt <= now) this.#seen.delete(key);
    for (const [key, assembly] of this.#assemblies) if (assembly.expiresAt <= now) this.#assemblies.delete(key);
    for (const [key, outbound] of this.#outbound) if (outbound.expiresAt <= now) this.#outbound.delete(key);
  }
}

const QUEUE_LIMITS = Object.freeze({
  control: { messages: 32, bytes: 128 * 1024 },
  rekey: { messages: 32, bytes: 128 * 1024 },
  event: { messages: 64, bytes: 512 * 1024 },
  bulk: { messages: 96, bytes: 1024 * 1024 },
});

export class BoundedOverlayQueue {
  #items = new Map<OverlayTrafficClass, string[]>([...TRAFFIC_CLASSES].map((kind) => [kind, []]));

  enqueue(trafficClass: OverlayTrafficClass, payload: string): boolean {
    const queue = this.#items.get(trafficClass)!;
    const limit = QUEUE_LIMITS[trafficClass];
    const bytes = queue.reduce((sum, item) => sum + item.length, 0);
    if (queue.length >= limit.messages || bytes + payload.length > limit.bytes) {
      if (trafficClass === "bulk") return false;
      queue.shift();
    }
    queue.push(payload);
    return true;
  }

  flush(send: (payload: string) => boolean): void {
    for (const trafficClass of ["control", "rekey", "event", "bulk"] as const) {
      const queue = this.#items.get(trafficClass)!;
      while (queue.length > 0 && send(queue[0])) queue.shift();
    }
  }

  clear(): void {
    for (const queue of this.#items.values()) queue.length = 0;
  }
}
