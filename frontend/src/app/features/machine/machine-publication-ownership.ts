import { Injectable } from "@angular/core";

type Source = "camera" | "microphone";
export interface MachinePublicationClaim {
  owns(source: Source): boolean;
  release(): void;
}

/** Local lifecycle exclusion only. Membership and publication rights stay in Meet. */
@Injectable()
export class MachinePublicationOwnership {
  private readonly slots = new Map<Source, symbol>();

  claim(sources: readonly Source[]): MachinePublicationClaim {
    if (!sources.length || sources.length > 2 || new Set(sources).size !== sources.length
      || sources.some(source => !["camera", "microphone"].includes(source) || this.slots.has(source))) {
      throw new Error("meet_machine_publication_busy_or_invalid");
    }
    const token = Symbol(), selected = [...sources];
    for (const source of selected) this.slots.set(source, token);
    const owns = (source: Source) => this.slots.get(source) === token;
    return Object.freeze({ owns, release: () => {
      for (const source of selected) if (owns(source)) this.slots.delete(source);
    } });
  }
}
