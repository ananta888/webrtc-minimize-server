import { LocalMediaView } from "./media-publication.service";
import { RemoteMediaView } from "./peer-mesh.service";

export type StageViewPreference = "auto" | "stage" | "grid";

export interface StageMediaItem {
  readonly id: string;
  readonly peerId: string;
  readonly peerName: string;
  readonly source: "camera" | "screen";
  readonly kind: "video";
  readonly stream: MediaStream;
  readonly isLocal: boolean;
  readonly isScreen: boolean;
  readonly isPresenter: boolean;
  readonly isPinned: boolean;
  readonly key?: string;
  readonly transportPeerId?: string;
}

export interface StageLayoutResult {
  readonly mode: "empty" | "stage" | "grid";
  readonly stageItem: StageMediaItem | null;
  readonly filmstripItems: readonly StageMediaItem[];
  readonly allVideoItems: readonly StageMediaItem[];
  readonly activePin: string;
  readonly activePresenter: string;
  readonly hasScreenShare: boolean;
}

export interface StageLayoutOptions {
  readonly localPublications: readonly LocalMediaView[];
  readonly remoteMedia: readonly RemoteMediaView[];
  readonly ownPeerId: string;
  readonly ownPeerName?: string;
  readonly presenterPeerId?: string;
  readonly localPinPeerId?: string;
  readonly activeSpeakerIds?: readonly string[];
  readonly preferredView?: StageViewPreference;
}

function toStageItems(options: StageLayoutOptions): StageMediaItem[] {
  const items: StageMediaItem[] = [];
  const ownId = options.ownPeerId || "local";
  const ownName = options.ownPeerName || "Du";
  const presenter = options.presenterPeerId || "";
  const pin = options.localPinPeerId || "";

  // Process local publications (only video: camera or screen)
  for (const pub of options.localPublications || []) {
    if (!pub || pub.kind !== "video" || !pub.stream) continue;
    if (pub.source !== "camera" && pub.source !== "screen") continue;
    items.push({
      id: "local:" + pub.source,
      peerId: ownId,
      peerName: ownName,
      source: pub.source,
      kind: "video",
      stream: pub.stream,
      isLocal: true,
      isScreen: pub.source === "screen",
      isPresenter: ownId !== "" && ownId === presenter,
      isPinned: ownId !== "" && ownId === pin,
    });
  }

  // Process remote publications (only video: camera or screen)
  for (const remote of options.remoteMedia || []) {
    if (!remote || remote.kind !== "video" || !remote.stream) continue;
    if (remote.source !== "camera" && remote.source !== "screen") continue;
    items.push({
      id: remote.key || ("remote:" + remote.peerId + ":" + remote.source),
      peerId: remote.peerId,
      peerName: remote.peerName || "Peer",
      source: remote.source,
      kind: "video",
      stream: remote.stream,
      isLocal: false,
      isScreen: remote.source === "screen",
      isPresenter: remote.peerId !== "" && remote.peerId === presenter,
      isPinned: remote.peerId !== "" && remote.peerId === pin,
      key: remote.key,
      transportPeerId: remote.transportPeerId,
    });
  }

  return items;
}

export function computeStageLayout(options: StageLayoutOptions): StageLayoutResult {
  const allItems = toStageItems(options);
  const pin = options.localPinPeerId || "";
  const presenter = options.presenterPeerId || "";
  const activeSpeakers = new Set(options.activeSpeakerIds || []);
  const preference = options.preferredView || "auto";

  if (allItems.length === 0) {
    return {
      mode: "empty",
      stageItem: null,
      filmstripItems: [],
      allVideoItems: [],
      activePin: pin,
      activePresenter: presenter,
      hasScreenShare: false,
    };
  }

  const hasScreenShare = allItems.some((item) => item.isScreen);

  // If explicit grid preferred and no pin/screen forces stage
  if (preference === "grid" && !hasScreenShare && pin === "") {
    return {
      mode: "grid",
      stageItem: null,
      filmstripItems: [],
      allVideoItems: Object.freeze([...allItems]),
      activePin: pin,
      activePresenter: presenter,
      hasScreenShare: false,
    };
  }

  // Stage selection priority:
  // 1. Local Pin
  // 2. Active Screen Share (screen-first)
  // 3. Server Presenter
  // 4. Active Speaker
  // 5. First item
  let selectedStageItem: StageMediaItem | null = null;

  if (pin !== "") {
    // Check if pinned peer has screen or camera
    selectedStageItem = allItems.find((i) => i.peerId === pin && i.isScreen)
      || allItems.find((i) => i.peerId === pin)
      || null;
  }

  if (!selectedStageItem && hasScreenShare) {
    // Prioritize presenter screen if available, else first screen
    selectedStageItem = allItems.find((i) => i.isScreen && i.isPresenter)
      || allItems.find((i) => i.isScreen)
      || null;
  }

  if (!selectedStageItem && presenter !== "") {
    selectedStageItem = allItems.find((i) => i.isPresenter) || null;
  }

  if (!selectedStageItem && activeSpeakers.size > 0) {
    selectedStageItem = allItems.find((i) => activeSpeakers.has(i.peerId)) || null;
  }

  if (!selectedStageItem) {
    selectedStageItem = allItems[0];
  }

  // If auto and no pin, presenter or screen, grid is standard unless stage explicitly requested
  const isNaturalGrid = preference === "auto" && !hasScreenShare && pin === "" && presenter === "";
  if (isNaturalGrid) {
    return {
      mode: "grid",
      stageItem: null,
      filmstripItems: [],
      allVideoItems: Object.freeze([...allItems]),
      activePin: pin,
      activePresenter: presenter,
      hasScreenShare: false,
    };
  }

  // Filmstrip contains all items except the stage item
  const filmstripItems = allItems.filter((i) => i.id !== selectedStageItem!.id);

  // Sort filmstrip: screens first, then presenter, then active speakers, then by peerName
  filmstripItems.sort((a, b) => {
    if (a.isScreen !== b.isScreen) return a.isScreen ? -1 : 1;
    if (a.isPresenter !== b.isPresenter) return a.isPresenter ? -1 : 1;
    const aSpeaker = activeSpeakers.has(a.peerId);
    const bSpeaker = activeSpeakers.has(b.peerId);
    if (aSpeaker !== bSpeaker) return aSpeaker ? -1 : 1;
    return a.peerName.localeCompare(b.peerName);
  });

  return {
    mode: "stage",
    stageItem: selectedStageItem,
    filmstripItems: Object.freeze(filmstripItems),
    allVideoItems: Object.freeze([...allItems]),
    activePin: pin,
    activePresenter: presenter,
    hasScreenShare,
  };
}
