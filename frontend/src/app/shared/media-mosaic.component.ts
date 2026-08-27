import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  Input,
  OnChanges,
  OnDestroy,
  ViewChild,
} from "@angular/core";

import { RemoteMediaView } from "../webrtc/peer-mesh.service";

export function mosaicGrid(itemCount: number): Readonly<{ columns: number; rows: number }> {
  const count = Math.max(1, Math.trunc(itemCount));
  const columns = Math.ceil(Math.sqrt(count));
  return { columns, rows: Math.ceil(count / columns) };
}

@Component({
  selector: "app-media-mosaic",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <canvas #canvas class="mosaic-canvas" role="img" [attr.aria-label]="label"></canvas>
    <ul class="sr-only">
      @for (item of items; track item.key) { <li>{{ item.peerName }} · Kamera bandbreitenreduziert im Mosaik</li> }
    </ul>
  `,
})
export class MediaMosaicComponent implements AfterViewInit, OnChanges, OnDestroy {
  @Input({ required: true }) items: readonly RemoteMediaView[] = [];
  @ViewChild("canvas", { static: true }) canvasRef!: ElementRef<HTMLCanvasElement>;
  readonly label = "Zusammengeführte, bandbreitenreduzierte Vorschau inaktiver Teilnehmer";
  private readonly videos = new Map<string, HTMLVideoElement>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private ready = false;

  ngAfterViewInit(): void {
    this.ready = true;
    this.syncVideos();
    this.draw();
    this.timer = setInterval(() => this.draw(), 1_000);
  }

  ngOnChanges(): void {
    if (this.ready) {
      this.syncVideos();
      this.draw();
    }
  }

  ngOnDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const video of this.videos.values()) {
      video.pause();
      video.srcObject = null;
    }
    this.videos.clear();
  }

  private syncVideos(): void {
    const current = new Set(this.items.map((item) => item.key));
    for (const [key, video] of this.videos) {
      if (current.has(key)) continue;
      video.pause();
      video.srcObject = null;
      this.videos.delete(key);
    }
    for (const item of this.items) {
      if (this.videos.has(item.key)) continue;
      const video = document.createElement("video");
      video.muted = true;
      video.playsInline = true;
      video.srcObject = item.stream;
      void video.play().catch(() => undefined);
      this.videos.set(item.key, video);
    }
  }

  private draw(): void {
    const canvas = this.canvasRef.nativeElement;
    const width = Math.max(640, Math.trunc(canvas.clientWidth * Math.min(2, devicePixelRatio || 1)));
    const grid = mosaicGrid(this.items.length);
    const height = Math.max(240, Math.round(width * (9 / 16) * grid.rows / grid.columns));
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) return;
    context.fillStyle = "#020705";
    context.fillRect(0, 0, width, height);
    const cellWidth = width / grid.columns;
    const cellHeight = height / grid.rows;
    this.items.forEach((item, index) => {
      const x = (index % grid.columns) * cellWidth;
      const y = Math.floor(index / grid.columns) * cellHeight;
      const video = this.videos.get(item.key);
      if (video && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
        context.drawImage(video, x, y, cellWidth, cellHeight);
      } else {
        context.fillStyle = "#15352e";
        context.fillRect(x, y, cellWidth, cellHeight);
      }
      context.strokeStyle = "rgba(176, 222, 207, .25)";
      context.strokeRect(x, y, cellWidth, cellHeight);
      context.fillStyle = "rgba(0, 0, 0, .72)";
      context.fillRect(x + 8, y + 8, Math.min(cellWidth - 16, 180), 28);
      context.fillStyle = "#eafff7";
      context.font = `${Math.max(12, Math.round(width / 70))}px sans-serif`;
      context.fillText(item.peerName, x + 16, y + 27, cellWidth - 30);
    });
  }
}
