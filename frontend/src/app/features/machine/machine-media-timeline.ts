/** Execution quality only: these local counters never grant media authority. */
export const MEDIA_TIMING_PROFILE = "independent-owned-live-v1";
export const MEDIA_DRIFT_US = 500_000, MEDIA_AGE_US = 750_000;
const MAX_TIME_US = 86_400_000_000;
export type TimingSource = "speech" | "avatar" | "screen";
export type TimingMeasurement = "pcm-progress" | "decoded-video" | "canvas-submission";
export interface TimingRow {
  generation: number;
  state: "running" | "held" | "failed";
  measurement: TimingMeasurement;
  started_at_us: number;
  position_at_us: number;
  observed_at_us: number;
  origin_position_us: number | null;
  position_us: number | null;
  drift_us: number | null;
}
export interface MediaTimingSnapshot {
  schema: "ananta.meet-media-timing.v1";
  profile: typeof MEDIA_TIMING_PROFILE;
  timebase: "browser-performance-v1";
  epoch: number;
  now_us: number;
  sources: Partial<Record<TimingSource, TimingRow>>;
}
export interface SourceTimingLease {
  observe(positionUs: number | null, held?: boolean): void;
  close(): void;
}
interface Entry { generation: number; measurement: TimingMeasurement; stop: () => void; failed: boolean; row?: TimingRow }
const measurements: Record<TimingSource, readonly TimingMeasurement[]> = {
  speech: ["pcm-progress"], avatar: ["decoded-video", "canvas-submission"], screen: ["canvas-submission"],
};
const integer = (value: number, max = MAX_TIME_US) => Number.isSafeInteger(value) && value >= 0 && value <= max;

/** One membership's bounded source clocks. Source owners supply only their own observations. */
export class MachineMediaTimeline {
  private readonly entries = new Map<TimingSource, Entry>();
  private readonly generations = { speech: 0, avatar: 0, screen: 0 };
  private previous = 0;
  private closed = false;

  constructor(private readonly epoch: number, private readonly clockUs: () => number) {
    if (!integer(epoch, 4096) || epoch === 0) throw new Error("meet_media_timing_epoch_invalid");
  }

  open(source: TimingSource, measurement: TimingMeasurement, stop: () => void): SourceTimingLease {
    this.now();
    if (!Object.hasOwn(measurements, source) || !measurements[source].includes(measurement)
      || typeof stop !== "function") throw new Error("meet_media_timing_source_invalid");
    if (this.entries.has(source)) throw new Error("meet_media_timing_source_busy");
    if (this.generations[source] === 4096) throw new Error("meet_media_timing_generation_exhausted");
    const entry: Entry = { generation: ++this.generations[source], measurement, stop, failed: false };
    this.entries.set(source, entry);
    return {
      observe: (position, held = false) => {
        if (this.entries.get(source) !== entry || this.closed || entry.failed) return;
        try { this.observe(entry, position, held, this.now()); }
        catch (error) { this.fail(entry); throw error; }
      },
      close: () => {
        // Keep a failed row observable; a later close cannot hide quality failure.
        if (this.entries.get(source) === entry && !entry.failed) this.entries.delete(source);
      },
    };
  }

  snapshot(): MediaTimingSnapshot {
    const now = this.now();
    const sources: Partial<Record<TimingSource, TimingRow>> = {};
    for (const [name, entry] of this.entries) {
      const row = entry.row;
      if (!row && entry.failed) throw new Error("meet_media_timing_source_failed");
      if (!row) continue; // Existing source setup deadlines own the pre-readiness phase.
      if (now - row.observed_at_us > MEDIA_AGE_US
        || row.state === "running" && now - row.position_at_us > MEDIA_AGE_US) this.fail(entry);
      sources[name] = { ...row };
    }
    return { schema: "ananta.meet-media-timing.v1", profile: MEDIA_TIMING_PROFILE,
      timebase: "browser-performance-v1", epoch: this.epoch, now_us: now, sources };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const entry of this.entries.values()) this.fail(entry);
  }

  private now(): number {
    if (this.closed) throw new Error("meet_media_timing_closed");
    let now: number;
    try { now = this.clockUs(); } catch { this.close(); throw new Error("meet_media_timing_clock_invalid"); }
    if (!integer(now) || now < this.previous) { this.close(); throw new Error("meet_media_timing_clock_invalid"); }
    this.previous = now;
    return now;
  }

  private observe(entry: Entry, position: number | null, held: boolean, now: number): void {
    if (typeof held !== "boolean" || held && entry.measurement !== "decoded-video"
      || (entry.measurement === "canvas-submission" ? position !== null : !integer(position as number))) {
      throw new Error("meet_media_timing_observation_invalid");
    }
    const row = entry.row;
    if (!row) {
      entry.row = { generation: entry.generation, state: held ? "held" : "running", measurement: entry.measurement,
        started_at_us: now, position_at_us: now, observed_at_us: now,
        origin_position_us: position, position_us: position, drift_us: position === null ? null : 0 };
      return;
    }
    if (row.state === "held" && (!held || position !== row.position_us)
      || position !== null && position < row.position_us!) throw new Error("meet_media_timing_position_invalid");
    if (now - row.observed_at_us > MEDIA_AGE_US) throw new Error("meet_media_timing_stale");
    row.observed_at_us = now;
    if (row.state === "held") return;
    row.position_at_us = now; row.position_us = position;
    row.drift_us = position === null ? null : position - row.origin_position_us! - (now - row.started_at_us);
    if (row.drift_us !== null && Math.abs(row.drift_us) > MEDIA_DRIFT_US) {
      throw new Error("meet_media_timing_drift_exceeded");
    }
    if (held) row.state = "held";
  }

  private fail(entry: Entry): void {
    if (entry.failed) return;
    entry.failed = true;
    if (entry.row) entry.row.state = "failed";
    const stop = entry.stop; entry.stop = () => undefined;
    try { stop(); } catch { /* Failure remains visible even when owned cleanup throws. */ }
  }
}
