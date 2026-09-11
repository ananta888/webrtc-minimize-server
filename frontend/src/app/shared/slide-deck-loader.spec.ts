import { describe, expect, it } from "vitest";

import {
  detectImageMime,
  extractJpegsFromPdf,
  isAllowedFileType,
  loadSlidesFromFiles,
  MAX_IMAGE_FILE_SIZE,
} from "./slide-deck-loader";

describe("slide-deck-loader", () => {
  it("checks allowed file types and extensions", () => {
    expect(isAllowedFileType({ type: "image/png", name: "slide.png" })).toBe(true);
    expect(isAllowedFileType({ type: "image/jpeg", name: "slide.jpg" })).toBe(true);
    expect(isAllowedFileType({ type: "image/webp", name: "slide.webp" })).toBe(true);
    expect(isAllowedFileType({ type: "application/pdf", name: "deck.pdf" })).toBe(true);
    expect(isAllowedFileType({ type: "image/svg+xml", name: "vector.svg" })).toBe(false);
    expect(isAllowedFileType({ type: "text/html", name: "page.html" })).toBe(false);
    expect(isAllowedFileType({ type: "application/javascript", name: "script.js" })).toBe(false);
  });

  it("detects image MIME from magic numbers", () => {
    const pngMagic = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
    expect(detectImageMime(pngMagic)).toBe("image/png");

    const jpegMagic = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
    expect(detectImageMime(jpegMagic)).toBe("image/jpeg");

    const webpMagic = new Uint8Array([
      0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
    ]);
    expect(detectImageMime(webpMagic)).toBe("image/webp");

    const invalid = new Uint8Array([0x00, 0x01, 0x02, 0x03]);
    expect(detectImageMime(invalid)).toBe(null);
  });

  it("extracts embedded JPEGs from PDF streams", () => {
    // Construct fake PDF containing a 1.2KB JPEG
    const jpegBody = new Uint8Array(1200);
    jpegBody[0] = 0xff;
    jpegBody[1] = 0xd8;
    jpegBody[2] = 0xff;
    jpegBody[1198] = 0xff;
    jpegBody[1199] = 0xd9;

    const pdfHeader = new TextEncoder().encode("%PDF-1.4\nstream\n");
    const pdfFooter = new TextEncoder().encode("\nendstream\n%%EOF");

    const fullPdf = new Uint8Array(pdfHeader.length + jpegBody.length + pdfFooter.length);
    fullPdf.set(pdfHeader, 0);
    fullPdf.set(jpegBody, pdfHeader.length);
    fullPdf.set(pdfFooter, pdfHeader.length + jpegBody.length);

    const extracted = extractJpegsFromPdf(fullPdf);
    expect(extracted.length).toBe(1);
    expect(extracted[0].length).toBe(1200);
    expect(extracted[0][0]).toBe(0xff);
    expect(extracted[0][1]).toBe(0xd8);
    expect(extracted[0][1198]).toBe(0xff);
    expect(extracted[0][1199]).toBe(0xd9);
  });

  it("rejects files exceeding MAX_IMAGE_FILE_SIZE (2MB)", async () => {
    const oversizedFile = {
      name: "big.png",
      type: "image/png",
      size: MAX_IMAGE_FILE_SIZE + 100,
      arrayBuffer: async () => new ArrayBuffer(0),
    } as unknown as File;

    const result = await loadSlidesFromFiles([oversizedFile]);
    expect(result.success).toBe(false);
    expect(result.error).toContain("überschreitet das Limit von 2 MB");
  });

  it("loads valid PNG file into LoadedSlide", async () => {
    const validPng = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
      0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
      0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
      0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41,
      0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
      0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00,
      0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
      0x42, 0x60, 0x82,
    ]);

    const file = {
      name: "slide1.png",
      type: "image/png",
      size: validPng.byteLength,
      arrayBuffer: async () => validPng.buffer,
    } as unknown as File;

    const result = await loadSlidesFromFiles([file]);
    expect(result.success).toBe(true);
    expect(result.slides.length).toBe(1);
    expect(result.slides[0].name).toBe("slide1.png");
    expect(result.slides[0].mimeType).toBe("image/png");
    expect(result.slides[0].dataUrl.startsWith("data:image/png;base64,")).toBe(true);
  });
});
