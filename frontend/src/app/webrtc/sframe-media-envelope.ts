import { SFrameDecryptContext, SFrameEncryptContext, SFrameError } from "./sframe-codec";

export const SFRAME_MEDIA_ENVELOPE = "codec-prefix-v1" as const;

const ENVELOPE_MAGIC = Uint8Array.of(0x53, 0x46, 0x01);
const CODEC_IDS = Object.freeze({ vp8: 1, opus: 2 });

export interface EncodedMediaFrame {
  readonly data: ArrayBuffer;
  readonly type?: "key" | "delta";
  readonly getMetadata?: () => Readonly<{ mimeType?: string }>;
}

interface CodecLayout {
  readonly codecId: number;
  readonly prefixBytes: number;
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

function codecLayout(frame: EncodedMediaFrame): CodecLayout {
  const mimeType = String(frame.getMetadata?.().mimeType || "").toLowerCase();
  if (mimeType === "video/vp8" || (!mimeType && (frame.type === "key" || frame.type === "delta"))) {
    if (frame.type !== "key" && frame.type !== "delta") throw new SFrameError("media_frame_type");
    return { codecId: CODEC_IDS.vp8, prefixBytes: frame.type === "key" ? 10 : 3 };
  }
  if (mimeType === "audio/opus" || (!mimeType && frame.type === undefined)) {
    return { codecId: CODEC_IDS.opus, prefixBytes: 1 };
  }
  throw new SFrameError("media_codec_unsupported");
}

function envelopeHeader(codecId: number): Uint8Array {
  return Uint8Array.of(...ENVELOPE_MAGIC, codecId);
}

function splitPrefix(data: Uint8Array, layout: CodecLayout): Readonly<{
  prefix: Uint8Array;
  payload: Uint8Array;
  header: Uint8Array;
  authenticatedMetadata: Uint8Array;
}> {
  if (data.length < layout.prefixBytes) throw new SFrameError("media_frame_too_short");
  const prefix = data.slice(0, layout.prefixBytes);
  const payload = data.slice(layout.prefixBytes);
  const header = envelopeHeader(layout.codecId);
  return {
    prefix,
    payload,
    header,
    authenticatedMetadata: concat(header, prefix),
  };
}

export async function encryptMediaFrame(
  context: SFrameEncryptContext,
  frame: EncodedMediaFrame,
): Promise<Uint8Array> {
  const layout = codecLayout(frame);
  const { prefix, payload, header, authenticatedMetadata } = splitPrefix(new Uint8Array(frame.data), layout);
  const ciphertext = await context.encrypt(payload, Uint8Array.from(authenticatedMetadata));
  return concat(prefix, header, ciphertext);
}

export async function decryptMediaFrame(
  context: SFrameDecryptContext,
  frame: EncodedMediaFrame,
): Promise<Uint8Array> {
  const layout = codecLayout(frame);
  const data = new Uint8Array(frame.data);
  const headerOffset = layout.prefixBytes;
  const ciphertextOffset = headerOffset + ENVELOPE_MAGIC.length + 1;
  if (data.length <= ciphertextOffset) throw new SFrameError("media_frame_too_short");
  const prefix = data.slice(0, headerOffset);
  const header = data.slice(headerOffset, ciphertextOffset);
  const expectedHeader = envelopeHeader(layout.codecId);
  if (header.some((byte, index) => byte !== expectedHeader[index])) {
    throw new SFrameError("media_envelope_version");
  }
  const plaintext = await context.decrypt(
    data.slice(ciphertextOffset),
    Uint8Array.from(concat(header, prefix)),
  );
  return concat(prefix, plaintext);
}
