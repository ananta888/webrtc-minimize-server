import { Injectable, computed, effect, signal } from "@angular/core";

import { AudioActivityService } from "./audio-activity.service";
import { MediaPublicationService } from "./media-publication.service";
import { MediaStrategyService } from "./media-strategy.service";

/**
 * Optional echo guard that ducks the local microphone when remote audio is
 * actively playing. This prevents acoustic echo by construction: if the mic
 * is disabled while the speaker is loud, the speaker output cannot loop back.
 *
 * Default-off. The user must opt in via the settings panel. The guard
 * automatically disengages when AEC is confirmed active (echoCancellation=true),
 * because in that case the browser already handles echo suppression.
 *
 * Trade-off: double-talk (both sides speaking simultaneously) becomes harder
 * while the guard is active. This is an intentional half-duplex fallback for
 * environments where browser AEC is insufficient.
 */
@Injectable({ providedIn: "root" })
export class EchoGuardService {
  /** Whether the user has opted into echo-guard ducking. */
  readonly enabled = signal(false);

  /** Whether the guard is currently ducking the microphone. */
  readonly ducking = signal(false);

  /**
   * Whether the guard can operate: requires mic active, AEC not confirmed,
   * and at least one remote peer.
   */
  readonly available = computed(() => {
    return this.media.active("microphone") && !this.aecActive();
  });

  private readonly aecActive = computed(() => {
    return !this.mediaStrategy.aecMissing();
  });

  constructor(
    private readonly activity: AudioActivityService,
    private readonly media: MediaPublicationService,
    private readonly mediaStrategy: MediaStrategyService,
  ) {
    effect(() => {
      const shouldDuck = this.enabled()
        && this.available()
        && this.remoteSpeaking();

      if (shouldDuck === this.ducking()) return;
      this.ducking.set(shouldDuck);
      this.applyDucking(shouldDuck);
    });
  }

  toggle(): void {
    this.enabled.update(value => !value);
  }

  private remoteSpeaking(): boolean {
    const activeIds = this.activity.activePeerIds();
    return activeIds.length > 0;
  }

  private applyDucking(duck: boolean): void {
    const track = this.media.microphoneTrack();
    if (!track) return;
    track.enabled = !duck;
  }
}
