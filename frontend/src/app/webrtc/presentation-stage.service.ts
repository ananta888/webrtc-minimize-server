import { Injectable, computed, signal } from "@angular/core";
import { MediaPublicationService } from "./media-publication.service";
import { PeerMeshService } from "./peer-mesh.service";
import { RoomModerationService } from "./room-moderation.service";
import { RoomSessionService } from "./room-session.service";
import {
  computeStageLayout,
  StageLayoutOptions,
  StageLayoutResult,
  StageMediaItem,
  StageViewPreference,
} from "./stage-layout";

@Injectable({ providedIn: "root" })
export class PresentationStageService {
  readonly localPin = signal<string>("");
  readonly viewPreference = signal<StageViewPreference>("auto");
  readonly isFullscreen = signal<boolean>(false);

  readonly stageLayout = computed<StageLayoutResult>(() => {
    const options: StageLayoutOptions = {
      localPublications: this.media.publications(),
      remoteMedia: typeof this.mesh.focusRemoteMedia === "function" ? this.mesh.focusRemoteMedia() : this.mesh.remoteMedia(),
      ownPeerId: this.session.peerId(),
      ownPeerName: this.session.displayName(),
      presenterPeerId: this.moderation.presenterPeerId(),
      localPinPeerId: this.localPin(),
      activeSpeakerIds: this.mesh.activeSpeakerIds(),
      preferredView: this.viewPreference(),
    };
    return computeStageLayout(options);
  });

  readonly mode = computed(() => this.stageLayout().mode);
  readonly stageItem = computed(() => this.stageLayout().stageItem);
  readonly filmstripItems = computed(() => this.stageLayout().filmstripItems);
  readonly allVideoItems = computed(() => this.stageLayout().allVideoItems);
  readonly hasScreenShare = computed(() => this.stageLayout().hasScreenShare);

  constructor(
    private readonly media: MediaPublicationService,
    private readonly mesh: PeerMeshService,
    private readonly moderation: RoomModerationService,
    private readonly session: RoomSessionService,
  ) {}

  togglePin(peerId: string): void {
    const current = this.localPin();
    this.localPin.set(current === peerId ? "" : peerId);
  }

  clearPin(): void {
    this.localPin.set("");
  }

  setViewPreference(preference: StageViewPreference): void {
    this.viewPreference.set(preference);
  }

  toggleViewPreference(): void {
    const current = this.viewPreference();
    if (current === "grid") {
      this.viewPreference.set("stage");
    } else if (current === "stage") {
      this.viewPreference.set("grid");
    } else {
      const resolved = this.mode();
      this.viewPreference.set(resolved === "stage" ? "grid" : "stage");
    }
  }

  setFullscreen(active: boolean): void {
    this.isFullscreen.set(active);
  }

  reset(): void {
    this.localPin.set("");
    this.viewPreference.set("auto");
    this.isFullscreen.set(false);
  }
}
