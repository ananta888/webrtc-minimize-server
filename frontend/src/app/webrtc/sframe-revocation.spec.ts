import { afterEach, describe, expect, it, vi } from "vitest";

import { encryptSFrame, SFrameDecryptContext, SFrameEncryptContext } from "./sframe-codec";

// Hold a real WebCrypto result at the asynchronous boundary. No sleeps, fake
// ciphertext, keys in diagnostics or changes to the production crypto seam.
function holdResult(method: "encrypt" | "decrypt") {
  const original = crypto.subtle[method].bind(crypto.subtle);
  let release!: () => void;
  let produced!: (bytes: Uint8Array) => void;
  const released = new Promise<void>(resolve => { release = resolve; });
  const ready = new Promise<Uint8Array>(resolve => { produced = resolve; });
  vi.spyOn(crypto.subtle, method).mockImplementation(async (...args) => {
    const result = await original(...args);
    produced(new Uint8Array(result));
    await released;
    return result;
  });
  return { ready, release };
}

afterEach(() => { vi.restoreAllMocks(); });

describe("SFrame asynchronous revocation", () => {
  it("does not deliver an encryption completed after sender destruction", async () => {
    const sender = new SFrameEncryptContext(1n, new Uint8Array(16));
    const held = holdResult("encrypt");
    try {
      const pending = sender.encrypt(Uint8Array.of(1, 2, 3));
      const rejected = expect(pending).rejects.toMatchObject({ code: "context_destroyed" });
      await held.ready;
      sender.destroy();
      held.release();
      await rejected;
    } finally { held.release(); sender.destroy(); }
  });

  it.each(["destroy", "remove", "replace"] as const)(
    "wipes pending plaintext when its exact receive key is invalidated by %s",
    async action => {
      const key = new Uint8Array(16);
      const ciphertext = await encryptSFrame(key, 1n, 0n, Uint8Array.of(1, 2, 3));
      const receiver = new SFrameDecryptContext();
      receiver.setKey(1n, key);
      const held = holdResult("decrypt");
      try {
        const pending = receiver.decrypt(ciphertext);
        const rejected = expect(pending).rejects.toMatchObject({ code: "context_destroyed" });
        const plaintext = await held.ready;
        expect([...plaintext]).toEqual([1, 2, 3]);
        if (action === "destroy") receiver.destroy();
        else if (action === "remove") receiver.removeKey(1n);
        else receiver.setKey(1n, key);
        held.release();
        await rejected;
        expect([...plaintext]).toEqual([0, 0, 0]);
      } finally { held.release(); receiver.destroy(); key.fill(0); }
    },
  );

  it("keeps an unrelated retained receive key valid during rotation", async () => {
    const key = new Uint8Array(16);
    const ciphertext = await encryptSFrame(key, 1n, 0n, Uint8Array.of(1, 2, 3));
    const receiver = new SFrameDecryptContext();
    receiver.setKey(1n, key);
    const held = holdResult("decrypt");
    try {
      const pending = receiver.decrypt(ciphertext);
      await held.ready;
      receiver.setKey(2n, new Uint8Array(16).fill(2));
      held.release();
      expect([...await pending]).toEqual([1, 2, 3]);
      await expect(receiver.decrypt(ciphertext)).rejects.toMatchObject({ code: "replay_rejected" });
    } finally { held.release(); receiver.destroy(); key.fill(0); }
  });
});
