import { NgTemplateOutlet } from "@angular/common";
import { ChangeDetectionStrategy, Component, OnDestroy, OnInit, input, output, signal } from "@angular/core";

import { BroadcastDirectoryEntry, BroadcastDirectoryService } from "./broadcast-directory.service";
import { BroadcastPlaybackGatewayService } from "./broadcast-playback-gateway.service";
import { BroadcastPlayerComponent } from "./broadcast-player.component";

@Component({
  selector: "app-broadcast-audience",
  standalone: true,
  imports: [BroadcastPlayerComponent, NgTemplateOutlet],
  templateUrl: "./broadcast-audience.component.html",
  styleUrl: "./broadcast-audience.component.css",
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BroadcastAudienceComponent implements OnInit, OnDestroy {
  readonly enabled = input(false);
  readonly authenticated = input(false);
  readonly loginRequested = output<void>();
  readonly selected = signal<BroadcastDirectoryEntry | null>(null);
  readonly manifestUrl = signal("");
  readonly opening = signal(false);
  readonly openError = signal("");
  readonly deepLinkProgramId = signal<string | null>(null);
  private controller: AbortController | null = null;

  constructor(
    readonly directory: BroadcastDirectoryService,
    private readonly playbackGateway: BroadcastPlaybackGatewayService,
  ) {}

  ngOnInit(): void {
    this.deepLinkProgramId.set(this.directory.programFromUrl(location.href));
    if (this.enabled()) void this.refresh();
  }

  async refresh(): Promise<void> {
    if (!this.enabled()) return;
    try { await this.directory.load(this.authenticated()); } catch {
      // A bounded, non-enumerating state is exposed by the service.
    }
  }

  async open(entry: BroadcastDirectoryEntry): Promise<void> {
    if (!this.enabled() || this.opening() || !new Set(["live", "degraded"]).has(entry.availability)) return;
    this.controller?.abort(new DOMException("new-program", "AbortError"));
    const controller = new AbortController();
    this.controller = controller;
    this.opening.set(true);
    this.openError.set("");
    try {
      const bootstrap = await this.directory.authorize(entry.programId, controller.signal);
      const session = await this.playbackGateway.open(
        bootstrap.resourceRef,
        bootstrap.playbackGrant,
        controller.signal,
      );
      if (controller.signal.aborted) {
        await this.playbackGateway.close();
        controller.signal.throwIfAborted();
      }
      this.selected.set(bootstrap.program);
      this.manifestUrl.set(session.manifestUrl);
      this.deepLinkProgramId.set(entry.programId);
      history.replaceState(null, "", this.directory.deepLink(entry.programId));
    } catch (error) {
      if (!controller.signal.aborted) {
        this.openError.set(error instanceof Error ? error.message : "broadcast_not_available");
      }
    } finally {
      if (this.controller === controller) this.controller = null;
      this.opening.set(false);
    }
  }

  async close(): Promise<void> {
    this.controller?.abort(new DOMException("close", "AbortError"));
    this.controller = null;
    try { await this.playbackGateway.close(); } catch (error) {
      this.openError.set(error instanceof Error ? error.message : "broadcast_playback_close_failed");
    }
    this.selected.set(null);
    this.manifestUrl.set("");
    this.deepLinkProgramId.set(null);
    history.replaceState(null, "", "/?section=broadcast");
    await this.refresh();
  }

  owner(entry: BroadcastDirectoryEntry): string {
    return entry.ownerVisibility === "shown" ? entry.ownerLabel || "Nicht angegeben" : "Nicht veröffentlicht";
  }

  availability(entry: BroadcastDirectoryEntry): string {
    return ({ live: "Live", degraded: "Live · eingeschränkt", ended: "Beendet", offline: "Nicht erreichbar" })[entry.availability];
  }

  latency(entry: BroadcastDirectoryEntry): string {
    return ({ "ll-hls": "Niedrige Latenz", "standard-hls": "Stabil", "moq-experimental": "MoQ experimentell" })[entry.latencyMode];
  }

  ngOnDestroy(): void {
    this.controller?.abort(new DOMException("destroy", "AbortError"));
    this.directory.destroy();
    void this.playbackGateway.close();
  }
}
