import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnDestroy,
  input,
  output,
  signal,
  viewChild,
} from "@angular/core";

import { BroadcastHlsPlayer, BroadcastPlayerSnapshot } from "./broadcast-hls-player";

@Component({
  selector: "app-broadcast-player",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: "./broadcast-player.component.html",
  styleUrl: "./broadcast-player.component.css",
})
export class BroadcastPlayerComponent implements OnDestroy {
  readonly manifestUrl = input.required<string>();
  readonly title = input("Live-Broadcast");
  readonly closed = output<void>();
  readonly video = viewChild.required<ElementRef<HTMLVideoElement>>("video");
  readonly state = signal<BroadcastPlayerSnapshot>(new BroadcastHlsPlayer().snapshot());
  readonly muted = signal(true);
  readonly volume = signal(1);
  private controller: AbortController | null = null;
  private readonly player = new BroadcastHlsPlayer((state) => this.state.set(state));
  private readonly visibilityListener = () => {
    if (document.visibilityState === "hidden") void this.stop(false);
  };

  constructor() {
    document.addEventListener("visibilitychange", this.visibilityListener);
  }

  async start(): Promise<void> {
    if (this.state().lifecycle !== "idle") return;
    this.controller = new AbortController();
    try {
      await this.player.open(this.video().nativeElement, this.manifestUrl(), {
        muted: this.muted(), volume: this.volume(),
      }, this.controller.signal);
    } catch {
      // The player exposes only its bounded public error code in state.
    }
  }

  async continuePlayback(): Promise<void> {
    try {
      await this.player.play();
    } catch {
      // The player publishes a sanitized failure state.
    }
  }

  setMuted(value: boolean): void {
    this.muted.set(value);
    this.player.setMuted(value);
  }

  setVolume(value: string): void {
    const normalized = Math.max(0, Math.min(1, Number(value)));
    this.volume.set(normalized);
    this.player.setVolume(normalized);
  }

  setQuality(value: string): void {
    this.player.selectQuality(value === "auto" ? "auto" : Number(value));
  }

  async fullscreen(): Promise<void> {
    const element = this.video().nativeElement;
    if (element.requestFullscreen) await element.requestFullscreen();
  }

  async pictureInPicture(): Promise<void> {
    const element = this.video().nativeElement;
    if (document.pictureInPictureEnabled && element.requestPictureInPicture) {
      await element.requestPictureInPicture();
    }
  }

  async stop(emit = true): Promise<void> {
    this.controller?.abort(new DOMException("stop", "AbortError"));
    this.controller = null;
    await this.player.destroy();
    if (emit) this.closed.emit();
  }

  formatBitrate(value: number): string {
    return value >= 1_000_000 ? `${(value / 1_000_000).toFixed(1)} Mbit/s` : `${Math.round(value / 1_000)} kbit/s`;
  }

  ngOnDestroy(): void {
    document.removeEventListener("visibilitychange", this.visibilityListener);
    this.controller?.abort(new DOMException("destroy", "AbortError"));
    void this.player.destroy();
  }
}
