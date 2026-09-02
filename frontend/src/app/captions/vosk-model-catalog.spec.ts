import { describe, expect, it } from "vitest";

import {
  DEFAULT_VOSK_MODEL_ID,
  VOSK_BROWSER_MODELS,
  VOSK_BROWSER_SOURCE_REVISION,
  findVoskModel,
  formatModelSize,
} from "./vosk-model-catalog";

describe("Vosk browser model catalog", () => {
  it("offers a stable allowlist of directly loadable browser archives", () => {
    expect(VOSK_BROWSER_MODELS).toHaveLength(13);
    expect(new Set(VOSK_BROWSER_MODELS.map((model) => model.id)).size).toBe(13);
    for (const model of VOSK_BROWSER_MODELS) {
      expect(model.sourceUrl).toContain(`/ccoreilly/vosk-browser/${VOSK_BROWSER_SOURCE_REVISION}/models/`);
      expect(model.sourceUrl.endsWith(".tar.gz")).toBe(true);
      expect(model.sizeBytes).toBeGreaterThan(30_000_000);
      expect(model.sizeBytes).toBeLessThan(50_000_000);
      expect(model.languageTag).toMatch(/^[a-z]{2}-[A-Z]{2}$/);
    }
  });

  it("defaults to German and rejects arbitrary model identifiers", () => {
    expect(findVoskModel(DEFAULT_VOSK_MODEL_ID)?.languageTag).toBe("de-DE");
    expect(findVoskModel("https://attacker.invalid/model.tar.gz")).toBeNull();
    expect(findVoskModel({ id: DEFAULT_VOSK_MODEL_ID })).toBeNull();
  });

  it("formats decimal download sizes for the German UI", () => {
    expect(formatModelSize(46_476_437)).toBe("46,5 MB");
  });
});
