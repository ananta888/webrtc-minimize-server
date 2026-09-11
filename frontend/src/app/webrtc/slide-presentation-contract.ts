export type SlideAction = "change-slide" | "slide-image-chunk" | "clear-deck";
export type SlideImageMime = "image/jpeg" | "image/png" | "image/webp";

export interface BaseSlideEvent {
  readonly version: 1;
  readonly type: "slide-event";
  readonly opId: string;
  readonly membershipEpoch: number;
  readonly authorPeerId: string;
}

export interface SlideChangeEvent extends BaseSlideEvent {
  readonly action: "change-slide";
  readonly slideIndex: number;
  readonly totalSlides: number;
}

export interface SlideImageChunkEvent extends BaseSlideEvent {
  readonly action: "slide-image-chunk";
  readonly slideIndex: number;
  readonly chunkIndex: number;
  readonly totalChunks: number;
  readonly mimeType: SlideImageMime;
  readonly data: string;
}

export interface SlideClearDeckEvent extends BaseSlideEvent {
  readonly action: "clear-deck";
}

export type SlideEvent = SlideChangeEvent | SlideImageChunkEvent | SlideClearDeckEvent;

const PEER_ID_RE = /^[a-f0-9]{16}$/;
const OP_ID_RE = /^[a-f0-9]{32}$/;
const ACTIONS = new Set<SlideAction>(["change-slide", "slide-image-chunk", "clear-deck"]);
const MIMES = new Set<SlideImageMime>(["image/jpeg", "image/png", "image/webp"]);
const BASE64_RE = /^[A-Za-z0-9+/=]+$/;

export const SLIDE_CONSTANTS = Object.freeze({
  maxSlides: 100,
  maxChunks: 32,
  maxChunkBase64Length: 12_000,
  maxTotalImageBytes: 256 * 1024,
});

function exact(value: unknown, fields: readonly string[]): value is Record<string, unknown> {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value as object).length === fields.length &&
    fields.every((f) => Object.hasOwn(value as object, f))
  );
}

function integer(value: unknown, min: number, max: number): value is number {
  return Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max;
}

export function parseSlideEvent(value: unknown): SlideEvent | null {
  if (
    !Boolean(value) ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (value as Record<string, unknown>)["version"] !== 1 ||
    (value as Record<string, unknown>)["type"] !== "slide-event"
  ) {
    return null;
  }

  const rec = value as Record<string, unknown>;
  if (typeof rec["opId"] !== "string" || !OP_ID_RE.test(rec["opId"])) return null;
  if (!integer(rec["membershipEpoch"], 1, Number.MAX_SAFE_INTEGER)) return null;
  if (typeof rec["authorPeerId"] !== "string" || !PEER_ID_RE.test(rec["authorPeerId"])) return null;
  if (typeof rec["action"] !== "string" || !ACTIONS.has(rec["action"] as SlideAction)) return null;

  const action = rec["action"] as SlideAction;

  if (action === "change-slide") {
    if (!exact(rec, ["version", "type", "opId", "membershipEpoch", "authorPeerId", "action", "slideIndex", "totalSlides"])) {
      return null;
    }
    if (!integer(rec["slideIndex"], 0, SLIDE_CONSTANTS.maxSlides - 1)) return null;
    if (!integer(rec["totalSlides"], 1, SLIDE_CONSTANTS.maxSlides)) return null;
    if ((rec["slideIndex"] as number) >= (rec["totalSlides"] as number)) return null;

    return {
      version: 1,
      type: "slide-event",
      opId: rec["opId"],
      membershipEpoch: rec["membershipEpoch"] as number,
      authorPeerId: rec["authorPeerId"],
      action: "change-slide",
      slideIndex: rec["slideIndex"] as number,
      totalSlides: rec["totalSlides"] as number,
    };
  }

  if (action === "slide-image-chunk") {
    if (
      !exact(rec, [
        "version",
        "type",
        "opId",
        "membershipEpoch",
        "authorPeerId",
        "action",
        "slideIndex",
        "chunkIndex",
        "totalChunks",
        "mimeType",
        "data",
      ])
    ) {
      return null;
    }
    if (!integer(rec["slideIndex"], 0, SLIDE_CONSTANTS.maxSlides - 1)) return null;
    if (!integer(rec["totalChunks"], 1, SLIDE_CONSTANTS.maxChunks)) return null;
    if (!integer(rec["chunkIndex"], 0, (rec["totalChunks"] as number) - 1)) return null;
    if (typeof rec["mimeType"] !== "string" || !MIMES.has(rec["mimeType"] as SlideImageMime)) return null;
    if (
      typeof rec["data"] !== "string" ||
      rec["data"].length < 1 ||
      rec["data"].length > SLIDE_CONSTANTS.maxChunkBase64Length ||
      !BASE64_RE.test(rec["data"])
    ) {
      return null;
    }

    return {
      version: 1,
      type: "slide-event",
      opId: rec["opId"],
      membershipEpoch: rec["membershipEpoch"] as number,
      authorPeerId: rec["authorPeerId"],
      action: "slide-image-chunk",
      slideIndex: rec["slideIndex"] as number,
      chunkIndex: rec["chunkIndex"] as number,
      totalChunks: rec["totalChunks"] as number,
      mimeType: rec["mimeType"] as SlideImageMime,
      data: rec["data"],
    };
  }

  if (action === "clear-deck") {
    if (!exact(rec, ["version", "type", "opId", "membershipEpoch", "authorPeerId", "action"])) {
      return null;
    }
    return {
      version: 1,
      type: "slide-event",
      opId: rec["opId"],
      membershipEpoch: rec["membershipEpoch"] as number,
      authorPeerId: rec["authorPeerId"],
      action: "clear-deck",
    };
  }

  return null;
}

export function decodeSlideEventBytes(data: Uint8Array): SlideEvent | null {
  try {
    return parseSlideEvent(JSON.parse(new TextDecoder().decode(data)));
  } catch {
    return null;
  }
}

export function encodeSlideEvent(event: SlideEvent): Uint8Array {
  const parsed = parseSlideEvent(event);
  if (!parsed) throw new Error("invalid_slide_event");
  return new TextEncoder().encode(JSON.stringify(parsed));
}
