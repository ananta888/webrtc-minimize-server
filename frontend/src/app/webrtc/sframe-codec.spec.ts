import { describe, expect, it } from "vitest";

import {
  decodeSFrameHeader,
  decryptSFrame,
  encodeSFrameHeader,
  encryptSFrame,
  SFrameDecryptContext,
  SFrameEncryptContext,
  SFrameError,
  SFrameReplayWindow,
} from "./sframe-codec";

function bytes(hex: string): Uint8Array {
  return Uint8Array.from(hex.match(/../g)!.map((value) => Number.parseInt(value, 16)));
}

function hex(value: Uint8Array): string {
  return [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

describe("RFC 9605 SFrame cipher suite 0x0004", () => {
  it("encodes canonical compact and extended headers", () => {
    expect(hex(encodeSFrameHeader(0n, 0n))).toBe("00");
    expect(hex(encodeSFrameHeader(0n, 255n))).toBe("08ff");
    expect(hex(encodeSFrameHeader(256n, 256n))).toBe("9901000100");
    expect(decodeSFrameHeader(bytes("9901000100"))).toMatchObject({ kid: 256n, counter: 256n, length: 5 });
    expect(() => decodeSFrameHeader(bytes("8007"))).toThrowError(new SFrameError("header_non_canonical"));
  });

  it("matches the official suite-4 encryption test vector", async () => {
    const ciphertext = await encryptSFrame(
      bytes("000102030405060708090a0b0c0d0e0f"),
      291n,
      17_767n,
      bytes("64726166742d696574662d736672616d652d656e63"),
      bytes("4945544620534672616d65205747"),
    );
    expect(hex(ciphertext)).toBe("9901234567b7412c2513a1b66dbb48841bbaf17f598751176ad847681a69c6d0b091c07018ce4adb34eb");
    const result = await decryptSFrame(
      bytes("000102030405060708090a0b0c0d0e0f"),
      ciphertext,
      bytes("4945544620534672616d65205747"),
    );
    expect(hex(result.plaintext)).toBe("64726166742d696574662d736672616d652d656e63");
  });

  it("rejects tampering and authenticated replay", async () => {
    const key = bytes("000102030405060708090a0b0c0d0e0f");
    const ciphertext = await encryptSFrame(key, 7n, 4n, bytes("010203"));
    const receiver = new SFrameDecryptContext();
    receiver.setKey(7n, key);
    expect(hex(await receiver.decrypt(ciphertext))).toBe("010203");
    await expect(receiver.decrypt(ciphertext)).rejects.toMatchObject({ code: "replay_rejected" });
    const tampered = ciphertext.slice();
    tampered[tampered.length - 1] ^= 1;
    const fresh = new SFrameDecryptContext();
    fresh.setKey(7n, key);
    await expect(fresh.decrypt(tampered)).rejects.toMatchObject({ code: "authentication_failed" });
  });

  it("delivers at most one copy when duplicate decryptions overlap", async () => {
    const key = bytes("000102030405060708090a0b0c0d0e0f");
    const ciphertext = await encryptSFrame(key, 7n, 9n, bytes("010203"));
    const receiver = new SFrameDecryptContext();
    receiver.setKey(7n, key);
    const results = await Promise.allSettled([receiver.decrypt(ciphertext), receiver.decrypt(ciphertext)]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
  });

  it("maintains a bounded reordering window", () => {
    const replay = new SFrameReplayWindow();
    expect(replay.accept(200n)).toBe(true);
    expect(replay.accept(199n)).toBe(true);
    expect(replay.accept(199n)).toBe(false);
    expect(replay.accept(72n)).toBe(false);
    expect(replay.accept(201n)).toBe(true);
  });

  it("reserves distinct counters for concurrent encryption", async () => {
    const sender = new SFrameEncryptContext(3n, bytes("000102030405060708090a0b0c0d0e0f"));
    const encrypted = await Promise.all([
      sender.encrypt(bytes("01")),
      sender.encrypt(bytes("02")),
      sender.encrypt(bytes("03")),
    ]);
    expect(encrypted.map((value) => decodeSFrameHeader(value).counter)).toEqual([0n, 1n, 2n]);
    sender.destroy();
  });

  it("fails closed after sender and receiver key cleanup", async () => {
    const key = bytes("000102030405060708090a0b0c0d0e0f");
    const sender = new SFrameEncryptContext(9n, key);
    sender.destroy();
    await expect(sender.encrypt(bytes("01"))).rejects.toMatchObject({ code: "context_destroyed" });
    const receiver = new SFrameDecryptContext();
    receiver.setKey(9n, key);
    receiver.destroy();
    await expect(receiver.decrypt(await encryptSFrame(key, 9n, 0n, bytes("01"))))
      .rejects.toMatchObject({ code: "context_destroyed" });
  });
});
