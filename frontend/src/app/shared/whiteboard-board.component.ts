import {
  AfterViewInit, ChangeDetectionStrategy, Component, ElementRef, OnDestroy, ViewChild, effect,
} from "@angular/core";

import {
  WhiteboardColor,
  WhiteboardOperation,
  WhiteboardShapeType,
} from "../webrtc/whiteboard-contract";
import { WhiteboardOverlayService } from "../webrtc/whiteboard-overlay.service";
import { RoomModerationService } from "../webrtc/room-moderation.service";
import { RoomSessionService } from "../webrtc/room-session.service";

const WIDTH = 640;
const HEIGHT = 360;

export type WhiteboardTool = "pen" | "mark" | "rectangle" | "ellipse" | "line" | "text" | "erase";

function pixel(point: { x: number; y: number }): { x: number; y: number } {
  return { x: (point.x / 1000) * WIDTH, y: (point.y / 1000) * HEIGHT };
}

function color(value: string): string {
  if (value === "mark") return "#e6c35c";
  if (value === "accent") return "#38bdf8";
  if (value === "erase") return "#020408";
  return "#e8eef6";
}

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

export function paintWhiteboard(ctx: CanvasRenderingContext2D, ops: readonly WhiteboardOperation[]): void {
  ctx.clearRect(0, 0, WIDTH, HEIGHT);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  let stroke: { color: string; width: number; x: number; y: number } | null = null;
  for (const op of ops) {
    if (op.kind === "clear") {
      ctx.clearRect(0, 0, WIDTH, HEIGHT);
      stroke = null;
      continue;
    }
    if (op.kind === "stroke-begin") {
      const start = pixel(op.payload["point"] as { x: number; y: number });
      stroke = {
        color: color(String(op.payload["color"] || "ink")),
        width: Number(op.payload["width"] || 2) * (WIDTH / 500),
        x: start.x, y: start.y,
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
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="whiteboard-panel" aria-labelledby="whiteboard-heading">
      <div class="surface-heading small">
        <span class="feature-icon mint" aria-hidden="true"><svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="14" rx="2"/><path d="M7 14l3-4 3 3 4-5"/></svg></span>
        <div>
          <p class="eyebrow">Data Plane</p>
          <h2 id="whiteboard-heading">Tafel</h2>
        </div>
      </div>
      <p class="hint">Zeichnungen laufen verschlüsselt zwischen den Browsern. Der Server sieht den Inhalt nicht. Capture startet nicht.</p>
      <div class="whiteboard-status-row">
        <span class="whiteboard-policy-status">
          Modus: {{ moderation.whiteboardPolicy() === 'open' ? 'Alle Teilnehmer' : 'Nur Presenter' }}
        </span>
        @if (!board.canDraw()) {
          <span class="whiteboard-badge read-only" id="whiteboard-read-only-badge">Lese-Modus</span>
        }
        @if (moderation.canControlWhiteboard()) {
          <button id="whiteboard-toggle-policy" type="button" class="button ghost compact" (click)="togglePolicy()">
            {{ moderation.whiteboardPolicy() === 'open' ? 'Auf Presenter beschränken' : 'Für alle freigeben' }}
          </button>
        }
      </div>
      <div class="whiteboard-tools">
        <label>Werkzeug
          <select id="whiteboard-tool-select" [disabled]="!session.joined() || !board.canDraw()" (change)="tool = $any($event.target).value">
            <option value="pen">Stift</option>
            <option value="mark">Marker</option>
            <option value="rectangle">Rechteck</option>
            <option value="ellipse">Kreis</option>
            <option value="line">Linie</option>
            <option value="text">Text</option>
            <option value="erase">Radierer</option>
          </select>
        </label>
        <label>Farbe
          <select id="whiteboard-color" [disabled]="!session.joined() || !board.canDraw() || tool === 'erase' || tool === 'mark'"
            (change)="selectedColor = $any($event.target).value">
            <option value="ink">Tinte</option>
            <option value="accent">Akzent</option>
            <option value="mark">Marker</option>
          </select>
        </label>
        @if (tool === 'text') {
          <label>Text
            <input id="whiteboard-text-input" type="text" maxlength="100" [disabled]="!session.joined() || !board.canDraw()"
              placeholder="Text eingeben..." [value]="textInput" (input)="textInput = $any($event.target).value" />
          </label>
        }
        <button id="whiteboard-undo" type="button" class="button ghost compact" [disabled]="!session.joined() || !board.canDraw()"
          (click)="board.undoOwn()">Eigenes Undo</button>
        <button id="whiteboard-clear" type="button" class="button ghost compact" [disabled]="!board.canClear()"
          (click)="board.requestClear()">Tafel leeren</button>
      </div>
      <canvas #canvas id="whiteboard-canvas" width="640" height="360" role="img" aria-label="Gemeinsame Tafel"
        [attr.tabindex]="session.joined() ? 0 : -1"
        (pointerdown)="down($event)" (pointermove)="move($event)" (pointerup)="up($event)" (pointerleave)="up($event)">
      </canvas>
    </section>
  `,
  styles: [`
    .whiteboard-panel { display: grid; gap: .55rem; }
    .whiteboard-status-row { display: flex; flex-wrap: wrap; gap: .5rem; align-items: center; font-size: .8rem; }
    .whiteboard-policy-status { color: var(--muted); }
    .whiteboard-badge.read-only { background: rgba(245, 158, 11, 0.15); color: #f59e0b; border: 1px solid rgba(245, 158, 11, 0.3); border-radius: .3rem; padding: .15rem .4rem; font-size: .75rem; font-weight: 600; }
    .whiteboard-tools { display: flex; flex-wrap: wrap; gap: .45rem; align-items: end; }
    .whiteboard-tools label { display: flex; flex-direction: column; gap: .2rem; font-size: .85rem; }
    .whiteboard-tools input[type="text"] { min-width: 10rem; padding: .3rem .5rem; border-radius: .4rem; border: 1px solid var(--line); background: var(--bg-surface); color: inherit; }
    canvas { width: 100%; max-width: 40rem; border: 1px solid var(--line); border-radius: .7rem; background: #020408; touch-action: none; cursor: crosshair; }
  `],
})
export class WhiteboardBoardComponent implements AfterViewInit, OnDestroy {
  @ViewChild("canvas", { static: true }) canvasRef!: ElementRef<HTMLCanvasElement>;
  tool: WhiteboardTool = "pen";
  selectedColor: WhiteboardColor = "ink";
  selectedWidth = 2;
  textInput = "";
  textSize = 16;
  private drawing = false;
  private dragStart: { x: number; y: number } | null = null;
  private dragCurrent: { x: number; y: number } | null = null;

  constructor(
    readonly session: RoomSessionService,
    readonly board: WhiteboardOverlayService,
    readonly moderation: RoomModerationService,
  ) {
    effect(() => {
      const ops = this.board.ops();
      const canvas = this.canvasRef?.nativeElement;
      const ctx = canvas?.getContext("2d");
      if (ctx) paintWhiteboard(ctx, ops);
    });
  }

  togglePolicy(): void {
    const next = this.moderation.whiteboardPolicy() === "open" ? "presenter-only" : "open";
    this.moderation.setWhiteboardPolicy(next);
  }

  ngAfterViewInit(): void {
    const ctx = this.canvasRef.nativeElement.getContext("2d");
    if (ctx) paintWhiteboard(ctx, this.board.ops());
  }

  ngOnDestroy(): void {}

  private coord(event: PointerEvent): { x: number; y: number } | null {
    if (!this.session.joined()) return null;
    const rect = this.canvasRef.nativeElement.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return null;
    return {
      x: Math.max(0, Math.min(1000, Math.round(((event.clientX - rect.left) / rect.width) * 1000))),
      y: Math.max(0, Math.min(1000, Math.round(((event.clientY - rect.top) / rect.height) * 1000))),
    };
  }

  down(event: PointerEvent): void {
    if (!this.board.canDraw()) return;
    const point = this.coord(event);
    if (!point) return;
    event.preventDefault();
    this.canvasRef.nativeElement.setPointerCapture(event.pointerId);

    if (this.tool === "text") {
      if (this.textInput.trim()) {
        const col = this.selectedColor === "erase" ? "ink" : this.selectedColor;
        this.board.publish("text", {
          text: this.textInput.trim(),
          point,
          color: col,
          size: this.textSize,
        });
      }
      return;
    }

    this.drawing = true;
    if (this.tool === "erase") {
      this.board.publish("erase", { point });
    } else if (isShapeTool(this.tool)) {
      this.dragStart = point;
      this.dragCurrent = point;
    } else if (this.tool === "mark") {
      this.board.publish("stroke-begin", { color: "mark", width: 8, point });
    } else {
      const col = this.selectedColor === "erase" ? "ink" : this.selectedColor;
      this.board.publish("stroke-begin", { color: col, width: this.selectedWidth, point });
    }
  }

  move(event: PointerEvent): void {
    if (!this.drawing) return;
    const point = this.coord(event);
    if (!point) return;

    if (isShapeTool(this.tool)) {
      this.dragCurrent = point;
      const ctx = this.canvasRef.nativeElement.getContext("2d");
      if (ctx) {
        paintWhiteboard(ctx, this.board.ops());
        if (this.dragStart) {
          const col = this.selectedColor === "erase" ? "ink" : this.selectedColor;
          paintShapePreview(ctx, this.tool, this.dragStart, this.dragCurrent, col, this.selectedWidth);
        }
      }
    } else if (this.tool === "erase") {
      this.board.publish("erase", { point });
    } else {
      this.board.publish("stroke-point", { points: [point] });
    }
  }

  up(event: PointerEvent): void {
    if (!this.drawing) return;
    this.drawing = false;
    const point = this.coord(event);

    if (isShapeTool(this.tool) && this.dragStart && point) {
      const col = this.selectedColor === "erase" ? "ink" : this.selectedColor;
      this.board.publish("shape", {
        shape: this.tool,
        color: col,
        width: this.selectedWidth,
        start: this.dragStart,
        end: point,
      });
      this.dragStart = null;
      this.dragCurrent = null;
    } else if (point && this.tool !== "erase") {
      this.board.publish("stroke-end", { point });
    }
  }
}

