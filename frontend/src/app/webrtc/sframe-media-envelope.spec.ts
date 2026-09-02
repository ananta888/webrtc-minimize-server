import { describe, expect, it } from "vitest";

import { SFrameDecryptContext, SFrameEncryptContext } from "./sframe-codec";
import { decryptMediaFrame, encryptMediaFrame } from "./sframe-media-envelope";

const key = Uint8Array.from({ length: 16 }, (_, index) => index);

function frame(data: readonly number[], mimeType: string, type?: "key" | "delta") {
  return {
    data: Uint8Array.from(data).buffer,
    type,
    getMetadata: () => ({ mimeType }),
  };
}

describe("codec-aware SFrame media envelope", () => {
  it("preserves and authenticates VP8 prefixes across the 255/256 counter boundary", async () => {
    const encryptor = new SFrameEncryptContext(0x0011223344556677n, key, 255n);
    const decryptor = new SFrameDecryptContext();
    decryptor.setKey(encryptor.kid, key);
    const delta = frame([0x11, 0x22, 0x33, 0xaa, 0xbb, 0xcc], "video/VP8", "delta");
    const keyFrame = frame([
      0x10, 0x00, 0x00, 0x9d, 0x01, 0x2a, 0x80, 0x02, 0x68, 0x01, 0xdd, 0xee,
    ], "video/VP8", "key");

    const at255 = await encryptMediaFrame(encryptor, delta);
    const at256 = await encryptMediaFrame(encryptor, keyFrame);

    expect([...at255.slice(0, 3)]).toEqual([0x11, 0x22, 0x33]);
    expect([...at256.slice(0, 10)]).toEqual([...new Uint8Array(keyFrame.data).slice(0, 10)]);
    expect(await decryptMediaFrame(decryptor, { ...delta, data: at255.buffer })).toEqual(new Uint8Array(delta.data));
    expect(await decryptMediaFrame(decryptor, { ...keyFrame, data: at256.buffer })).toEqual(new Uint8Array(keyFrame.data));
  });

  it("keeps the Opus TOC byte clear but authenticated", async () => {
    const encryptor = new SFrameEncryptContext(7n, key);
    const decryptor = new SFrameDecryptContext();
    decryptor.setKey(encryptor.kid, key);
    const opus = frame([0xf8, 0x10, 0x20, 0x30], "audio/opus");
    const encrypted = await encryptMediaFrame(encryptor, opus);
    expect(encrypted[0]).toBe(0xf8);
    expect(await decryptMediaFrame(decryptor, { ...opus, data: encrypted.buffer })).toEqual(new Uint8Array(opus.data));
  });

  it("authenticates a minimal one-byte Opus DTX packet", async () => {
    const encryptor = new SFrameEncryptContext(8n, key);
    const decryptor = new SFrameDecryptContext();
    decryptor.setKey(encryptor.kid, key);
    const opus = frame([0xf8], "audio/opus");
    const encrypted = await encryptMediaFrame(encryptor, opus);
    expect(encrypted[0]).toBe(0xf8);
    expect(await decryptMediaFrame(decryptor, { ...opus, data: encrypted.buffer })).toEqual(new Uint8Array(opus.data));
  });

  it("rejects prefix tampering, unknown envelope versions and unsupported codecs", async () => {
    const encryptor = new SFrameEncryptContext(9n, key);
    const delta = frame([0x11, 0x22, 0x33, 0xaa], "video/VP8", "delta");
    const encrypted = await encryptMediaFrame(encryptor, delta);

    const tamperedPrefix = encrypted.slice();
    tamperedPrefix[1] ^= 1;
    const firstDecryptor = new SFrameDecryptContext();
    firstDecryptor.setKey(encryptor.kid, key);
    await expect(decryptMediaFrame(firstDecryptor, { ...delta, data: tamperedPrefix.buffer }))
      .rejects.toMatchObject({ code: "authentication_failed" });

    const wrongVersion = encrypted.slice();
    wrongVersion[5] ^= 1;
    const secondDecryptor = new SFrameDecryptContext();
    secondDecryptor.setKey(encryptor.kid, key);
    await expect(decryptMediaFrame(secondDecryptor, { ...delta, data: wrongVersion.buffer }))
      .rejects.toMatchObject({ code: "media_envelope_version" });

    await expect(encryptMediaFrame(encryptor, frame([1, 2, 3, 4], "video/H264", "delta")))
      .rejects.toMatchObject({ code: "media_codec_unsupported" });
  });
});
