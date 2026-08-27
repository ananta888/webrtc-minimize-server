import { Injectable, signal } from "@angular/core";

import { ActivityObservation, selectActiveSpeakers } from "./media-optimization-policy";

interface Monitor {
  readonly peerId: string;
  readonly analyser: AnalyserNode;
  readonly source: MediaStreamAudioSourceNode;
  readonly samples: Uint8Array<ArrayBuffer>;
}

@Injectable({ providedIn: "root" })
export class AudioActivityService {
  readonly activePeerIds = signal<readonly string[]>([]);
  readonly supported = signal(true);
  private readonly observations = new Map<string, ActivityObservation>();
  private readonly monitors = new Map<string, Monitor>();
  private context: AudioContext | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private limit = 5;

  configure(limit: number): void {
    this.limit = Math.max(2, Math.min(5, Math.trunc(limit)));
  }

  observe(peerId: string, track: MediaStreamTrack): void {
    if (!peerId || track.kind !== "audio" || this.monitors.has(track.id)) return;
    const AudioContextType = window.AudioContext
      || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextType) {
      this.supported.set(false);
      return;
    }
    try {
      this.context ||= new AudioContextType();
      void this.context.resume().catch(() => undefined);
      const source = this.context.createMediaStreamSource(new MediaStream([track]));
      const analyser = this.context.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.55;
      source.connect(analyser);
      this.monitors.set(track.id, {
        peerId,
        analyser,
        source,
        samples: new Uint8Array(analyser.fftSize),
      });
      track.addEventListener("ended", () => this.remove(track.id), { once: true });
      this.ensureTimer();
    } catch {
      this.supported.set(false);
    }
  }

  acceptPeerLevel(peerId: string, level: number, now = Date.now()): void {
    if (!peerId || !Number.isFinite(level) || level < 0 || level > 1) return;
    const current = this.observations.get(peerId);
    const smoothed = current ? current.level * 0.65 + level * 0.35 : level;
    this.observations.set(peerId, { peerId, level: smoothed, observedAt: now });
    this.recalculate(now);
  }

  level(peerId: string): number {
    return this.observations.get(peerId)?.level || 0;
  }

  remove(trackId: string): void {
    const monitor = this.monitors.get(trackId);
    if (!monitor) return;
    monitor.source.disconnect();
    monitor.analyser.disconnect();
    this.monitors.delete(trackId);
    if (![...this.monitors.values()].some((item) => item.peerId === monitor.peerId)) {
      this.observations.delete(monitor.peerId);
    }
    this.recalculate(Date.now());
    if (this.monitors.size === 0 && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  removePeer(peerId: string): void {
    for (const [trackId, monitor] of this.monitors) if (monitor.peerId === peerId) this.remove(trackId);
    this.observations.delete(peerId);
    this.recalculate(Date.now());
  }

  close(): void {
    for (const trackId of [...this.monitors.keys()]) this.remove(trackId);
    this.observations.clear();
    this.activePeerIds.set([]);
    if (this.context) void this.context.close().catch(() => undefined);
    this.context = null;
  }

  private ensureTimer(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.sample(), 200);
  }

  private sample(): void {
    const now = Date.now();
    for (const monitor of this.monitors.values()) {
      monitor.analyser.getByteTimeDomainData(monitor.samples);
      let sum = 0;
      for (const sample of monitor.samples) {
        const centered = (sample - 128) / 128;
        sum += centered * centered;
      }
      this.acceptPeerLevel(monitor.peerId, Math.min(1, Math.sqrt(sum / monitor.samples.length) * 4), now);
    }
  }

  private recalculate(now: number): void {
    this.activePeerIds.set(selectActiveSpeakers(
      [...this.observations.values()],
      this.activePeerIds(),
      now,
      this.limit,
    ));
  }
}
