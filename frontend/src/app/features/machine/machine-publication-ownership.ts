import { Injectable } from "@angular/core";

type Source = "camera" | "microphone";
export interface MachinePublicationClaim {
  owns(source: Source): boolean;
  release(): void;
  /** Offer the claim to the next claimant: `yieldTo` must release it synchronously or refuse. */
  park(yieldTo: () => boolean): void;
  /** Withdraw a parked offer; the claim is exclusively owned again. */
  resume(): void;
}

/** Local lifecycle exclusion only. Membership and publication rights stay in Meet. */
@Injectable()
export class MachinePublicationOwnership {
  private readonly slots = new Map<Source, symbol>();
  private readonly parked = new Map<symbol, () => boolean>();

  claim(sources: readonly Source[]): MachinePublicationClaim {
    if (!sources.length || sources.length > 2 || new Set(sources).size !== sources.length
      || sources.some(source => !["camera", "microphone"].includes(source))) {
      throw new Error("meet_machine_publication_busy_or_invalid");
    }
    // A parked holder (a closed camera kept attached for a successor) yields to
    // an unrelated claimant; every other occupied slot stays exclusive.
    const yields = sources.map(source => { const held = this.slots.get(source); return held ? this.parked.get(held) : undefined; });
    if (sources.some((source, index) => this.slots.has(source) && !yields[index])) throw new Error("meet_machine_publication_busy_or_invalid");
    for (const [index, source] of sources.entries()) {
      if (this.slots.has(source) && !(yields[index]!() && !this.slots.has(source))) throw new Error("meet_machine_publication_busy_or_invalid");
    }
    const token = Symbol(), selected = [...sources];
    for (const source of selected) this.slots.set(source, token);
    const owns = (source: Source) => this.slots.get(source) === token;
    return Object.freeze({ owns, release: () => {
      this.parked.delete(token);
      for (const source of selected) if (owns(source)) this.slots.delete(source);
    }, park: (yieldTo: () => boolean) => {
      if (selected.some(owns)) this.parked.set(token, yieldTo);
    }, resume: () => { this.parked.delete(token); } });
  }
}
