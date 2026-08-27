import { Injectable, signal } from "@angular/core";

export interface JoinProofInput {
  readonly roomId: string;
  readonly mode: "room" | "pair";
  readonly displayName: string;
}

interface StoredKeys {
  readonly publicKey: CryptoKey;
  readonly privateKey: CryptoKey;
}

function base64Url(value: ArrayBuffer | Uint8Array): string {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function deviceProofMessage(input: JoinProofInput, timestamp: number, nonce: string): string {
  return `webrtc-join-v1\n${input.roomId}\n${input.mode}\n${input.displayName}\n${timestamp}\n${nonce}`;
}

@Injectable({ providedIn: "root" })
export class DeviceIdentityService {
  readonly fingerprint = signal("");
  private keysPromise: Promise<StoredKeys> | null = null;

  async createProof(input: JoinProofInput) {
    const keys = await this.keys();
    const timestamp = Date.now();
    const nonce = base64Url(crypto.getRandomValues(new Uint8Array(24)));
    const message = new TextEncoder().encode(deviceProofMessage(input, timestamp, nonce));
    const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, keys.privateKey, message);
    const publicKey = await crypto.subtle.exportKey("jwk", keys.publicKey);
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(`P-256\n${publicKey.x}\n${publicKey.y}`),
    );
    this.fingerprint.set(base64Url(digest));
    return { publicKey, timestamp, nonce, signature: base64Url(signature) };
  }

  private keys(): Promise<StoredKeys> {
    this.keysPromise ||= this.loadOrCreateKeys();
    return this.keysPromise;
  }

  private async loadOrCreateKeys(): Promise<StoredKeys> {
    const database = await this.openDatabase();
    const existing = await new Promise<StoredKeys | undefined>((resolve, reject) => {
      const request = database.transaction("identity", "readonly").objectStore("identity").get("p256");
      request.onsuccess = () => resolve(request.result as StoredKeys | undefined);
      request.onerror = () => reject(request.error);
    });
    if (existing?.privateKey && existing.publicKey) return existing;
    const generated = await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign", "verify"],
    );
    const keys = { publicKey: generated.publicKey, privateKey: generated.privateKey };
    await new Promise<void>((resolve, reject) => {
      const request = database.transaction("identity", "readwrite").objectStore("identity").put(keys, "p256");
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
    return keys;
  }

  private openDatabase(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open("webrtc-room-identity", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("identity");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
}
