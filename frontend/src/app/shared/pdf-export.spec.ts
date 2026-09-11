import { describe, expect, it } from "vitest";

import { generatePdfFromImages } from "./pdf-export";

describe("pdf-export", () => {
  it("generates a valid single-page PDF 1.4 document", () => {
    const fakeJpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0xff, 0xd9]);
    const pdf = generatePdfFromImages([
      {
        jpegBytes: fakeJpeg,
        width: 640,
        height: 360,
      },
    ]);

    expect(pdf.byteLength).toBeGreaterThan(100);
    const text = new TextDecoder("latin1").decode(pdf);
    expect(text.startsWith("%PDF-1.4")).toBe(true);
    expect(text).toContain("/Type /Catalog");
    expect(text).toContain("/Type /Pages");
    expect(text).toContain("/Count 1");
    expect(text).toContain("/Type /Page");
    expect(text).toContain("/MediaBox [0 0 640 360]");
    expect(text).toContain("/Filter /DCTDecode");
    expect(text).toContain("xref");
    expect(text).toContain("trailer");
    expect(text.trim().endsWith("%%EOF")).toBe(true);
  });

  it("generates a valid multi-page PDF 1.4 document", () => {
    const fakeJpeg1 = new Uint8Array([0xff, 0xd8, 0x01, 0xff, 0xd9]);
    const fakeJpeg2 = new Uint8Array([0xff, 0xd8, 0x02, 0xff, 0xd9]);

    const pdf = generatePdfFromImages([
      { jpegBytes: fakeJpeg1, width: 800, height: 600 },
      { jpegBytes: fakeJpeg2, width: 1024, height: 768 },
    ]);

    const text = new TextDecoder("latin1").decode(pdf);
    expect(text.startsWith("%PDF-1.4")).toBe(true);
    expect(text).toContain("/Count 2");
    expect(text).toContain("/MediaBox [0 0 800 600]");
    expect(text).toContain("/MediaBox [0 0 1024 768]");
    expect(text.trim().endsWith("%%EOF")).toBe(true);
  });

  it("throws when given empty page list", () => {
    expect(() => generatePdfFromImages([])).toThrow("pages_cannot_be_empty");
  });
});
