export interface LoadedSlide {
  readonly id: string;
  readonly name: string;
  readonly dataUrl: string;
  readonly mimeType: "image/png" | "image/jpeg" | "image/webp";
  readonly width: number;
  readonly height: number;
}

export interface DeckLoadResult {
  readonly success: boolean;
  readonly slides: readonly LoadedSlide[];
  readonly error?: string;
}

export const MAX_IMAGE_FILE_SIZE = 2 * 1024 * 1024; // 2 MB
export const MAX_SLIDES_PER_DECK = 50;

const ALLOWED_MIMES = new Set(["image/png", "image/jpeg", "image/webp", "application/pdf"]);

export function isAllowedFileType(file: { type: string; name: string }): boolean {
  if (ALLOWED_MIMES.has(file.type)) return true;
  const ext = file.name.split(".").pop()?.toLowerCase();
  return ext === "png" || ext === "jpg" || ext === "jpeg" || ext === "webp" || ext === "pdf";
}

export function detectImageMime(bytes: Uint8Array): "image/png" | "image/jpeg" | "image/webp" | null {
  if (bytes.length < 3) return null;
  // JPEG: FF D8 FF
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  // WebP: RIFF ... WEBP
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  return null;
}

export function parseImageDimensions(
  bytes: Uint8Array,
  mime: "image/png" | "image/jpeg" | "image/webp",
): { width: number; height: number } {
  if (mime === "image/png" && bytes.length >= 24) {
    const width = ((bytes[16] << 24) | (bytes[17] << 16) | (bytes[18] << 8) | bytes[19]) >>> 0;
    const height = ((bytes[20] << 24) | (bytes[21] << 16) | (bytes[22] << 8) | bytes[23]) >>> 0;
    if (width > 0 && height > 0 && width <= 10_000 && height <= 10_000) {
      return { width, height };
    }
  }
  if (mime === "image/jpeg" && bytes.length >= 10) {
    let i = 2;
    while (i < bytes.length - 8) {
      if (bytes[i] === 0xff) {
        const marker = bytes[i + 1];
        if (marker === 0xc0 || marker === 0xc2) {
          // SOF0 or SOF2
          const height = (bytes[i + 5] << 8) | bytes[i + 6];
          const width = (bytes[i + 7] << 8) | bytes[i + 8];
          if (width > 0 && height > 0) return { width, height };
        }
        const len = (bytes[i + 2] << 8) | bytes[i + 3];
        if (len > 0) {
          i += 2 + len;
          continue;
        }
      }
      i++;
    }
  }
  return { width: 1280, height: 720 };
}

export function extractJpegsFromPdf(bytes: Uint8Array): Uint8Array[] {
  // Verify PDF header
  const header = new TextDecoder("latin1").decode(bytes.slice(0, 10));
  if (!header.startsWith("%PDF-")) {
    return [];
  }

  const results: Uint8Array[] = [];
  let i = 0;
  while (i < bytes.length - 4 && results.length < MAX_SLIDES_PER_DECK) {
    // Look for JPEG SOI: 0xFF, 0xD8, 0xFF
    if (bytes[i] === 0xff && bytes[i + 1] === 0xd8 && bytes[i + 2] === 0xff) {
      const startIndex = i;
      let j = startIndex + 2;
      let foundEnd = false;
      while (j < bytes.length - 1) {
        // Look for JPEG EOI: 0xFF, 0xD9
        if (bytes[j] === 0xff && bytes[j + 1] === 0xd9) {
          const length = j + 2 - startIndex;
          // Must be at least 1KB to filter out tiny icon fragments
          if (length >= 1024 && length <= MAX_IMAGE_FILE_SIZE) {
            results.push(bytes.slice(startIndex, j + 2));
          }
          foundEnd = true;
          i = j + 1;
          break;
        }
        j++;
      }
      if (!foundEnd) {
        i++;
      }
    } else {
      i++;
    }
  }
  return results;
}

export function bytesToDataUrl(bytes: Uint8Array, mime: string): string {
  let binary = "";
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return `data:${mime};base64,${btoa(binary)}`;
}

export async function loadSlideFromImageBytes(
  name: string,
  bytes: Uint8Array,
  mime: "image/png" | "image/jpeg" | "image/webp",
  slideIndex: number,
): Promise<LoadedSlide> {
  const dataUrl = bytesToDataUrl(bytes, mime);
  const id = `slide-${slideIndex}-${Date.now().toString(16)}`;
  const { width, height } = parseImageDimensions(bytes, mime);

  return {
    id,
    name,
    dataUrl,
    mimeType: mime,
    width,
    height,
  };
}

export async function loadSlidesFromFiles(files: readonly File[]): Promise<DeckLoadResult> {
  if (!files || files.length === 0) {
    return { success: false, slides: [], error: "Keine Dateien ausgewählt." };
  }

  const slides: LoadedSlide[] = [];

  for (let i = 0; i < files.length; i++) {
    if (slides.length >= MAX_SLIDES_PER_DECK) break;
    const file = files[i];

    if (!isAllowedFileType(file)) {
      return {
        success: false,
        slides: [],
        error: `Dateityp von "${file.name}" wird nicht unterstützt. Erlaubt sind PNG, JPEG, WebP oder PDF.`,
      };
    }

    if (file.size > MAX_IMAGE_FILE_SIZE) {
      return {
        success: false,
        slides: [],
        error: `Datei "${file.name}" überschreitet das Limit von 2 MB (${(file.size / 1024 / 1024).toFixed(1)} MB).`,
      };
    }

    const buffer = await file.arrayBuffer();
    const bytes = new Uint8Array(buffer);

    // Is it PDF?
    const header = new TextDecoder("latin1").decode(bytes.slice(0, 5));
    if (header === "%PDF-") {
      const jpegs = extractJpegsFromPdf(bytes);
      if (jpegs.length === 0) {
        return {
          success: false,
          slides: [],
          error: `PDF "${file.name}" enthält keine rasterisierten Folien. Bitte Folien als PNG/JPEG exportieren.`,
        };
      }
      for (let p = 0; p < jpegs.length && slides.length < MAX_SLIDES_PER_DECK; p++) {
        const slide = await loadSlideFromImageBytes(
          `${file.name} (Seite ${p + 1})`,
          jpegs[p],
          "image/jpeg",
          slides.length,
        );
        slides.push(slide);
      }
      continue;
    }

    // Raster Image
    const detectedMime = detectImageMime(bytes);
    if (!detectedMime) {
      return {
        success: false,
        slides: [],
        error: `Datei "${file.name}" ist kein gültiges Bild (PNG, JPEG, WebP) oder enthält ungültige Header.`,
      };
    }

    const slide = await loadSlideFromImageBytes(file.name, bytes, detectedMime, slides.length);
    slides.push(slide);
  }

  return { success: true, slides: Object.freeze(slides) };
}
