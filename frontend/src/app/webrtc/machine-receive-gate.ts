import { signal } from "@angular/core";

export interface MachineReceiveGrant {
  readonly publisherPeerId: string; readonly machinePeerId: string;
  readonly publicationIds: readonly string[]; readonly chatRead: boolean; readonly expiresAt: number;
}
const peerId = /^[a-f0-9]{16}$/;
const closed = (value: unknown, keys: readonly string[]): value is Record<string, unknown> => Boolean(value
  && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === keys.length
  && Object.keys(value).every(key => keys.includes(key)));

/** Only server-authored membership classifies a recipient as a machine.
 * Receive policy changes rotate publisher keys, including the shared SFU key. */
export class MachineReceiveGate {
  readonly revision = signal(0);
  readonly grants = signal<readonly MachineReceiveGrant[]>([]);
  private machines = new Set<string>();
  private capabilities = new Map<string, readonly string[]>();
  private members = new Set<string>();
  private snapshot = "";
  private timer: ReturnType<typeof setTimeout> | null = null;
  constructor(private readonly changed: () => void, private readonly clock = Date.now) {}
  setMachine(id: string, machine: boolean, capabilities: unknown = []): void {
    this.members.add(id);
    if (machine) {
      this.machines.add(id);
      this.capabilities.set(id, Array.isArray(capabilities) && capabilities.length <= 7
        && capabilities.every(value => typeof value === "string") ? Object.freeze([...capabilities]) : []);
    }
  }
  supports(id: string, capability: string): boolean { return this.capabilities.get(id)?.includes(capability) === true; }
  isMachine(id: string): boolean { return this.machines.has(id); }
  removePeer(id: string): void { this.machines.delete(id); this.members.delete(id); this.capabilities.delete(id); }
  apply(raw: unknown, roomId: string): void {
    if (!closed(raw, ["type", "version", "roomId", "revision", "grants"]) || raw["type"] !== "machine-receive-state"
      || raw["version"] !== 1 || raw["roomId"] !== roomId || !Number.isSafeInteger(raw["revision"])
      || Number(raw["revision"]) < this.revision() || !Array.isArray(raw["grants"]) || raw["grants"].length > 100) {
      this.revoke(); throw new Error("machine_receive_policy_invalid");
    }
    const grants: MachineReceiveGrant[] = [], seen = new Set<string>();
    for (const value of raw["grants"]) {
      if (!closed(value, ["publisherPeerId", "machinePeerId", "publicationIds", "chatRead", "expiresAt"])
        || typeof value["publisherPeerId"] !== "string" || !peerId.test(value["publisherPeerId"])
        || typeof value["machinePeerId"] !== "string" || !peerId.test(value["machinePeerId"])
        || !this.members.has(value["publisherPeerId"]) || this.machines.has(value["publisherPeerId"])
        || !this.machines.has(value["machinePeerId"])
        || value["publisherPeerId"] === value["machinePeerId"] || !Array.isArray(value["publicationIds"])
        || value["publicationIds"].length > 2 || new Set(value["publicationIds"]).size !== value["publicationIds"].length
        || value["publicationIds"].some(id => typeof id !== "string" || !/^[A-Za-z0-9_={}:-]{1,128}$/.test(id))
        || typeof value["chatRead"] !== "boolean" || !Number.isSafeInteger(value["expiresAt"])
        || Number(value["expiresAt"]) < 1
        || Number(value["expiresAt"]) > this.clock() + 600_000) {
        this.revoke(); throw new Error("machine_receive_policy_invalid");
      }
      const key = `${value["publisherPeerId"]}\0${value["machinePeerId"]}`;
      if (seen.has(key)) { this.revoke(); throw new Error("machine_receive_policy_invalid"); }
      seen.add(key);
      grants.push(Object.freeze({ publisherPeerId: value["publisherPeerId"], machinePeerId: value["machinePeerId"],
        publicationIds: Object.freeze([...value["publicationIds"]]), chatRead: value["chatRead"], expiresAt: Number(value["expiresAt"]) }));
    }
    const snapshot = JSON.stringify(grants);
    if (Number(raw["revision"]) === this.revision() && this.snapshot) {
      if (snapshot !== this.snapshot) { this.revoke(); throw new Error("machine_receive_policy_invalid"); }
      return;
    }
    this.snapshot = snapshot;
    this.revision.set(Number(raw["revision"])); this.grants.set(Object.freeze(grants));
    this.arm(); this.changed();
  }
  mediaAllowed(receiver: string, publisher: string, publication: string, source: string): boolean {
    if (!this.isMachine(receiver)) return true;
    if (!["microphone", "screen-audio"].includes(source)) return false;
    return this.grants().some(g => g.machinePeerId === receiver && g.publisherPeerId === publisher
      && g.publicationIds.includes(publication) && g.expiresAt > this.clock());
  }
  chatAllowed(receiver: string, publisher: string): boolean {
    return !this.isMachine(receiver) || this.grants().some(g => g.machinePeerId === receiver
      && g.publisherPeerId === publisher && g.chatRead && g.expiresAt > this.clock());
  }
  private arm(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const future = this.grants().filter(g => g.expiresAt > this.clock());
    if (future.length) this.timer = setTimeout(() => {
      this.grants.set(this.grants().filter(g => g.expiresAt > this.clock()));
      this.arm(); this.changed();
    }, Math.max(1, Math.min(...future.map(g => g.expiresAt)) - this.clock()));
  }
  private revoke(): void {
    if (this.timer) clearTimeout(this.timer); this.timer = null;
    this.grants.set([]); this.changed();
  }
  clear(): void {
    if (this.timer) clearTimeout(this.timer); this.timer = null;
    this.machines.clear(); this.members.clear(); this.capabilities.clear(); this.snapshot = ""; this.grants.set([]); this.revision.set(0);
  }
}
