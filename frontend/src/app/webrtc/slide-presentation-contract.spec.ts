import { describe, expect, it } from "vitest";

import {
  decodeSlideEventBytes,
  encodeSlideEvent,
  parseSlideEvent,
  SLIDE_CONSTANTS,
  SlideChangeEvent,
  SlideImageChunkEvent,
} from "./slide-presentation-contract";

describe("slide-presentation-contract", () => {
  it("parses and encodes valid change-slide event", () => {
    const event: SlideChangeEvent = {
      version: 1,
      type: "slide-event",
      opId: "a".repeat(32),
      membershipEpoch: 2,
      authorPeerId: "1234567890abcdef",
      action: "change-slide",
      slideIndex: 3,
      totalSlides: 10,
    };

    const parsed = parseSlideEvent(event);
    expect(parsed).toEqual(event);

    const encoded = encodeSlideEvent(event);
    const decoded = decodeSlideEventBytes(encoded);
    expect(decoded).toEqual(event);
  });

  it("parses and encodes valid slide-image-chunk event", () => {
    const event: SlideImageChunkEvent = {
      version: 1,
      type: "slide-event",
      opId: "b".repeat(32),
      membershipEpoch: 3,
      authorPeerId: "abcdef0123456789",
      action: "slide-image-chunk",
      slideIndex: 1,
      chunkIndex: 0,
      totalChunks: 4,
      mimeType: "image/jpeg",
      data: Buffer.from("fake-jpeg-data").toString("base64"),
    };

    const parsed = parseSlideEvent(event);
    expect(parsed).toEqual(event);

    const encoded = encodeSlideEvent(event);
    const decoded = decodeSlideEventBytes(encoded);
    expect(decoded).toEqual(event);
  });

  it("fails closed on invalid slide event", () => {
    // Missing required fields
    expect(parseSlideEvent(null)).toBe(null);
    expect(parseSlideEvent({})).toBe(null);
    expect(parseSlideEvent({ version: 2, type: "slide-event" })).toBe(null);

    // Invalid opId or peerId
    expect(
      parseSlideEvent({
        version: 1,
        type: "slide-event",
        opId: "short",
        membershipEpoch: 1,
        authorPeerId: "1234567890abcdef",
        action: "change-slide",
        slideIndex: 0,
        totalSlides: 1,
      }),
    ).toBe(null);

    // SlideIndex >= totalSlides
    expect(
      parseSlideEvent({
        version: 1,
        type: "slide-event",
        opId: "c".repeat(32),
        membershipEpoch: 1,
        authorPeerId: "1234567890abcdef",
        action: "change-slide",
        slideIndex: 5,
        totalSlides: 5,
      }),
    ).toBe(null);

    // ChunkIndex >= totalChunks
    expect(
      parseSlideEvent({
        version: 1,
        type: "slide-event",
        opId: "c".repeat(32),
        membershipEpoch: 1,
        authorPeerId: "1234567890abcdef",
        action: "slide-image-chunk",
        slideIndex: 0,
        chunkIndex: 2,
        totalChunks: 2,
        mimeType: "image/png",
        data: "AAAA",
      }),
    ).toBe(null);

    // Exceeding bounds
    expect(
      parseSlideEvent({
        version: 1,
        type: "slide-event",
        opId: "d".repeat(32),
        membershipEpoch: 1,
        authorPeerId: "1234567890abcdef",
        action: "change-slide",
        slideIndex: 0,
        totalSlides: SLIDE_CONSTANTS.maxSlides + 1,
      }),
    ).toBe(null);
  });
});
