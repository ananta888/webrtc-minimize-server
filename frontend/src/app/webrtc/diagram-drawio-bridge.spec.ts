import { describe, expect, it } from "vitest";

import {
  DRAWIO_EMBED_URL,
  drawioConfigureMessage,
  drawioLoadMessage,
  encodeDrawioAction,
  parseDrawioEvent,
} from "./diagram-drawio-bridge";

describe("drawio embed bridge", () => {
  it("builds a locked-down same-origin embed URL", () => {
    expect(DRAWIO_EMBED_URL.startsWith("/drawio/index.html?")).toBe(true);
    for (const marker of [
      "embed=1", "proto=json", "lang=de", "math=0", "libraries=0",
      "gapi=0", "od=0", "ms365=0", "gh=0", "gl=0", "stealth=1", "lockdown=1",
    ]) {
      expect(DRAWIO_EMBED_URL).toContain(marker);
    }
  });

  it("parses the handshake and save events and keeps the XML", () => {
    expect(parseDrawioEvent({ event: "init", enabled: 1 })).toEqual({ event: "init" });
    expect(parseDrawioEvent(JSON.stringify({ event: "init" }))).toEqual({ event: "init" });
    expect(parseDrawioEvent(JSON.stringify({ event: "configure" }))).toEqual({ event: "configure" });
    expect(parseDrawioEvent(JSON.stringify({ event: "autosave", xml: "<mxfile/>", extra: true })))
      .toEqual({ event: "autosave", xml: "<mxfile/>" });
    expect(parseDrawioEvent({ event: "save", xml: "" })).toEqual({ event: "save", xml: "" });
  });

  it("fails closed on unknown events and malformed payloads", () => {
    expect(parseDrawioEvent(null)).toBeNull();
    expect(parseDrawioEvent("init")).toBeNull();
    expect(parseDrawioEvent("{not json")).toBeNull();
    expect(parseDrawioEvent({ event: "execute" })).toBeNull();
    expect(parseDrawioEvent(JSON.stringify({ event: "autosave" }))).toBeNull();
    expect(parseDrawioEvent({ event: "autosave", xml: 5 })).toBeNull();
    expect(parseDrawioEvent({ event: "save", xml: "x".repeat(256 * 1024 + 1) })).toBeNull();
    expect(parseDrawioEvent({})).toBeNull();
  });

  it("builds the host replies for load and configure as JSON strings", () => {
    expect(drawioLoadMessage("<mxfile/>")).toEqual({ action: "load", xml: "<mxfile/>", autosave: 1 });
    expect(drawioConfigureMessage()).toEqual({ action: "configure", config: {} });
    expect(encodeDrawioAction(drawioLoadMessage("<a/>"))).toBe(JSON.stringify({ action: "load", xml: "<a/>", autosave: 1 }));
  });
});
