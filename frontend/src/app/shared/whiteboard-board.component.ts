import {
  AfterViewInit, ChangeDetectionStrategy, Component, ElementRef, OnDestroy, ViewChild, effect,
} from "@angular/core";

import { WhiteboardColor, WhiteboardOperation } from "../webrtc/whiteboard-contract";
import { WhiteboardOverlayService } from "../webrtc/whiteboard-overlay.service";
import { RoomSessionService } from "../webrtc/room-session.service";

const WIDTH = 640;
const HEIGHT = 360;

function pixel(point: { x: number; y: number }): { x: number; y: number } {
  return { x: (point.x / 1000) * WIDTH, y: (point.y / 1000) * HEIGHT };
}

function color(value: string): string {
  if (value === "mark") return "#e6c35c";
  if (value === "erase") return "#020408";
  return "#e8eef6";
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
      <div class="whiteboard-tools">
        <label>Stift
          <select id="whiteboard-color" [disabled]="!session.joined()" (change)="tool = $any($event.target).value">
            <option value="ink">Tinte</option>
            <option value="mark">Marker</option>
            <option value="erase">Radierer</option>
          </select>
        </label>
        <button id="whiteboard-undo" type="button" class="button ghost compact" [disabled]="!session.joined()"
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
    .whiteboard-tools { display: flex; flex-wrap: wrap; gap: .45rem; align-items: end; }
    canvas { width: 100%; max-width: 40rem; border: 1px solid var(--line); border-radius: .7rem; background: #020408; touch-action: none; cursor: crosshair; }
  `],
})
export class WhiteboardBoardComponent implements AfterViewInit, OnDestroy {
  @ViewChild("canvas", { static: true }) canvasRef!: ElementRef<HTMLCanvasElement>;
  tool: WhiteboardColor = "ink";
  private drawing = false;
  constructor(readonly session: RoomSessionService, readonly board: WhiteboardOverlayService) {
    effect(() => {
      const ops = this.board.ops();
      const canvas = this.canvasRef?.nativeElement;
      const ctx = canvas?.getContext("2d");
      if (ctx) paintWhiteboard(ctx, ops);
    });
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
    const point = this.coord(event);
    if (!point) return;
    event.preventDefault();
    this.drawing = true;
    this.canvasRef.nativeElement.setPointerCapture(event.pointerId);
    if (this.tool === "erase") this.board.publish("erase", { point });
    else this.board.publish("stroke-begin", { color: this.tool, width: this.tool === "mark" ? 8 : 2, point });
  }
  move(event: PointerEvent): void {
    if (!this.drawing) return;
    const point = this.coord(event);
    if (!point) return;
    if (this.tool === "erase") this.board.publish("erase", { point });
    else this.board.publish("stroke-point", { points: [point] });
  }
  up(event: PointerEvent): void {
    if (!this.drawing) return;
    this.drawing = false;
    const point = this.coord(event);
    if (point && this.tool !== "erase") this.board.publish("stroke-end", { point });
  }
}
