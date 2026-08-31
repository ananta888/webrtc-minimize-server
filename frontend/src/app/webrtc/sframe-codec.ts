export const SFRAME_CIPHER_SUITE = 0x0004;
export const SFRAME_BASE_KEY_BYTES = 16;
export const SFRAME_TAG_BYTES = 16;
export const SFRAME_REPLAY_WINDOW = 128n;

const MAX_UINT64 = (1n << 64n) - 1n;
const KEY_LABEL = new TextEncoder().encode("SFrame 1.0 Secret key ");
const SALT_LABEL = new TextEncoder().encode("SFrame 1.0 Secret salt ");

export class SFrameError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "SFrameError";
  }
}

export interface SFrameHeader {
  readonly kid: bigint;
  readonly counter: bigint;
  readonly bytes: Uint8Array;
  readonly length: number;
}

interface DerivedKey {
  readonly key: CryptoKey;
  readonly salt: Uint8Array;
}

function assertUint64(value: bigint, name: string): void {
  if (value < 0n || value > MAX_UINT64) throw new SFrameError(`${name}_out_of_range`);
}

function integerBytes(value: bigint, width: number): Uint8Array {
  const result = new Uint8Array(width);
  let remaining = value;
  for (let index = width - 1; index >= 0; index -= 1) {
    result[index] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  if (remaining !== 0n) throw new SFrameError("integer_overflow");
  return result;
}

function minimalIntegerBytes(value: bigint): Uint8Array {
  let width = 1;
  while (value >= (1n << BigInt(width * 8))) width += 1;
  return integerBytes(value, width);
}

function readInteger(bytes: Uint8Array): bigint {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return value;
}

function concat(...values: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(values.reduce((length, value) => length + value.length, 0));
  let offset = 0;
  for (const value of values) {
    result.set(value, offset);
    offset += value.length;
  }
  return result;
}

function bufferSource(value: Uint8Array): ArrayBuffer {
  return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
}

export function encodeSFrameHeader(kid: bigint, counter: bigint): Uint8Array {
  assertUint64(kid, "kid");
  assertUint64(counter, "counter");
  const extendedKid = kid > 7n;
  const extendedCounter = counter > 7n;
  const kidBytes = extendedKid ? minimalIntegerBytes(kid) : new Uint8Array();
  const counterBytes = extendedCounter ? minimalIntegerBytes(counter) : new Uint8Array();
  const config = (extendedKid ? 0x80 | ((kidBytes.length - 1) << 4) : Number(kid) << 4)
    | (extendedCounter ? 0x08 | (counterBytes.length - 1) : Number(counter));
  return concat(Uint8Array.of(config), kidBytes, counterBytes);
}

export function decodeSFrameHeader(value: Uint8Array): SFrameHeader {
  if (value.length < 1) throw new SFrameError("header_missing");
  const config = value[0];
  const extendedKid = (config & 0x80) !== 0;
  const extendedCounter = (config & 0x08) !== 0;
  const kidWidth = extendedKid ? ((config >> 4) & 0x07) + 1 : 0;
  const counterWidth = extendedCounter ? (config & 0x07) + 1 : 0;
  const length = 1 + kidWidth + counterWidth;
  if (value.length < length) throw new SFrameError("header_truncated");
  let offset = 1;
  const kid = extendedKid ? readInteger(value.subarray(offset, offset + kidWidth)) : BigInt((config >> 4) & 0x07);
  offset += kidWidth;
  const counter = extendedCounter
    ? readInteger(value.subarray(offset, offset + counterWidth))
    : BigInt(config & 0x07);
  if ((extendedKid && (kid <= 7n || (kidWidth > 1 && value[1] === 0)))
    || (extendedCounter && (counter <= 7n || (counterWidth > 1 && value[1 + kidWidth] === 0)))) {
    throw new SFrameError("header_non_canonical");
  }
  return { kid, counter, bytes: value.slice(0, length), length };
}

async function deriveKey(baseKey: Uint8Array, kid: bigint): Promise<DerivedKey> {
  if (baseKey.length !== SFRAME_BASE_KEY_BYTES) throw new SFrameError("base_key_length");
  assertUint64(kid, "kid");
  const material = await crypto.subtle.importKey("raw", Uint8Array.from(baseKey), "HKDF", false, ["deriveBits"]);
  const suffix = concat(integerBytes(kid, 8), integerBytes(BigInt(SFRAME_CIPHER_SUITE), 2));
  const derive = async (label: Uint8Array, length: number): Promise<Uint8Array> => new Uint8Array(
    await crypto.subtle.deriveBits({
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(),
      info: bufferSource(concat(label, suffix)),
    }, material, length * 8),
  );
  const keyBytes = await derive(KEY_LABEL, 16);
  const salt = await derive(SALT_LABEL, 12);
  const key = await crypto.subtle.importKey("raw", bufferSource(keyBytes), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
  keyBytes.fill(0);
  return { key, salt };
}

function nonceFor(salt: Uint8Array, counter: bigint): Uint8Array {
  const nonce = integerBytes(counter, salt.length);
  for (let index = 0; index < nonce.length; index += 1) nonce[index] ^= salt[index];
  return nonce;
}

async function encryptWithDerivedKey(
  derived: DerivedKey,
  kid: bigint,
  counter: bigint,
  plaintext: Uint8Array,
  metadata: Uint8Array,
): Promise<Uint8Array> {
  const header = encodeSFrameHeader(kid, counter);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({
    name: "AES-GCM",
    iv: bufferSource(nonceFor(derived.salt, counter)),
    additionalData: bufferSource(concat(header, metadata)),
    tagLength: 128,
  }, derived.key, Uint8Array.from(plaintext)));
  return concat(header, ciphertext);
}

async function decryptWithDerivedKey(
  derived: DerivedKey,
  header: SFrameHeader,
  ciphertext: Uint8Array,
  metadata: Uint8Array,
): Promise<Uint8Array> {
  if (ciphertext.length < header.length + SFRAME_TAG_BYTES) throw new SFrameError("ciphertext_truncated");
  try {
    return new Uint8Array(await crypto.subtle.decrypt({
      name: "AES-GCM",
      iv: bufferSource(nonceFor(derived.salt, header.counter)),
      additionalData: bufferSource(concat(header.bytes, metadata)),
      tagLength: 128,
    }, derived.key, ciphertext.slice(header.length)));
  } catch {
    throw new SFrameError("authentication_failed");
  }
}

export async function encryptSFrame(
  baseKey: Uint8Array,
  kid: bigint,
  counter: bigint,
  plaintext: Uint8Array,
  metadata = new Uint8Array(),
): Promise<Uint8Array> {
  const derived = await deriveKey(baseKey, kid);
  try {
    return await encryptWithDerivedKey(derived, kid, counter, plaintext, metadata);
  } finally {
    derived.salt.fill(0);
  }
}

export async function decryptSFrame(
  baseKey: Uint8Array,
  ciphertext: Uint8Array,
  metadata = new Uint8Array(),
): Promise<{ readonly plaintext: Uint8Array; readonly kid: bigint; readonly counter: bigint }> {
  const header = decodeSFrameHeader(ciphertext);
  const derived = await deriveKey(baseKey, header.kid);
  try {
    const plaintext = await decryptWithDerivedKey(derived, header, ciphertext, metadata);
    return { plaintext, kid: header.kid, counter: header.counter };
  } finally {
    derived.salt.fill(0);
  }
}

export class SFrameReplayWindow {
  private highest = -1n;
  private seen = 0n;

  canAccept(counter: bigint): boolean {
    assertUint64(counter, "counter");
    if (this.highest < 0n || counter > this.highest) return true;
    const distance = this.highest - counter;
    return distance < SFRAME_REPLAY_WINDOW && ((this.seen >> distance) & 1n) === 0n;
  }

  accept(counter: bigint): boolean {
    if (!this.canAccept(counter)) return false;
    if (this.highest < 0n) {
      this.highest = counter;
      this.seen = 1n;
      return true;
    }
    if (counter > this.highest) {
      const distance = counter - this.highest;
      this.seen = distance >= SFRAME_REPLAY_WINDOW
        ? 1n
        : ((this.seen << distance) | 1n) & ((1n << SFRAME_REPLAY_WINDOW) - 1n);
      this.highest = counter;
      return true;
    }
    this.seen |= 1n << (this.highest - counter);
    return true;
  }

  clear(): void {
    this.highest = -1n;
    this.seen = 0n;
  }
}

export class SFrameEncryptContext {
  private readonly key: Uint8Array;
  private readonly derived: Promise<DerivedKey>;
  private counter: bigint;
  private destroyed = false;

  constructor(readonly kid: bigint, baseKey: Uint8Array, initialCounter = 0n) {
    assertUint64(initialCounter, "counter");
    this.key = Uint8Array.from(baseKey);
    if (this.key.length !== SFRAME_BASE_KEY_BYTES) throw new SFrameError("base_key_length");
    this.derived = deriveKey(this.key, kid);
    this.counter = initialCounter;
  }

  async encrypt(plaintext: Uint8Array, metadata = new Uint8Array()): Promise<Uint8Array> {
    if (this.destroyed) throw new SFrameError("context_destroyed");
    if (this.counter > MAX_UINT64) throw new SFrameError("counter_exhausted");
    const current = this.counter;
    // Reserve before the first await so concurrent callers can never reuse a nonce.
    this.counter = current + 1n;
    const ciphertext = await encryptWithDerivedKey(await this.derived, this.kid, current, plaintext, metadata);
    if (this.destroyed) {
      ciphertext.fill(0);
      throw new SFrameError("context_destroyed");
    }
    return ciphertext;
  }

  destroy(): void {
    this.destroyed = true;
    this.key.fill(0);
    this.counter = MAX_UINT64 + 1n;
    void this.derived.then((derived) => derived.salt.fill(0)).catch(() => undefined);
  }
}

export class SFrameDecryptContext {
  private readonly keys = new Map<string, {
    baseKey: Uint8Array;
    derived: Promise<DerivedKey>;
    replay: SFrameReplayWindow;
  }>();
  private destroyed = false;

  setKey(kid: bigint, baseKey: Uint8Array): void {
    if (this.destroyed) throw new SFrameError("context_destroyed");
    assertUint64(kid, "kid");
    if (baseKey.length !== SFRAME_BASE_KEY_BYTES) throw new SFrameError("base_key_length");
    this.removeKey(kid);
    const key = Uint8Array.from(baseKey);
    this.keys.set(kid.toString(), {
      baseKey: key,
      derived: deriveKey(key, kid),
      replay: new SFrameReplayWindow(),
    });
  }

  async decrypt(ciphertext: Uint8Array, metadata = new Uint8Array()): Promise<Uint8Array> {
    if (this.destroyed) throw new SFrameError("context_destroyed");
    const header = decodeSFrameHeader(ciphertext);
    const entry = this.keys.get(header.kid.toString());
    if (!entry) throw new SFrameError("unknown_kid");
    if (!entry.replay.canAccept(header.counter)) throw new SFrameError("replay_rejected");
    const plaintext = await decryptWithDerivedKey(await entry.derived, header, ciphertext, metadata);
    if (this.destroyed || this.keys.get(header.kid.toString()) !== entry) {
      plaintext.fill(0);
      throw new SFrameError("context_destroyed");
    }
    if (!entry.replay.accept(header.counter)) {
      plaintext.fill(0);
      throw new SFrameError("replay_rejected");
    }
    return plaintext;
  }

  removeKey(kid: bigint): void {
    const entry = this.keys.get(kid.toString());
    if (!entry) return;
    entry.baseKey.fill(0);
    void entry.derived.then((derived) => derived.salt.fill(0)).catch(() => undefined);
    entry.replay.clear();
    this.keys.delete(kid.toString());
  }

  destroy(): void {
    this.destroyed = true;
    for (const entry of this.keys.values()) {
      entry.baseKey.fill(0);
      void entry.derived.then((derived) => derived.salt.fill(0)).catch(() => undefined);
      entry.replay.clear();
    }
    this.keys.clear();
  }
}
