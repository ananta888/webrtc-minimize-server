import { Injectable, OnDestroy } from "@angular/core";
import { RoomSessionService } from "../../webrtc/room-session.service";
import { MachineMediaTimeline, MEDIA_TIMING_PROFILE, MEDIA_DRIFT_US, MEDIA_AGE_US,
  SourceTimingLease, TimingSource, TimingMeasurement } from "./machine-media-timeline";

export interface SourceTimingPort {
  open(source: TimingSource, measurement: TimingMeasurement, stop: () => void): SourceTimingLease;
}

/** Page-local quality composition; it neither opens publications nor grants membership. */
@Injectable()
export class MachineMediaTimingService implements SourceTimingPort, OnDestroy {
  private timeline?: MachineMediaTimeline;
  private timer?: ReturnType<typeof setInterval>;
  private readonly owners = new Map<TimingSource, symbol>();
  private epoch = 0;
  private sessionId?: string;
  private failed = false;

  constructor(private readonly session: RoomSessionService) {}

  probe() {
    const canvasTrack = Reflect.get(globalThis, "CanvasCaptureMediaStreamTrack");
    return Object.freeze({ schema: "ananta.meet-media-timing-probe.v1", profile: MEDIA_TIMING_PROFILE,
      timebase: "browser-performance-v1", max_drift_us: MEDIA_DRIFT_US, max_age_us: MEDIA_AGE_US,
      decoded_video: typeof HTMLVideoElement !== "undefined"
        && typeof HTMLVideoElement.prototype.requestVideoFrameCallback === "function"
        && typeof HTMLVideoElement.prototype.cancelVideoFrameCallback === "function",
      canvas_submission: typeof canvasTrack === "function" && typeof canvasTrack.prototype?.requestFrame === "function" });
  }

  start(profile: unknown) {
    if (profile !== MEDIA_TIMING_PROFILE || this.timeline || this.owners.size || this.failed || this.epoch >= 4096) {
      throw new Error("meet_media_timing_start_denied");
    }
    const id = this.session.machineLease()?.sessionId;
    if (!this.session.joined() || typeof id !== "string" || !id) throw new Error("meet_media_timing_membership_invalid");
    this.sessionId = id;
    this.timeline = new MachineMediaTimeline(++this.epoch, () => Math.floor(performance.now() * 1000));
    const snapshot = this.snapshot();
    this.timer = setInterval(() => { try { this.snapshot(); } catch { this.fail(); } }, 100);
    return snapshot;
  }

  open(source: TimingSource, measurement: TimingMeasurement, stop: () => void): SourceTimingLease {
    if (!["speech", "avatar", "screen"].includes(source) || this.owners.has(source) || this.failed) {
      throw new Error("meet_media_timing_source_busy_or_failed");
    }
    // Track even disabled sources so opt-in cannot silently rebase an existing publication.
    const token = Symbol();
    if (this.timeline) this.current();
    const lease = this.timeline?.open(source, measurement, stop);
    this.owners.set(source, token);
    return { fail: () => { if (this.owners.get(source) === token) lease?.fail(); }, observe: (position, held) => {
      if (this.owners.get(source) !== token) return;
      lease?.observe(position, held);
    }, close: () => {
      lease?.close();
      if (this.owners.get(source) === token) this.owners.delete(source);
    } };
  }

  snapshot() { this.current(); return this.timeline!.snapshot(); }

  enabled(): boolean { return this.timeline !== undefined; }

  close(): void {
    clearInterval(this.timer); this.timer = undefined;
    const timeline = this.timeline; this.timeline = undefined;
    this.sessionId = undefined; this.owners.clear(); this.failed = false;
    timeline?.close();
  }

  ngOnDestroy(): void { this.close(); }

  private current(): void {
    if (!this.timeline || this.failed) throw new Error("meet_media_timing_disabled_or_failed");
    if (!this.session.joined() || this.session.machineLease()?.sessionId !== this.sessionId) {
      this.fail(); throw new Error("meet_media_timing_membership_changed");
    }
  }

  private fail(): void {
    this.failed = true; clearInterval(this.timer); this.timer = undefined; this.timeline?.close();
  }
}
