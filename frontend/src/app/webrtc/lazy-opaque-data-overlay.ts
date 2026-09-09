import type { OpaqueDataOverlay } from "./opaque-data-overlay";

type Loader = () => Promise<{ OpaqueDataOverlay: new () => OpaqueDataOverlay }>;

/** Load crypto only at the existing explicit room lifecycle's initialization. */
export class LazyOpaqueDataOverlay {
  private lifetime = {};
  private overlay: OpaqueDataOverlay | null = null;

  constructor(private readonly load: Loader = () => import("./opaque-data-overlay")) {}

  async initialize(ownPeerId: string): Promise<JsonWebKey> {
    if (!/^[a-f0-9]{16}$/.test(ownPeerId)) throw new Error("invalid_own_peer");
    this.destroy();
    const lifetime = this.lifetime, module = await this.load();
    if (lifetime !== this.lifetime) throw new Error("overlay_lifecycle_changed");
    const overlay = new module.OpaqueDataOverlay();
    this.overlay = overlay;
    try {
      const key = await overlay.initialize(ownPeerId);
      if (lifetime !== this.lifetime) throw new Error("overlay_lifecycle_changed");
      return key;
    } catch (error) {
      if (this.overlay === overlay) this.destroy();
      throw error;
    }
  }

  async setPeerKey(...args: Parameters<OpaqueDataOverlay["setPeerKey"]>) {
    return this.required().setPeerKey(...args);
  }
  async encrypt(...args: Parameters<OpaqueDataOverlay["encrypt"]>) {
    return this.required().encrypt(...args);
  }
  async receive(...args: Parameters<OpaqueDataOverlay["receive"]>) {
    return this.overlay ? this.overlay.receive(...args) : { action: "drop" as const, reason: "overlay_key_unavailable" };
  }
  hasPeerKey(peerId: string): boolean { return this.overlay?.hasPeerKey(peerId) ?? false; }
  removePeer(peerId: string): void { this.overlay?.removePeer(peerId); }
  resume(...args: Parameters<OpaqueDataOverlay["resume"]>) { return this.overlay?.resume(...args) ?? []; }

  destroy(): void {
    this.lifetime = {};
    const overlay = this.overlay; this.overlay = null;
    overlay?.destroy();
  }
  private required(): OpaqueDataOverlay {
    if (!this.overlay) throw new Error("overlay_key_unavailable");
    return this.overlay;
  }
}
