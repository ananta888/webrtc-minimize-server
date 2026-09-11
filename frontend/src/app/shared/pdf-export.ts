export interface PageImageInput {
  readonly jpegBytes: Uint8Array;
  readonly width: number;
  readonly height: number;
}

export function generatePdfFromImages(pages: readonly PageImageInput[]): Uint8Array {
  if (!pages || pages.length === 0) {
    throw new Error("pages_cannot_be_empty");
  }

  const chunks: Uint8Array[] = [];
  let currentOffset = 0;

  function writeAscii(str: string): void {
    const bytes = new TextEncoder().encode(str);
    chunks.push(bytes);
    currentOffset += bytes.byteLength;
  }

  function writeBytes(bytes: Uint8Array): void {
    chunks.push(bytes);
    currentOffset += bytes.byteLength;
  }

  // Header
  writeAscii("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n");

  const offsets: number[] = [0]; // obj 0 is dummy
  const pageCount = pages.length;
  // Obj 1: Catalog
  // Obj 2: Pages
  // Per page: PageObj (3 + i*3), ImageObj (4 + i*3), ContentObj (5 + i*3)
  const totalObjs = 2 + pageCount * 3;

  // Obj 1: Catalog
  offsets.push(currentOffset);
  writeAscii("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");

  // Obj 2: Pages
  offsets.push(currentOffset);
  const kids = Array.from({ length: pageCount }, (_, i) => `${3 + i * 3} 0 R`).join(" ");
  writeAscii(`2 0 obj\n<< /Type /Pages /Kids [${kids}] /Count ${pageCount} >>\nendobj\n`);

  for (let i = 0; i < pageCount; i++) {
    const page = pages[i];
    const pageObjId = 3 + i * 3;
    const imgObjId = 4 + i * 3;
    const contentObjId = 5 + i * 3;
    const imgName = `Im${i + 1}`;

    const contentStream = `q ${page.width} 0 0 ${page.height} 0 0 cm /${imgName} Do Q\n`;
    const contentStreamBytes = new TextEncoder().encode(contentStream);

    // Page Obj
    offsets.push(currentOffset);
    writeAscii(
      `${pageObjId} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${page.width} ${page.height}] /Resources << /XObject << /${imgName} ${imgObjId} 0 R >> >> /Contents ${contentObjId} 0 R >>\nendobj\n`,
    );

    // Image Obj
    offsets.push(currentOffset);
    writeAscii(
      `${imgObjId} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${page.width} /Height ${page.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${page.jpegBytes.byteLength} >>\nstream\n`,
    );
    writeBytes(page.jpegBytes);
    writeAscii("\nendstream\nendobj\n");

    // Content Obj
    offsets.push(currentOffset);
    writeAscii(`${contentObjId} 0 obj\n<< /Length ${contentStreamBytes.byteLength} >>\nstream\n`);
    writeBytes(contentStreamBytes);
    writeAscii("endstream\nendobj\n");
  }

  // Cross-reference table
  const xrefOffset = currentOffset;
  writeAscii(`xref\n0 ${totalObjs + 1}\n`);
  writeAscii("0000000000 65535 f \r\n");
  for (let i = 1; i <= totalObjs; i++) {
    const off = offsets[i].toString().padStart(10, "0");
    writeAscii(`${off} 00000 n \r\n`);
  }

  // Trailer
  writeAscii(`trailer\n<< /Size ${totalObjs + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`);

  // Merge chunks into single Uint8Array
  const totalLength = chunks.reduce((acc, chunk) => acc + chunk.byteLength, 0);
  const result = new Uint8Array(totalLength);
  let pos = 0;
  for (const chunk of chunks) {
    result.set(chunk, pos);
    pos += chunk.byteLength;
  }
  return result;
}

export function canvasToJpegBytes(canvas: HTMLCanvasElement, quality = 0.92): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    if (typeof canvas.toBlob === "function") {
      canvas.toBlob(
        async (blob) => {
          if (!blob) {
            reject(new Error("canvas_to_blob_failed"));
            return;
          }
          const buf = await blob.arrayBuffer();
          resolve(new Uint8Array(buf));
        },
        "image/jpeg",
        quality,
      );
    } else {
      try {
        const dataUrl = canvas.toDataURL("image/jpeg", quality);
        const base64 = dataUrl.split(",")[1];
        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
          bytes[i] = binary.charCodeAt(i);
        }
        resolve(bytes);
      } catch (err) {
        reject(err);
      }
    }
  });
}

export function downloadBlob(blob: Blob, filename: string): void {
  if (typeof document === "undefined") return;
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function exportCanvasToPng(canvas: HTMLCanvasElement, filename = "tafel-export.png"): void {
  if (typeof canvas.toBlob === "function") {
    canvas.toBlob((blob) => {
      if (blob) downloadBlob(blob, filename);
    }, "image/png");
  } else {
    const dataUrl = canvas.toDataURL("image/png");
    const a = document.createElement("a");
    a.href = dataUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }
}

export async function exportCanvasToPdf(canvas: HTMLCanvasElement, filename = "tafel-export.pdf"): Promise<void> {
  const jpegBytes = await canvasToJpegBytes(canvas);
  const pdfBytes = generatePdfFromImages([
    {
      jpegBytes,
      width: canvas.width || 640,
      height: canvas.height || 360,
    },
  ]);
  const blob = new Blob([pdfBytes.buffer as ArrayBuffer], { type: "application/pdf" });
  downloadBlob(blob, filename);
}

export async function exportDeckToPdf(
  canvases: readonly HTMLCanvasElement[],
  filename = "folien-export.pdf",
): Promise<void> {
  if (canvases.length === 0) return;
  const pages: PageImageInput[] = [];
  for (const canvas of canvases) {
    const jpegBytes = await canvasToJpegBytes(canvas);
    pages.push({
      jpegBytes,
      width: canvas.width || 640,
      height: canvas.height || 360,
    });
  }
  const pdfBytes = generatePdfFromImages(pages);
  const blob = new Blob([pdfBytes.buffer as ArrayBuffer], { type: "application/pdf" });
  downloadBlob(blob, filename);
}
