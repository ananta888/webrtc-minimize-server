import { NgTemplateOutlet } from "@angular/common";
import { ChangeDetectionStrategy, Component, OnChanges, OnDestroy, OnInit, SimpleChanges, input, output, signal } from "@angular/core";

import { BroadcastDirectoryEntry, BroadcastDirectoryService } from "./broadcast-directory.service";
import { BroadcastPlaybackGatewayService } from "./broadcast-playback-gateway.service";
import { BroadcastPlayerComponent } from "./broadcast-player.component";
import { BroadcastViewerWorkflowService } from "./broadcast-viewer-workflow.service";

@Component({
  selector: "app-broadcast-audience",
  standalone: true,
  imports: [BroadcastPlayerComponent, NgTemplateOutlet],
  providers: [BroadcastViewerWorkflowService, BroadcastPlaybackGatewayService],
  templateUrl: "./broadcast-audience.component.html",
  styleUrl: "./broadcast-audience.component.css",
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BroadcastAudienceComponent implements OnInit, OnChanges, OnDestroy {
  readonly enabled = input(false);
  readonly authenticated = input(false);
  readonly loginRequested = output<void>();
  readonly selected = this.viewer.selected;
  readonly manifestUrl = this.viewer.manifestUrl;
  readonly opening = this.viewer.opening;
  readonly openError = this.viewer.errorCode;
  readonly deepLinkProgramId = signal<string | null>(null);
  private destroyed = false;

  constructor(
    readonly directory: BroadcastDirectoryService,
    readonly viewer: BroadcastViewerWorkflowService,
  ) {}

  ngOnInit(): void {
    this.deepLinkProgramId.set(this.directory.programFromUrl(location.href));
    if (this.enabled()) void this.refresh();
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (!this.enabled() || (changes["authenticated"]?.previousValue === true && !this.authenticated())) {
      void this.viewer.close();
    }
  }

  async refresh(): Promise<void> {
    if (!this.enabled()) return;
    try { await this.directory.load(this.authenticated()); } catch {
      // A bounded, non-enumerating state is exposed by the service.
    }
  }

  async open(entry: BroadcastDirectoryEntry): Promise<void> {
    if (!this.enabled() || this.destroyed) return;
    await this.viewer.open(entry, "user-action");
    if (!this.destroyed && this.selected()?.programId === entry.programId) {
      this.deepLinkProgramId.set(entry.programId);
      history.replaceState(null, "", this.directory.deepLink(entry.programId));
    }
  }

  async close(): Promise<void> {
    this.deepLinkProgramId.set(null);
    history.replaceState(null, "", "/?section=broadcast");
    await this.viewer.close();
    if (!this.destroyed) await this.refresh();
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
    this.destroyed = true;
    this.directory.destroy();
    void this.viewer.destroy();
  }
}
