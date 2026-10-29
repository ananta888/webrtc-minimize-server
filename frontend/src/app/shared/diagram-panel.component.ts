import {
  AfterViewChecked,
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnDestroy,
  ViewChild,
  effect,
  signal,
} from "@angular/core";
import { FormsModule } from "@angular/forms";
import { DomSanitizer, SafeResourceUrl } from "@angular/platform-browser";

import { DiagramTool } from "../webrtc/diagram-contract";
import {
  DRAWIO_EMBED_URL,
  drawioConfigureMessage,
  drawioLoadMessage,
  encodeDrawioAction,
  parseDrawioEvent,
} from "../webrtc/diagram-drawio-bridge";
import { DiagramService } from "../webrtc/diagram.service";
import { RoomModerationService } from "../webrtc/room-moderation.service";
import { RoomSessionService } from "../webrtc/room-session.service";

interface DiagramEditorCanvas {
  viewbox(): unknown;
  viewbox(box: unknown): void;
}

interface DiagramEditorOverlays {
  add(elementId: string, type: string, options: { position: Record<string, number>; html: string }): void;
  remove(filter: { type: string }): void;
}

interface DiagramEditor {
  importXML(xml: string): Promise<unknown>;
  saveXML(options?: { format?: boolean }): Promise<{ xml: string }>;
  get(name: string): unknown;
  destroy(): void;
}

@Component({
  selector: "app-diagram-panel",
  standalone: true,
  imports: [FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="diagram-panel" aria-label="Gemeinsame Diagramme">
      <div class="diagram-topbar" role="toolbar" aria-label="Diagramm-Werkzeuge">
        <label class="sr-only" for="diagram-tool-select">Werkzeug</label>
        <select id="diagram-tool-select" class="diagram-tool-select" [ngModel]="diagram.activeTool()"
                [disabled]="!diagram.canEdit()" (ngModelChange)="selectTool($any($event))">
          <option value="bpmn">BPMN-Prozesse</option>
          <option value="drawio">Diagramm-Editor</option>
        </select>
        @if (diagram.activeTool() === 'bpmn') {
          @if (diagram.canEdit() && selectedElementId()) {
            @if (lockOwner() === '') {
              <button id="diagram-lock-element" type="button" class="button ghost compact" (click)="lockSelected()">Element sperren</button>
            } @else if (lockOwner() === ownPeerId()) {
              <button id="diagram-unlock-element" type="button" class="button ghost compact" (click)="unlockSelected()">Sperre lösen</button>
            }
          }
          <button id="diagram-export-bpmn" type="button" class="button ghost compact" (click)="exportBpmn()">Export .bpmn</button>
        } @else {
          <button id="diagram-export-drawio" type="button" class="button ghost compact" (click)="exportDrawio()">Export .drawio</button>
        }
        <span class="diagram-topbar-spacer"></span>
        @if (!diagram.canEdit()) {
          <span class="diagram-badge read-only" id="diagram-read-only-badge">Lese-Modus</span>
        }
        @if (moderation.canControlDiagram()) {
          <button id="diagram-toggle-policy" type="button" class="button ghost compact" (click)="togglePolicy()">
            {{ moderation.diagramPolicy() === 'open' ? 'Auf Presenter beschränken' : 'Für alle freigeben' }}
          </button>
        }
      </div>

      @if (diagram.activeTool() === 'bpmn') {
        <div class="diagram-editor-host" [class.readonly]="!diagram.canEdit()" #editorHost></div>
      } @else {
        <div class="diagram-editor-host drawio-host" [class.readonly]="!diagram.canEdit()">
          <iframe id="diagram-drawio-frame" title="Diagramm-Editor" #drawioFrame [src]="drawioUrl"></iframe>
        </div>
      }
      @if (editorError()) {
        <p class="diagram-editor-error" id="diagram-editor-error" role="alert">Der Editor konnte nicht gestartet werden: {{ editorError() }}</p>
      }
      <p class="sr-only">Bearbeitung ist standardmäßig für alle Teilnehmer freigegeben. Elemente lassen sich sichtbar sperren — die Sperre ist eine Absprache und kein harter Bearbeitungsschutz. Inhalte laufen nur über den verschlüsselten Peer-Pfad.</p>
    </section>
  `,
  styles: [`
    .diagram-panel { display: flex; flex-direction: column; gap: 0.5rem; height: calc(100vh - 9rem); min-height: 30rem; }
    :host-context(.has-session-dock) .diagram-panel { height: calc(100vh - 15.5rem); }
    .diagram-topbar { display: flex; flex-wrap: wrap; align-items: center; gap: 0.5rem; }
    .diagram-tool-select { width: auto; min-width: 11rem; }
    .diagram-topbar-spacer { flex: 1 1 auto; }
    .diagram-editor-host { flex: 1 1 auto; min-height: 0; border: 1px solid var(--border, #d8d8d8); border-radius: 8px; overflow: hidden; background: #fff; color: #22242a; }
    .diagram-editor-host.readonly { opacity: 0.75; }
    .diagram-editor-host.readonly :not(.bjs-powered-by) { pointer-events: none; }
    .diagram-editor-host.drawio-host iframe { display: block; width: 100%; height: 100%; border: 0; }
    .diagram-editor-error { color: var(--danger-text, #b02a37); margin: 0; }
    :host ::ng-deep .djs-popup-parent input {
      width: auto; border: 1px solid #cfd6de; border-radius: 4px; padding: 4px 6px;
      color: #22242a; background: #fff; font-size: 12px;
    }
    :host ::ng-deep .djs-popup-parent input:focus {
      border-color: #22242a; box-shadow: none; background: #fff;
    }
    .diagram-badge.read-only { background: var(--warning-bg, #fff3cd); color: var(--warning-text, #664d03); }
    :host ::ng-deep .diagram-lock-badge {
      background: var(--warning-bg, #fff3cd); color: var(--warning-text, #664d03);
      border-radius: 4px; padding: 0 4px; font-size: 11px; white-space: nowrap;
    }
  `],
})
export class DiagramPanelComponent implements AfterViewInit, AfterViewChecked, OnDestroy {
  @ViewChild("editorHost") private editorHost?: ElementRef<HTMLDivElement>;
  @ViewChild("drawioFrame") private drawioFrame?: ElementRef<HTMLIFrameElement>;

  readonly selectedElementId = signal("");
  readonly editorReady = signal(false);
  readonly editorError = signal("");
  readonly drawioUrl: SafeResourceUrl;
  readonly drawioReady = signal(false);
  private modeler: DiagramEditor | null = null;
  private hostElement: HTMLDivElement | null = null;
  private appliedRevision = 0;
  private appliedDrawioRevision = 0;
  private lastSyncedDrawioXml = "";
  private suppressPublish = false;
  private destroyed = false;
  private readonly messageHandler = (event: MessageEvent) => this.onDrawioMessage(event);

  constructor(
    readonly diagram: DiagramService,
    readonly moderation: RoomModerationService,
    readonly session: RoomSessionService,
    sanitizer: DomSanitizer,
  ) {
    this.drawioUrl = sanitizer.bypassSecurityTrustResourceUrl(DRAWIO_EMBED_URL);
    effect(() => {
      const doc = this.diagram.docs().get("bpmn");
      if (!doc || !this.editorReady() || doc.revision === this.appliedRevision) return;
      if (doc.authorPeerId === this.session.peerId()) {
        this.appliedRevision = doc.revision;
        return;
      }
      void this.applyRemote(doc.xml, doc.revision);
    });
    effect(() => {
      if (!this.editorReady()) return;
      this.renderLockBadges();
    });
    effect(() => {
      const doc = this.diagram.docs().get("drawio");
      if (!doc || !this.drawioReady() || doc.revision === this.appliedDrawioRevision) return;
      if (doc.authorPeerId === this.session.peerId()) {
        this.appliedDrawioRevision = doc.revision;
        return;
      }
      this.lastSyncedDrawioXml = doc.xml;
      this.postToDrawio(drawioLoadMessage(doc.xml));
      this.appliedDrawioRevision = doc.revision;
    });
    window.addEventListener("message", this.messageHandler);
  }

  ngAfterViewInit(): void {
    void this.initEditor();
  }

  ngAfterViewChecked(): void {
    const host = this.editorHost?.nativeElement || null;
    if (!host || host === this.hostElement) return;
    this.hostElement = host;
    if (this.modeler) {
      try { this.modeler.destroy(); } catch { /* already destroyed */ }
      this.modeler = null;
      this.editorReady.set(false);
      this.appliedRevision = 0;
    }
    void this.initEditor();
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    window.removeEventListener("message", this.messageHandler);
    this.modeler?.destroy();
    this.modeler = null;
    this.editorReady.set(false);
    this.drawioReady.set(false);
  }

  ownPeerId(): string {
    return this.session.peerId();
  }

  lockOwner(): string {
    const elementId = this.selectedElementId();
    return elementId ? this.diagram.locks().get(elementId)?.ownerPeerId || "" : "";
  }

  selectTool(value: unknown): void {
    if (value !== "bpmn" && value !== "drawio") return;
    this.diagram.setTool(value as DiagramTool);
  }

  togglePolicy(): void {
    this.moderation.setDiagramPolicy(this.moderation.diagramPolicy() === "open" ? "presenter-only" : "open");
  }

  lockSelected(): void {
    const elementId = this.selectedElementId();
    if (elementId) this.diagram.setLock(elementId, true);
  }

  unlockSelected(): void {
    const elementId = this.selectedElementId();
    if (elementId) this.diagram.setLock(elementId, false);
  }

  async exportBpmn(): Promise<void> {
    if (!this.modeler) return;
    const { xml } = await this.modeler.saveXML({ format: true });
    const url = URL.createObjectURL(new Blob([xml], { type: "application/xml" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "diagramm.bpmn";
    anchor.click();
    URL.revokeObjectURL(url);
  }

  exportDrawio(): void {
    this.diagram.flushSnapshot();
    const xml = this.diagram.doc("drawio")?.xml || "";
    if (!xml) return;
    const url = URL.createObjectURL(new Blob([xml], { type: "application/xml" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "diagramm.drawio";
    anchor.click();
    URL.revokeObjectURL(url);
  }

  private onDrawioMessage(event: MessageEvent): void {
    if (event.origin !== window.location.origin) return;
    const frameWindow = this.drawioFrame?.nativeElement.contentWindow;
    if (!frameWindow || event.source !== frameWindow) return;
    const message = parseDrawioEvent(event.data);
    if (!message) return;
    if (message.event === "configure") {
      this.postToDrawio(drawioConfigureMessage());
      return;
    }
    if (message.event === "init") {
      const doc = this.diagram.doc("drawio");
      this.lastSyncedDrawioXml = doc?.xml ?? "";
      this.appliedDrawioRevision = doc?.revision ?? 0;
      this.drawioReady.set(true);
      this.editorError.set("");
      this.postToDrawio(drawioLoadMessage(this.lastSyncedDrawioXml));
      return;
    }
    if (message.event === "autosave" || message.event === "save") {
      if (message.xml === undefined || message.xml === this.lastSyncedDrawioXml) return;
      this.lastSyncedDrawioXml = message.xml;
      this.diagram.scheduleSnapshot("drawio", message.xml);
    }
  }

  private postToDrawio(message: Readonly<Record<string, unknown>>): void {
    this.drawioFrame?.nativeElement.contentWindow?.postMessage(
      encodeDrawioAction(message),
      window.location.origin,
    );
  }

  private async initEditor(): Promise<void> {
    if (!this.hostElement || this.modeler || this.destroyed) return;
    this.suppressPublish = true;
    try {
      this.ensureStyles();
      const { default: Modeler } = await import("bpmn-js/lib/Modeler");
      if (this.destroyed || !this.hostElement) return;
      this.modeler = new Modeler({ container: this.hostElement }) as unknown as DiagramEditor;
      const doc = this.diagram.doc("bpmn");
      if (doc) {
        await this.modeler.importXML(doc.xml);
        this.appliedRevision = doc.revision;
      } else {
        await (this.modeler as unknown as { createDiagram(): Promise<unknown> }).createDiagram();
        this.appliedRevision = 0;
      }
      const eventBus = this.modeler.get("eventBus") as {
        on(event: string, handler: (event: never) => void): void;
      };
      eventBus.on("commandStack.changed", () => this.onLocalChange());
      eventBus.on("selection.changed", (event: never) => {
        const selection = (event as { newSelection?: readonly { id?: string }[] }).newSelection || [];
        this.selectedElementId.set(selection[0]?.id || "");
      });
      eventBus.on("element.contextmenu", (event: never) => {
        const menuEvent = event as {
          element?: unknown;
          x?: number;
          y?: number;
          clientX?: number;
          clientY?: number;
          preventDefault?: () => void;
          originalEvent?: { preventDefault?: () => void; clientX?: number; clientY?: number };
        };
        menuEvent.preventDefault?.();
        menuEvent.originalEvent?.preventDefault?.();
        const modeler = this.modeler;
        if (!modeler || !menuEvent.element) return;
        const popupMenu = modeler.get("popupMenu") as {
          isEmpty(target: unknown, provider: string): boolean;
          open(target: unknown, provider: string, position: unknown, options?: unknown): void;
        };
        if (popupMenu.isEmpty(menuEvent.element, "bpmn-replace")) return;
        const clientX = menuEvent.originalEvent?.clientX ?? menuEvent.clientX ?? menuEvent.x ?? 0;
        const clientY = menuEvent.originalEvent?.clientY ?? menuEvent.clientY ?? menuEvent.y ?? 0;
        popupMenu.open(
          menuEvent.element,
          "bpmn-replace",
          { x: clientX, y: clientY, cursor: { x: menuEvent.x, y: menuEvent.y } },
          { title: "Element ändern", width: "var(--bpmn-replace-popup-width, 300px)", search: true },
        );
      });
      this.editorError.set("");
      this.editorReady.set(true);
      this.renderLockBadges();
    } catch (error) {
      this.modeler = null;
      this.editorReady.set(false);
      this.editorError.set(error instanceof Error ? error.message : "editor_start_failed");
    } finally {
      this.suppressPublish = false;
    }
  }

  private ensureStyles(): void {
    for (const href of [
      "/assets/bpmn/diagram-js.css",
      "/assets/bpmn/bpmn-js.css",
      "/assets/bpmn/bpmn-font/css/bpmn.css",
    ]) {
      if (document.querySelector(`link[data-diagram-style="${href}"]`)) continue;
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = href;
      link.setAttribute("data-diagram-style", href);
      document.head.append(link);
    }
  }

  private onLocalChange(): void {
    if (this.suppressPublish) return;
    void this.saveAndSchedule();
  }

  private async saveAndSchedule(): Promise<void> {
    if (!this.modeler) return;
    const { xml } = await this.modeler.saveXML({ format: true });
    this.diagram.scheduleSnapshot("bpmn", xml);
  }

  private async applyRemote(xml: string, revision: number): Promise<void> {
    if (!this.modeler) return;
    this.suppressPublish = true;
    try {
      const canvas = this.modeler.get("canvas") as DiagramEditorCanvas;
      const viewbox = canvas.viewbox();
      await this.modeler.importXML(xml);
      canvas.viewbox(viewbox);
      this.appliedRevision = revision;
    } catch {
      // Keep the previous diagram when a remote document is not importable.
    } finally {
      this.suppressPublish = false;
    }
  }

  private renderLockBadges(): void {
    if (!this.modeler) return;
    const overlays = this.modeler.get("overlays") as DiagramEditorOverlays;
    overlays.remove({ type: "diagram-lock" });
    for (const [elementId, entry] of this.diagram.locks()) {
      const label = entry.ownerPeerId === this.session.peerId() ? "Gesperrt (du)" : "Gesperrt";
      overlays.add(elementId, "diagram-lock", {
        position: { top: -10, right: -10 },
        html: `<span class="diagram-lock-badge" title="${label}">${label}</span>`,
      });
    }
  }
}
