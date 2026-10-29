import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  HostListener,
  Input,
  OnDestroy,
  ViewChild,
  computed,
  effect,
  signal,
} from "@angular/core";

import {
  WhiteboardColor,
  WhiteboardOperation,
  WhiteboardShapeType,
} from "../webrtc/whiteboard-contract";
import { WhiteboardOverlayService } from "../webrtc/whiteboard-overlay.service";
import { RoomModerationService } from "../webrtc/room-moderation.service";
import { RoomSessionService } from "../webrtc/room-session.service";
import { SlidePresentationService } from "../webrtc/slide-presentation.service";
import { exportCanvasToPdf, exportCanvasToPng } from "./pdf-export";
import { loadSlidesFromFiles } from "./slide-deck-loader";

const WIDTH = 1920;
const HEIGHT = 1080;

export type WhiteboardTool =
  | "pen"
  | "mark"
  | "rectangle"
  | "ellipse"
  | "line"
  | "text"
  | "erase"
  | "laser"
  | "pan";

export function drawLaserDot(
  ctx: CanvasRenderingContext2D,
  pos: { x: number; y: number },
  colorHex = "#ef4444",
  alpha = 1.0,
  label?: string,
): void {
  ctx.save();
  ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
  const grad = ctx.createRadialGradient(pos.x, pos.y, 1, pos.x, pos.y, 14);
  grad.addColorStop(0, colorHex);
  grad.addColorStop(0.3, "rgba(239, 68, 68, 0.6)");
  grad.addColorStop(1, "rgba(239, 68, 68, 0)");
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(pos.x, pos.y, 14, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = "#ffffff";
  ctx.beginPath();
  ctx.arc(pos.x, pos.y, 3.5, 0, Math.PI * 2);
  ctx.fill();

  if (label) {
    ctx.font = "bold 10px system-ui, sans-serif";
    const width = ctx.measureText(label).width;
    ctx.fillStyle = "rgba(15, 23, 42, 0.85)";
    ctx.beginPath();
    ctx.roundRect(pos.x + 8, pos.y - 14, width + 8, 16, 4);
    ctx.fill();
    ctx.fillStyle = "#f8fafc";
    ctx.fillText(label, pos.x + 12, pos.y - 2);
  }
  ctx.restore();
}

function pixel(point: { x: number; y: number }): { x: number; y: number } {
  return { x: (point.x / 1000) * WIDTH, y: (point.y / 1000) * HEIGHT };
}

function color(value: string): string {
  if (value.startsWith("#")) return value;
  if (value === "mark") return "#e6c35c";
  if (value === "accent") return "#38bdf8";
  if (value === "erase") return "#020408";
  return "#e8eef6";
}

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
const COLOR_SWATCHES: readonly { value: WhiteboardColor; hex: string; label: string }[] = Object.freeze([
  { value: "ink", hex: "#e8eef6", label: "Tinte" },
  { value: "mark", hex: "#e6c35c", label: "Gelb" },
  { value: "accent", hex: "#38bdf8", label: "Cyan" },
  { value: "#f87171", hex: "#f87171", label: "Rot" },
  { value: "#4ade80", hex: "#4ade80", label: "Grün" },
  { value: "#94a3b8", hex: "#94a3b8", label: "Grau" },
  { value: "#ffffff", hex: "#ffffff", label: "Weiß" },
  { value: "#0ea5e9", hex: "#0ea5e9", label: "Blau" },
  { value: "#6366f1", hex: "#6366f1", label: "Indigo" },
  { value: "#a855f7", hex: "#a855f7", label: "Violett" },
  { value: "#ec4899", hex: "#ec4899", label: "Pink" },
  { value: "#f97316", hex: "#f97316", label: "Orange" },
  { value: "#84cc16", hex: "#84cc16", label: "Limette" },
  { value: "#14b8a6", hex: "#14b8a6", label: "Türkis" },
  { value: "#78716c", hex: "#78716c", label: "Braun" },
]);

function isShapeTool(tool: string): tool is WhiteboardShapeType {
  return tool === "rectangle" || tool === "ellipse" || tool === "line";
}

export function paintShapePreview(
  ctx: CanvasRenderingContext2D,
  shape: WhiteboardShapeType,
  startPoint: { x: number; y: number },
  endPoint: { x: number; y: number },
  colorValue: string,
  widthValue: number,
): void {
  const start = pixel(startPoint);
  const end = pixel(endPoint);
  ctx.save();
  ctx.strokeStyle = color(colorValue);
  ctx.lineWidth = widthValue * (WIDTH / 500);
  ctx.setLineDash([4, 4]);
  if (shape === "rectangle") {
    const x = Math.min(start.x, end.x);
    const y = Math.min(start.y, end.y);
    const w = Math.abs(end.x - start.x);
    const h = Math.abs(end.y - start.y);
    ctx.strokeRect(x, y, w, h);
  } else if (shape === "ellipse") {
    const cx = (start.x + end.x) / 2;
    const cy = (start.y + end.y) / 2;
    const rx = Math.max(1, Math.abs(end.x - start.x) / 2);
    const ry = Math.max(1, Math.abs(end.y - start.y) / 2);
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
    ctx.stroke();
  } else if (shape === "line") {
    ctx.beginPath();
    ctx.moveTo(start.x, start.y);
    ctx.lineTo(end.x, end.y);
    ctx.stroke();
  }
  ctx.restore();
}

export function paintWhiteboard(
  ctx: CanvasRenderingContext2D,
  ops: readonly WhiteboardOperation[],
  backgroundImage?: HTMLImageElement | null,
): void {
  if (backgroundImage && backgroundImage.complete && backgroundImage.naturalWidth > 0) {
    ctx.drawImage(backgroundImage, 0, 0, WIDTH, HEIGHT);
  } else {
    ctx.clearRect(0, 0, WIDTH, HEIGHT);
  }

  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  let stroke: { color: string; width: number; x: number; y: number } | null = null;
  for (const op of ops) {
    if (op.kind === "clear") {
      if (backgroundImage && backgroundImage.complete && backgroundImage.naturalWidth > 0) {
        ctx.drawImage(backgroundImage, 0, 0, WIDTH, HEIGHT);
      } else {
        ctx.clearRect(0, 0, WIDTH, HEIGHT);
      }
      stroke = null;
      continue;
    }
    if (op.kind === "stroke-begin") {
      const start = pixel(op.payload["point"] as { x: number; y: number });
      stroke = {
        color: color(String(op.payload["color"] || "ink")),
        width: Number(op.payload["width"] || 2) * (WIDTH / 500),
        x: start.x,
        y: start.y,
      };
      ctx.strokeStyle = stroke.color;
      ctx.lineWidth = stroke.width;
      ctx.beginPath();
      ctx.moveTo(start.x, start.y);
      continue;
    }
    if (op.kind === "stroke-point" && stroke) {
      const points = op.payload["points"] as readonly { x: number; y: number }[];
      ctx.beginPath();
      ctx.moveTo(stroke.x, stroke.y);
      for (const item of points) {
        const next = pixel(item);
        ctx.lineTo(next.x, next.y);
        stroke.x = next.x;
        stroke.y = next.y;
      }
      ctx.stroke();
      continue;
    }
    if (op.kind === "stroke-end" && stroke) {
      const end = pixel(op.payload["point"] as { x: number; y: number });
      ctx.beginPath();
      ctx.moveTo(stroke.x, stroke.y);
      ctx.lineTo(end.x, end.y);
      ctx.stroke();
      stroke = null;
      continue;
    }
    if (op.kind === "erase") {
      const at = pixel(op.payload["point"] as { x: number; y: number });
      ctx.save();
      ctx.globalCompositeOperation = "destination-out";
      ctx.beginPath();
      ctx.arc(at.x, at.y, 12, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      stroke = null;
      continue;
    }
    if (op.kind === "shape") {
      stroke = null;
      const shapeType = String(op.payload["shape"]);
      const start = pixel(op.payload["start"] as { x: number; y: number });
      const end = pixel(op.payload["end"] as { x: number; y: number });
      ctx.strokeStyle = color(String(op.payload["color"] || "ink"));
      ctx.lineWidth = Number(op.payload["width"] || 2) * (WIDTH / 500);
      if (shapeType === "rectangle") {
        const x = Math.min(start.x, end.x);
        const y = Math.min(start.y, end.y);
        const w = Math.abs(end.x - start.x);
        const h = Math.abs(end.y - start.y);
        ctx.strokeRect(x, y, w, h);
      } else if (shapeType === "ellipse") {
        const cx = (start.x + end.x) / 2;
        const cy = (start.y + end.y) / 2;
        const rx = Math.max(1, Math.abs(end.x - start.x) / 2);
        const ry = Math.max(1, Math.abs(end.y - start.y) / 2);
        ctx.beginPath();
        ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
        ctx.stroke();
      } else if (shapeType === "line") {
        ctx.beginPath();
        ctx.moveTo(start.x, start.y);
        ctx.lineTo(end.x, end.y);
        ctx.stroke();
      }
      continue;
    }
    if (op.kind === "text") {
      stroke = null;
      const at = pixel(op.payload["point"] as { x: number; y: number });
      const textContent = String(op.payload["text"] || "");
      const size = Number(op.payload["size"] || 16) * (WIDTH / 640);
      ctx.fillStyle = color(String(op.payload["color"] || "ink"));
      ctx.font = `${Math.round(size)}px sans-serif`;
      ctx.textBaseline = "top";
      ctx.fillText(textContent, at.x, at.y);
      continue;
    }
  }
}

@Component({
  selector: "app-whiteboard-board",
  standalone: true,
  imports: [],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="whiteboard-panel" [class.expanded-mode]="expanded" aria-labelledby="whiteboard-heading">
      <div class="surface-heading small">
        <span class="feature-icon mint" aria-hidden="true">
          <svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="14" rx="2"/><path d="M7 14l3-4 3 3 4-5"/></svg>
        </span>
        <div class="header-titles">
          <p class="eyebrow">Data Plane · E2EE</p>
          <h2 id="whiteboard-heading">{{ deck.slides().length > 0 ? 'Tafel & Präsentation' : 'Gemeinsame Tafel' }}</h2>
        </div>
        <div class="header-badges">
          @if (!board.canDraw()) {
            <span class="whiteboard-badge read-only" id="whiteboard-read-only-badge">Lese-Modus</span>
          }
          @if (!session.joined()) {
            <span class="whiteboard-badge standalone-badge" id="whiteboard-standalone-badge">Lokale Skizze</span>
          }
        </div>
      </div>

      <div class="sr-only" aria-live="polite">{{ statusMessage() }}</div>

      <!-- Slide Deck Bar -->
      <div class="whiteboard-slide-bar" role="toolbar" aria-label="Foliensteuerung">
        <button id="whiteboard-prev-slide" type="button" class="button ghost compact"
          [disabled]="deck.currentSlideIndex() <= 0 || !deck.canControl()"
          (click)="prevSlide()"
          aria-label="Vorherige Folie (Pfeiltaste links)">◀</button>

        <span id="whiteboard-slide-indicator" class="slide-indicator" aria-live="polite">
          Folie {{ deck.currentSlideIndex() + 1 }} / {{ deck.totalSlides() }}
          @if (deck.currentSlide(); as cur) {
            @if (cur.name) {
              <span class="slide-name">({{ cur.name }})</span>
            }
          }
        </span>

        <button id="whiteboard-next-slide" type="button" class="button ghost compact"
          [disabled]="deck.currentSlideIndex() >= deck.totalSlides() - 1 || !deck.canControl()"
          (click)="nextSlide()"
          aria-label="Nächste Folie (Pfeiltaste rechts)">▶</button>

        @if (deck.canControl()) {
          <button id="whiteboard-add-slide" type="button" class="button ghost compact" (click)="addBlankSlide()"
            aria-label="Neue leere Folie hinzufügen">+ Folie</button>
        }

        <input #fileInput id="whiteboard-file-input" type="file" multiple
          accept="image/png, image/jpeg, image/webp, application/pdf"
          (change)="onFilesSelected($event)" style="display:none" />

        @if (deck.canControl()) {
          <button id="whiteboard-upload-button" type="button" class="button ghost compact" (click)="fileInput.click()"
            aria-label="Folien oder Bild laden (PNG, JPEG, WebP, PDF max 2MB)">📁 Folien laden</button>
        }

        @if (deck.slides().length > 0 && deck.canControl()) {
          <button id="whiteboard-clear-deck" type="button" class="button ghost compact danger" (click)="deck.clearDeck()"
            aria-label="Foliendeck schließen">Deck schließen</button>
        }

        <div class="export-actions">
          <button id="whiteboard-export-png" type="button" class="button ghost compact" (click)="exportPng()"
            aria-label="Tafel als PNG-Bild herunterladen">PNG</button>
          <button id="whiteboard-export-pdf" type="button" class="button ghost compact" (click)="exportPdf()"
            aria-label="Tafel als PDF-Dokument herunterladen">PDF</button>
        </div>
      </div>

      <!-- Drawing Tools -->
      <div class="whiteboard-tools" role="toolbar" aria-label="Zeichenwerkzeuge (Tasten 1-9)">
        <div class="whiteboard-tool-buttons" role="group" aria-label="Zeichenwerkzeuge (Tasten 1-9)">
          <button id="whiteboard-tool-pen" type="button" class="whiteboard-tool-button" [class.active]="tool() === 'pen'"
            [attr.aria-pressed]="tool() === 'pen'" [disabled]="!board.canDraw()" (click)="selectTool('pen')" title="1: Stift" aria-label="Stift (1)">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20l4-1L20 7l-3-3L5 16l-1 4z"/><path d="M15 6l3 3"/></svg>
          </button>
          <button id="whiteboard-tool-mark" type="button" class="whiteboard-tool-button" [class.active]="tool() === 'mark'"
            [attr.aria-pressed]="tool() === 'mark'" [disabled]="!board.canDraw()" (click)="selectTool('mark')" title="2: Textmarker" aria-label="Textmarker (2)">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h6"/><path d="M9 15l7-7 3 3-7 7-3-3z"/></svg>
          </button>
          <button id="whiteboard-tool-rectangle" type="button" class="whiteboard-tool-button" [class.active]="tool() === 'rectangle'"
            [attr.aria-pressed]="tool() === 'rectangle'" [disabled]="!board.canDraw()" (click)="selectTool('rectangle')" title="3: Rechteck" aria-label="Rechteck (3)">
            <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="6" width="16" height="12" rx="1"/></svg>
          </button>
          <button id="whiteboard-tool-ellipse" type="button" class="whiteboard-tool-button" [class.active]="tool() === 'ellipse'"
            [attr.aria-pressed]="tool() === 'ellipse'" [disabled]="!board.canDraw()" (click)="selectTool('ellipse')" title="4: Kreis / Ellipse" aria-label="Kreis oder Ellipse (4)">
            <svg viewBox="0 0 24 24" aria-hidden="true"><ellipse cx="12" cy="12" rx="8" ry="6"/></svg>
          </button>
          <button id="whiteboard-tool-line" type="button" class="whiteboard-tool-button" [class.active]="tool() === 'line'"
            [attr.aria-pressed]="tool() === 'line'" [disabled]="!board.canDraw()" (click)="selectTool('line')" title="5: Linie" aria-label="Linie (5)">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 19L19 5"/></svg>
          </button>
          <button id="whiteboard-tool-text" type="button" class="whiteboard-tool-button" [class.active]="tool() === 'text'"
            [attr.aria-pressed]="tool() === 'text'" [disabled]="!board.canDraw()" (click)="selectTool('text')" title="6: Text" aria-label="Text (6)">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 6V4h14v2"/><path d="M12 4v16"/><path d="M9 20h6"/></svg>
          </button>
          <button id="whiteboard-tool-erase" type="button" class="whiteboard-tool-button" [class.active]="tool() === 'erase'"
            [attr.aria-pressed]="tool() === 'erase'" [disabled]="!board.canDraw()" (click)="selectTool('erase')" title="7: Radierer" aria-label="Radierer (7)">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 16l8-8 6 6-8 8H6l-2-2z"/><path d="M10 20h10"/></svg>
          </button>
          <button id="whiteboard-tool-laser" type="button" class="whiteboard-tool-button" [class.active]="tool() === 'laser'"
            [attr.aria-pressed]="tool() === 'laser'" [disabled]="!board.canDraw()" (click)="selectTool('laser')" title="8: Laserpointer" aria-label="Laserpointer (8)">
            <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="2.5"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3"/></svg>
          </button>
          <button id="whiteboard-tool-pan" type="button" class="whiteboard-tool-button" [class.active]="tool() === 'pan'"
            [attr.aria-pressed]="tool() === 'pan'" [disabled]="!board.canDraw()" (click)="selectTool('pan')" title="9: Hand / Verschieben" aria-label="Hand oder Verschieben (9)">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 11V6a1.5 1.5 0 013 0v5M11 11V5a1.5 1.5 0 013 0v6M14 11V7a1.5 1.5 0 013 0v7a6 6 0 01-6 6h-1a6 6 0 01-6-6v-3a1.5 1.5 0 013 0"/></svg>
          </button>
        </div>
        <div class="whiteboard-color-tools" role="group" aria-label="Farben">
          <div class="whiteboard-color-swatches">
            @for (swatch of quickColors; track swatch.value) {
              <button type="button" class="whiteboard-swatch" [class.active]="selectedColor() === swatch.value"
                [attr.aria-pressed]="selectedColor() === swatch.value" [disabled]="colorDisabled()"
                [style.background]="swatch.hex" (click)="selectColor(swatch.value)"
                [title]="'Farbe: ' + swatch.label" [attr.aria-label]="'Farbe ' + swatch.label"></button>
            }
            <button id="whiteboard-color-palette-toggle" type="button" class="whiteboard-tool-button" [class.active]="paletteOpen()"
              [disabled]="colorDisabled()" (click)="paletteOpen.set(!paletteOpen())" title="Farbpalette"
              aria-label="Farbpalette öffnen oder schließen" [attr.aria-expanded]="paletteOpen()">
              <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8"/><circle cx="8.5" cy="10" r="1.1"/><circle cx="15.5" cy="10" r="1.1"/><circle cx="9.5" cy="15" r="1.1"/><circle cx="15.5" cy="15" r="1.1"/></svg>
            </button>
          </div>
          @if (paletteOpen()) {
            <div class="whiteboard-color-palette" id="whiteboard-color-palette" role="group" aria-label="Erweiterte Farbpalette">
              @for (swatch of paletteColors; track swatch.value) {
                <button type="button" class="whiteboard-swatch" [class.active]="selectedColor() === swatch.value"
                  [attr.aria-pressed]="selectedColor() === swatch.value" [disabled]="colorDisabled()"
                  [style.background]="swatch.hex" (click)="selectColor(swatch.value)"
                  [title]="'Farbe: ' + swatch.label" [attr.aria-label]="'Farbe ' + swatch.label"></button>
              }
              <label class="whiteboard-custom-color">Eigene Farbe
                <input id="whiteboard-color-custom" type="color" [value]="currentHex()" [disabled]="colorDisabled()"
                  (input)="selectColor($any($event.target).value)" />
              </label>
            </div>
          }
        </div>
        @if (tool() === 'text') {
          <label>Text
            <input id="whiteboard-text-input" type="text" maxlength="100" [disabled]="!board.canDraw()"
              placeholder="Text eingeben (Klick auf Tafel platziert)..." [value]="textInput()" (input)="textInput.set($any($event.target).value)" />
          </label>
        }
        <div class="whiteboard-zoom-controls" role="group" aria-label="Zoom-Steuerung (+, -, 0)">
          <button id="whiteboard-zoom-out" type="button" class="button ghost compact" [disabled]="zoomLevel() <= 1.0"
            (click)="zoomOut()" aria-label="Verkleinern (-)">−</button>
          <button id="whiteboard-zoom-reset" type="button" class="button ghost compact"
            (click)="resetZoom()" aria-label="Zoom zurücksetzen (1:1)">{{ zoomPercent() }}%</button>
          <button id="whiteboard-zoom-in" type="button" class="button ghost compact" [disabled]="zoomLevel() >= 3.0"
            (click)="zoomIn()" aria-label="Vergrößern (+)">+</button>
        </div>
        <button id="whiteboard-undo" type="button" class="button ghost compact" [disabled]="!board.canDraw()"
          (click)="board.undoOwn()" aria-label="Letzte eigene Aktion rückgängig machen (Ctrl+Z)">Eigenes Undo</button>
        <button id="whiteboard-clear" type="button" class="button ghost compact danger" [disabled]="!board.canClear()"
          (click)="board.requestClear()" aria-label="Aktuelle Folie leeren">Folie leeren</button>
        <span class="whiteboard-policy-status">
          Modus: {{ moderation.whiteboardPolicy() === 'open' ? 'Alle Teilnehmer dürfen zeichnen' : 'Nur Presenter darf zeichnen' }}
        </span>
        @if (moderation.canControlWhiteboard()) {
          <button id="whiteboard-toggle-policy" type="button" class="button ghost compact" (click)="togglePolicy()">
            {{ moderation.whiteboardPolicy() === 'open' ? 'Auf Presenter beschränken' : 'Für alle freigeben' }}
          </button>
        }
      </div>

      <!-- Canvas Area -->
      <div class="whiteboard-canvas-wrapper" [class.expanded-canvas]="expanded">
        <div class="whiteboard-viewport">
          <div class="whiteboard-stage"
            [style.transform]="'translate(' + panOffset().x + 'px, ' + panOffset().y + 'px) scale(' + zoomLevel() + ')'"
            [style.transform-origin]="'center center'">
            <canvas #canvas id="whiteboard-canvas" width="1920" height="1080" role="img" aria-label="Gemeinsame Tafel und Folienansicht"
              tabindex="0" [class.laser-cursor]="tool() === 'laser'" [class.pan-cursor]="tool() === 'pan'"
              (pointerdown)="down($event)" (pointermove)="move($event)" (pointerup)="up($event)" (pointerleave)="leave($event)">
            </canvas>
          </div>
        </div>
      </div>
      <p class="sr-only">Tastatursteuerung: 1-9 für Werkzeuge · +, -, 0 für Zoom · Ctrl+Z für Undo · Pfeiltasten für Folienwechsel. Inhalt bleibt lokal & E2EE.</p>
    </section>
  `,
  styles: [`
    .whiteboard-panel { display: grid; gap: .5rem; }
    .whiteboard-panel.expanded-mode { gap: .55rem; width: 100%; height: calc(100vh - 7.5rem); min-height: 30rem; display: flex; flex-direction: column; }
    :host-context(.has-session-dock) .whiteboard-panel.expanded-mode { height: calc(100vh - 15.5rem); }
    .surface-heading { display: flex; align-items: center; justify-content: space-between; gap: .75rem; }
    .header-titles { flex: 1; }
    .header-badges { display: flex; gap: .35rem; align-items: center; }
    .whiteboard-badge { border-radius: .3rem; padding: .15rem .45rem; font-size: .75rem; font-weight: 600; }
    .whiteboard-badge.read-only { background: rgba(245, 158, 11, 0.15); color: #f59e0b; border: 1px solid rgba(245, 158, 11, 0.3); }
    .whiteboard-badge.standalone-badge { background: rgba(56, 189, 248, 0.15); color: #38bdf8; border: 1px solid rgba(56, 189, 248, 0.3); }

    .whiteboard-slide-bar {
      display: flex; flex-wrap: wrap; gap: .4rem; align-items: center;
      background: rgba(255, 255, 255, 0.03); padding: .35rem .6rem; border-radius: .5rem;
      border: 1px solid var(--line); font-size: .82rem;
    }
    .slide-indicator { font-weight: 600; color: var(--text-bright, #f1f5f9); min-width: 5.5rem; text-align: center; }
    .slide-name { font-weight: normal; color: var(--muted); font-size: .75rem; margin-left: .25rem; }
    .export-actions { margin-left: auto; display: flex; gap: .35rem; }

    .whiteboard-status-row { display: flex; flex-wrap: wrap; gap: .5rem; align-items: center; font-size: .8rem; }
    .whiteboard-policy-status { color: var(--muted); }

    .whiteboard-tools { display: flex; flex-wrap: wrap; gap: .45rem; align-items: end; }
    .whiteboard-tools label { display: flex; flex-direction: column; gap: .2rem; font-size: .85rem; }
    .whiteboard-tool-buttons { display: flex; gap: .25rem; align-items: center; }
    .whiteboard-tool-button {
      display: grid; place-items: center; width: 2.15rem; height: 2.15rem; padding: 0;
      border: 1px solid var(--line); border-radius: .45rem; background: transparent;
      color: inherit; cursor: pointer; transition: background 120ms ease, border-color 120ms ease;
    }
    .whiteboard-tool-button:hover:not(:disabled) { border-color: var(--line-strong); background: rgba(255, 255, 255, .05); }
    .whiteboard-tool-button.active { background: rgba(102, 224, 183, .18); border-color: rgba(102, 224, 183, .55); }
    .whiteboard-tool-button:disabled { opacity: .45; cursor: not-allowed; }
    .whiteboard-color-tools { position: relative; display: flex; align-items: center; }
    .whiteboard-color-swatches { display: flex; gap: .3rem; align-items: center; }
    .whiteboard-swatch {
      width: 1.55rem; height: 1.55rem; border-radius: .55rem; padding: 0; cursor: pointer;
      border: 2px solid rgba(255, 255, 255, .14); box-shadow: inset 0 0 0 1px rgba(0, 0, 0, .18);
      transition: transform 120ms ease, border-color 120ms ease, box-shadow 120ms ease;
    }
    .whiteboard-swatch:hover:not(:disabled) { transform: scale(1.08); border-color: rgba(255, 255, 255, .34); }
    .whiteboard-swatch.active { border-color: rgba(102, 224, 183, .85); box-shadow: 0 0 0 2px rgba(102, 224, 183, .3); }
    .whiteboard-swatch:disabled { opacity: .45; cursor: not-allowed; }
    .whiteboard-color-palette {
      position: absolute; top: calc(100% + .45rem); left: 0; z-index: 30;
      display: grid; grid-template-columns: repeat(5, 1.55rem); gap: .45rem;
      padding: .7rem; border-radius: .8rem; border: 1px solid var(--line);
      background: rgba(12, 17, 26, .97); box-shadow: 0 18px 46px rgba(0, 0, 0, .45);
    }
    .whiteboard-custom-color { display: flex; flex-direction: column; gap: .3rem; grid-column: 1 / -1; font-size: .78rem; color: #bac5d5; }
    .whiteboard-custom-color input[type="color"] {
      width: 100%; height: 2.1rem; padding: .15rem; border: 1px solid var(--line);
      border-radius: .55rem; background: transparent; cursor: pointer;
    }
    .whiteboard-tools input[type="text"] { min-width: 12rem; padding: .3rem .5rem; border-radius: .4rem; border: 1px solid var(--line); background: var(--bg-surface); color: inherit; }
    .whiteboard-zoom-controls { display: flex; gap: .2rem; align-items: center; }

    .whiteboard-canvas-wrapper { width: 100%; display: flex; justify-content: center; }
    .whiteboard-viewport {
      width: 100%; max-width: 44rem; aspect-ratio: 16 / 9;
      overflow: hidden; border: 1px solid var(--line); border-radius: .7rem;
      background: #020408; position: relative;
    }
    .expanded-canvas .whiteboard-viewport { max-width: 100%; }
    .expanded-canvas { flex: 1 1 auto; min-height: 0; display: flex; }
    .expanded-canvas .whiteboard-viewport { width: 100%; height: 100%; aspect-ratio: auto; }
    .whiteboard-stage { width: 100%; height: 100%; }
    canvas {
      width: 100%; height: 100%; display: block;
      touch-action: none; cursor: crosshair;
    }
    canvas.laser-cursor { cursor: crosshair; }
    canvas.pan-cursor { cursor: grab; }
    canvas.pan-cursor:active { cursor: grabbing; }
    .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); border: 0; }
  `],
})
export class WhiteboardBoardComponent implements AfterViewInit, OnDestroy {
  @Input() expanded = false;
  @ViewChild("canvas", { static: true }) canvasRef!: ElementRef<HTMLCanvasElement>;

  readonly tool = signal<WhiteboardTool>("pen");
  readonly selectedColor = signal<WhiteboardColor>("ink");
  readonly paletteOpen = signal(false);
  readonly quickColors = COLOR_SWATCHES.slice(0, 5);
  readonly paletteColors = COLOR_SWATCHES;
  readonly selectedWidth = signal<number>(2);
  readonly textInput = signal<string>("");
  readonly textSize = signal<number>(16);
  readonly statusMessage = signal<string>("");
  readonly zoomLevel = signal<number>(1.0);
  readonly panOffset = signal<{ x: number; y: number }>({ x: 0, y: 0 });
  readonly zoomPercent = computed(() => Math.round(this.zoomLevel() * 100));
  readonly localLaser = signal<{ x: number; y: number } | null>(null);

  private drawing = false;
  private isPanning = false;
  private panStart: { x: number; y: number } | null = null;
  private pendingPoints: { x: number; y: number }[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private initialPanOffset: { x: number; y: number } = { x: 0, y: 0 };
  private lastLaserSent = 0;
  private localLaserTimeout: ReturnType<typeof setTimeout> | null = null;
  private dragStart: { x: number; y: number } | null = null;
  private dragCurrent: { x: number; y: number } | null = null;
  private backgroundImgElement: HTMLImageElement | null = null;

  constructor(
    readonly session: RoomSessionService,
    readonly board: WhiteboardOverlayService,
    readonly moderation: RoomModerationService,
    readonly deck: SlidePresentationService,
  ) {
    effect(() => {
      const ops = this.board.ops();
      const currentSlide = this.deck.currentSlide();
      const _remoteLasers = this.board.remoteLasers();
      const _localLaser = this.localLaser();
      this.updateSlideBackground(currentSlide?.dataUrl ?? "");
      this.repaint(ops);
    });
  }

  private updateSlideBackground(dataUrl: string): void {
    if (!dataUrl) {
      this.backgroundImgElement = null;
      return;
    }
    if (this.backgroundImgElement && this.backgroundImgElement.src === dataUrl) {
      return;
    }
    const img = new Image();
    img.onload = () => {
      this.backgroundImgElement = img;
      this.repaint(this.board.ops());
    };
    img.src = dataUrl;
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flushPendingPoints();
    }, 60);
  }

  private flushPendingPoints(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.pendingPoints.length === 0) return;
    const points = this.pendingPoints;
    this.pendingPoints = [];
    this.board.publish("stroke-point", { points });
  }

  repaint(ops = this.board.ops()): void {
    const canvas = this.canvasRef?.nativeElement;
    const ctx = canvas?.getContext("2d");
    if (ctx) {
      paintWhiteboard(ctx, ops, this.backgroundImgElement);
      const remote = this.board.remoteLasers();
      for (const [peerId, item] of remote.entries()) {
        const p = pixel(item);
        drawLaserDot(ctx, p, "#ef4444", 1.0, peerId.slice(0, 6));
      }
      const local = this.localLaser();
      if (local) {
        const p = pixel(local);
        drawLaserDot(ctx, p, "#38bdf8", 1.0, "Ich");
      }
    }
  }

  togglePolicy(): void {
    const next = this.moderation.whiteboardPolicy() === "open" ? "presenter-only" : "open";
    this.moderation.setWhiteboardPolicy(next);
    this.statusMessage.set(`Tafelmodus geändert auf: ${next === "open" ? "Für alle" : "Nur Presenter"}`);
  }

  selectTool(tool: WhiteboardTool): void {
    this.tool.set(tool);
    this.statusMessage.set(`Werkzeug gewählt: ${tool}`);
  }

  colorDisabled(): boolean {
    return !this.board.canDraw() || this.tool() === "erase" || this.tool() === "mark"
      || this.tool() === "laser" || this.tool() === "pan";
  }

  currentHex(): string {
    return color(this.selectedColor());
  }

  selectColor(value: unknown): void {
    if (value === "ink" || value === "mark" || value === "accent") {
      this.selectedColor.set(value);
      return;
    }
    if (typeof value === "string" && HEX_COLOR.test(value)) {
      this.selectedColor.set(value as WhiteboardColor);
    }
  }

  zoomIn(): void {
    this.zoomLevel.update((z) => Math.min(3.0, +(z + 0.25).toFixed(2)));
    this.statusMessage.set(`Zoom: ${this.zoomPercent()}%`);
  }

  zoomOut(): void {
    this.zoomLevel.update((z) => {
      const next = Math.max(1.0, +(z - 0.25).toFixed(2));
      if (next === 1.0) {
        this.panOffset.set({ x: 0, y: 0 });
      }
      return next;
    });
    this.statusMessage.set(`Zoom: ${this.zoomPercent()}%`);
  }

  resetZoom(): void {
    this.zoomLevel.set(1.0);
    this.panOffset.set({ x: 0, y: 0 });
    this.statusMessage.set("Zoom zurückgesetzt (100%)");
  }

  prevSlide(): void {
    if (this.deck.prevSlide()) {
      this.statusMessage.set(`Folie ${this.deck.currentSlideIndex() + 1} von ${this.deck.totalSlides()}`);
    }
  }

  nextSlide(): void {
    if (this.deck.nextSlide()) {
      this.statusMessage.set(`Folie ${this.deck.currentSlideIndex() + 1} von ${this.deck.totalSlides()}`);
    }
  }

  addBlankSlide(): void {
    this.deck.addBlankSlide();
    this.statusMessage.set(`Neue leere Folie hinzugefügt (Folie ${this.deck.currentSlideIndex() + 1} von ${this.deck.totalSlides()})`);
  }

  async onFilesSelected(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    if (!input.files || input.files.length === 0) return;
    const files = Array.from(input.files);
    input.value = ""; // Reset input
    const result = await loadSlidesFromFiles(files);
    if (result.success && result.slides.length > 0) {
      this.deck.loadDeck(result.slides);
      this.statusMessage.set(`${result.slides.length} Folie(n) geladen.`);
    } else if (result.error) {
      this.statusMessage.set(`Fehler beim Laden: ${result.error}`);
    }
  }

  exportPng(): void {
    const canvas = this.canvasRef?.nativeElement;
    if (canvas) {
      exportCanvasToPng(canvas, `tafel-folie-${this.deck.currentSlideIndex() + 1}.png`);
      this.statusMessage.set("PNG-Export heruntergeladen.");
    }
  }

  async exportPdf(): Promise<void> {
    const canvas = this.canvasRef?.nativeElement;
    if (canvas) {
      await exportCanvasToPdf(canvas, `tafel-folie-${this.deck.currentSlideIndex() + 1}.pdf`);
      this.statusMessage.set("PDF-Export heruntergeladen.");
    }
  }

  @HostListener("window:keydown", ["$event"])
  onKeyDown(event: KeyboardEvent): void {
    const target = event.target as HTMLElement | null;
    if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) {
      return;
    }

    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
      event.preventDefault();
      this.board.undoOwn();
      this.statusMessage.set("Eigenes Undo ausgeführt.");
      return;
    }

    if (event.key === "1") { this.selectTool("pen"); return; }
    if (event.key === "2") { this.selectTool("mark"); return; }
    if (event.key === "3") { this.selectTool("rectangle"); return; }
    if (event.key === "4") { this.selectTool("ellipse"); return; }
    if (event.key === "5") { this.selectTool("line"); return; }
    if (event.key === "6") { this.selectTool("text"); return; }
    if (event.key === "7") { this.selectTool("erase"); return; }
    if (event.key === "8") { this.selectTool("laser"); return; }
    if (event.key === "9") { this.selectTool("pan"); return; }

    if (event.key === "+" || event.key === "=") {
      event.preventDefault();
      this.zoomIn();
      return;
    }
    if (event.key === "-") {
      event.preventDefault();
      this.zoomOut();
      return;
    }
    if (event.key === "0") {
      event.preventDefault();
      this.resetZoom();
      return;
    }

    if (event.key === "ArrowRight" || event.key === "PageDown") {
      event.preventDefault();
      this.nextSlide();
      return;
    }
    if (event.key === "ArrowLeft" || event.key === "PageUp") {
      event.preventDefault();
      this.prevSlide();
      return;
    }
  }

  ngAfterViewInit(): void {
    this.repaint();
  }

  ngOnDestroy(): void {
    if (this.localLaserTimeout) {
      clearTimeout(this.localLaserTimeout);
      this.localLaserTimeout = null;
    }
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }

  private coord(event: PointerEvent): { x: number; y: number } | null {
    if (!this.board.canDraw()) return null;
    const canvas = this.canvasRef?.nativeElement;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return null;
    return {
      x: Math.max(0, Math.min(1000, Math.round(((event.clientX - rect.left) / rect.width) * 1000))),
      y: Math.max(0, Math.min(1000, Math.round(((event.clientY - rect.top) / rect.height) * 1000))),
    };
  }

  private emitLaser(point: { x: number; y: number }): void {
    this.localLaser.set(point);
    if (this.localLaserTimeout) {
      clearTimeout(this.localLaserTimeout);
      this.localLaserTimeout = null;
    }
    const now = Date.now();
    if (now - this.lastLaserSent >= 40) {
      this.lastLaserSent = now;
      this.board.sendLaser(point);
    }
  }

  down(event: PointerEvent): void {
    this.flushPendingPoints();
    const activeTool = this.tool();
    if (activeTool === "pan" || event.button === 1) {
      event.preventDefault();
      this.isPanning = true;
      this.panStart = { x: event.clientX, y: event.clientY };
      this.initialPanOffset = { ...this.panOffset() };
      this.canvasRef.nativeElement.setPointerCapture(event.pointerId);
      return;
    }

    if (activeTool === "laser") {
      event.preventDefault();
      this.canvasRef.nativeElement.setPointerCapture(event.pointerId);
      this.drawing = true;
      const point = this.coord(event);
      if (point) {
        this.emitLaser(point);
      }
      return;
    }

    if (!this.board.canDraw()) return;
    const point = this.coord(event);
    if (!point) return;
    event.preventDefault();
    this.canvasRef.nativeElement.setPointerCapture(event.pointerId);

    const activeColor = this.selectedColor();
    const activeWidth = this.selectedWidth();

    if (activeTool === "text") {
      const text = this.textInput().trim();
      if (text) {
        const col = activeColor === "erase" ? "ink" : activeColor;
        this.board.publish("text", {
          text,
          point,
          color: col,
          size: this.textSize(),
        });
      }
      return;
    }

    this.drawing = true;
    if (activeTool === "erase") {
      this.board.publish("erase", { point });
    } else if (isShapeTool(activeTool)) {
      this.dragStart = point;
      this.dragCurrent = point;
    } else if (activeTool === "mark") {
      this.board.publish("stroke-begin", { color: "mark", width: 8, point });
    } else {
      const col = activeColor === "erase" ? "ink" : activeColor;
      this.board.publish("stroke-begin", { color: col, width: activeWidth, point });
    }
  }

  move(event: PointerEvent): void {
    if (this.isPanning && this.panStart) {
      const dx = event.clientX - this.panStart.x;
      const dy = event.clientY - this.panStart.y;
      this.panOffset.set({
        x: Math.round(this.initialPanOffset.x + dx),
        y: Math.round(this.initialPanOffset.y + dy),
      });
      return;
    }

    const activeTool = this.tool();
    if (activeTool === "laser") {
      const point = this.coord(event);
      if (point) {
        this.emitLaser(point);
      }
      return;
    }

    if (!this.drawing) return;
    const point = this.coord(event);
    if (!point) return;

    const activeColor = this.selectedColor();
    const activeWidth = this.selectedWidth();

    if (isShapeTool(activeTool)) {
      this.dragCurrent = point;
      const ctx = this.canvasRef.nativeElement.getContext("2d");
      if (ctx) {
        paintWhiteboard(ctx, this.board.ops(), this.backgroundImgElement);
        if (this.dragStart) {
          const col = activeColor === "erase" ? "ink" : activeColor;
          paintShapePreview(ctx, activeTool, this.dragStart, this.dragCurrent, col, activeWidth);
        }
      }
    } else if (activeTool === "erase") {
      this.board.publish("erase", { point });
    } else {
      this.pendingPoints.push(point);
      if (this.pendingPoints.length >= 16) this.flushPendingPoints();
      else this.scheduleFlush();
    }
  }

  up(event: PointerEvent): void {
    this.flushPendingPoints();
    if (this.isPanning) {
      this.isPanning = false;
      this.panStart = null;
      try { this.canvasRef.nativeElement.releasePointerCapture(event.pointerId); } catch {}
      return;
    }

    if (this.tool() === "laser") {
      this.drawing = false;
      try { this.canvasRef.nativeElement.releasePointerCapture(event.pointerId); } catch {}
      if (this.localLaserTimeout) clearTimeout(this.localLaserTimeout);
      this.localLaserTimeout = setTimeout(() => {
        this.localLaser.set(null);
        this.repaint();
      }, 1000);
      return;
    }

    if (!this.drawing) return;
    this.drawing = false;
    try { this.canvasRef.nativeElement.releasePointerCapture(event.pointerId); } catch {}
    const point = this.coord(event);

    const activeTool = this.tool();
    const activeColor = this.selectedColor();
    const activeWidth = this.selectedWidth();

    if (isShapeTool(activeTool) && this.dragStart && point) {
      const col = activeColor === "erase" ? "ink" : activeColor;
      this.board.publish("shape", {
        shape: activeTool,
        color: col,
        width: activeWidth,
        start: this.dragStart,
        end: point,
      });
      this.dragStart = null;
      this.dragCurrent = null;
    } else if (point && activeTool !== "erase") {
      this.board.publish("stroke-end", { point });
    }
  }

  leave(event: PointerEvent): void {
    this.flushPendingPoints();
    if (this.isPanning) {
      this.isPanning = false;
      this.panStart = null;
    }
    if (this.tool() === "laser") {
      if (this.localLaserTimeout) clearTimeout(this.localLaserTimeout);
      this.localLaserTimeout = setTimeout(() => {
        this.localLaser.set(null);
        this.repaint();
      }, 500);
      return;
    }
    if (this.drawing) {
      this.up(event);
    }
  }
}
