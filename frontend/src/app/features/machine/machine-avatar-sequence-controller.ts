import { MachineAvatarAuthority } from "./machine-avatar-source";
import { MachineAvatarArtwork } from "./machine-avatar-artwork";
import { AvatarSequenceContent, parseAvatarSequence } from "./machine-avatar-sequence-contract";
import { AvatarSequencePreparationPort, PreparedAvatarSequence } from "./machine-avatar-sequence-preparation";
import { sequenceArtwork } from "./machine-avatar-sequence-artwork";
import { AvatarSequenceClock, SequenceFramePosition } from "./machine-avatar-sequence-clock";

interface SequenceControllerPorts {
  authority(): MachineAvatarAuthority;
  progress(): unknown;
  preparation: AvatarSequencePreparationPort;
  clock?: () => number;
  monotonicClock?: () => number;
}
interface Entry {
  id: number;
  scope: Readonly<MachineAvatarAuthority>;
  content: AvatarSequenceContent;
  controller: AbortController;
  state: "preparing" | "ready" | "active" | "failed" | "closed";
  deadline: number;
  localDeadline: number;
  lastClock: number;
  lastLocal: number;
  clock?: AvatarSequenceClock;
  observed: { segment: number; expected_start_sample: number; observed_played_sample: number; drift_us: number }[];
  lastPlayed: number;
  prepared?: PreparedAvatarSequence;
  timer?: ReturnType<typeof setInterval>;
}

/** Pollable owned preparation; activation still belongs to the existing source. */
export class AvatarSequenceController {
  private generation = 0;
  private entry?: Entry;
  constructor(private readonly ports: SequenceControllerPorts) {}

  prepare(sourceId: string, value: unknown) {
    if (this.entry && !["failed", "closed"].includes(this.entry.state)) throw new Error("meet_avatar_sequence_busy");
    const scope = this.ports.authority(), now = this.now(), local = this.local();
    if (sourceId !== scope.sourceId || !Number.isFinite(now) || !Number.isFinite(local) || local < 0
      || !Number.isFinite(scope.expiresAt) || scope.expiresAt <= now
      || this.generation >= 2048) throw new Error("meet_avatar_sequence_denied");
    const content = parseAvatarSequence(value);
    const entry: Entry = { id: ++this.generation, scope: Object.freeze({ ...scope }), content,
      controller: new AbortController(), state: "preparing", deadline: Math.min(scope.expiresAt, now + 20_000),
      localDeadline: local + 20_000, lastClock: now, lastLocal: local, observed: [], lastPlayed: 0 };
    this.entry = entry;
    entry.timer = setInterval(() => { try { this.current(entry); } catch { this.release(entry, "failed"); } }, 100);
    void this.ports.preparation.prepare(content, () => this.current(entry), entry.controller.signal).then(prepared => {
      try { this.current(entry); entry.prepared = prepared; entry.state = "ready"; }
      catch { prepared.close(); this.release(entry, "failed"); }
    }, () => this.release(entry, "failed"));
    return Object.freeze({ schema: "ananta.meet-avatar-sequence-preparation.v1", id: entry.id });
  }

  status(id: number) {
    const entry = this.require(id);
    if (!["closed", "failed"].includes(entry.state)) {
      try { this.current(entry); } catch { this.release(entry, "failed"); }
    }
    return Object.freeze({ schema: "ananta.meet-avatar-sequence-status.v1", id: entry.id, state: entry.state });
  }

  activate(value: unknown, check: () => void): MachineAvatarArtwork {
    if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).sort().join(",") !== "id,speechGeneration") throw new Error("meet_avatar_sequence_binding_invalid");
    const { id, speechGeneration } = value as { id: number; speechGeneration: number };
    const entry = this.require(id);
    this.current(entry);
    if (entry.state !== "ready" || !entry.prepared) throw new Error("meet_avatar_sequence_not_ready");
    // Check an actual live speech snapshot before handing out any artwork.
    try {
      check(); entry.clock = new AvatarSequenceClock(entry.content, speechGeneration);
      entry.clock.read(this.ports.progress());
      const artwork = sequenceArtwork(entry.content, speechGeneration, entry.prepared, {
        check: () => { this.current(entry); check(); }, progress: () => this.ports.progress(),
        observe: position => this.observe(entry, position),
      });
      // Source setup will perform its own first draw and authority check.
      entry.state = "active";
      entry.deadline = Math.min(entry.scope.expiresAt, this.now() + 50_000);
      entry.localDeadline = this.local() + 50_000;
      return { draw: drawing => artwork.draw(drawing), close: () => {
        try { artwork.close(); } finally { this.release(entry, "closed"); }
      } };
    } catch (error) { this.release(entry, "failed"); throw error; }
  }

  close(id?: number): boolean {
    // Unscoped idempotent cleanup confirms no resource remains. A targeted
    // unknown handle still cannot claim successful cancellation.
    if (!this.entry) return id === undefined;
    if (id !== undefined && id !== this.entry.id) return false;
    this.release(this.entry, "closed"); return true;
  }

  quality(id: number) {
    const entry = this.require(id); this.current(entry);
    if (entry.state !== "active" || !entry.clock) throw new Error("meet_avatar_sequence_not_active");
    const position = entry.clock.read(this.ports.progress());
    const maximum = Math.max(0, ...entry.observed.map(row => row.drift_us));
    return Object.freeze({ schema: "ananta.meet-avatar-sequence-quality.v1", id: entry.id,
      segments: entry.observed.map(row => ({ ...row })), max_drift_us: maximum,
      sync_complete: position.held && entry.lastPlayed === entry.content.totalSamples
        && entry.observed.length === entry.content.clips.length
        && entry.observed.every((row, index) => row.segment === index) && maximum <= 41667 });
  }

  private observe(entry: Entry, position: SequenceFramePosition): void {
    this.current(entry); entry.lastPlayed = position.playedSamples;
    if (entry.observed.at(-1)?.segment === position.clipIndex) return;
    const expected = entry.content.clips[position.clipIndex].startSample;
    entry.observed.push({ segment: position.clipIndex, expected_start_sample: expected,
      observed_played_sample: position.playedSamples,
      drift_us: Math.floor(Math.abs(position.playedSamples - expected) * 1000000 / 22050) });
  }

  private require(id: number): Entry {
    if (!Number.isSafeInteger(id) || !this.entry || id !== this.entry.id) throw new Error("meet_avatar_sequence_stale");
    return this.entry;
  }

  private now(): number { return (this.ports.clock ?? Date.now)(); }
  private local(): number { return (this.ports.monotonicClock ?? (() => performance.now()))(); }

  private current(entry: Entry): void {
    const current = this.ports.authority(), now = this.now(), local = this.local();
    if (this.entry !== entry || entry.controller.signal.aborted || !Number.isFinite(now) || now >= entry.deadline
      || !Number.isFinite(local) || now < entry.lastClock || local < entry.lastLocal || local >= entry.localDeadline
      || Object.keys(entry.scope).some(key => current[key as keyof MachineAvatarAuthority]
        !== entry.scope[key as keyof MachineAvatarAuthority])) throw new Error("meet_avatar_sequence_authority_changed");
    entry.lastClock = now; entry.lastLocal = local;
  }

  private release(entry: Entry, state: "closed" | "failed"): void {
    if (["closed", "failed"].includes(entry.state)) return;
    entry.state = state; clearInterval(entry.timer); entry.timer = undefined;
    entry.controller.abort();
    try { entry.prepared?.close(); } catch { /* State and ownership stay retired. */ }
    finally { entry.prepared = undefined; }
  }
}
