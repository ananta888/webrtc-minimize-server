import { ChangeDetectionStrategy, Component, OnDestroy, OnInit, computed, signal } from "@angular/core";

import {
  MeshAnalysisEdge,
  MeshAnalysisGraph,
  MeshAnalysisNode,
  MeshAnalysisService,
} from "../webrtc/mesh-analysis.service";

export interface PositionedMeshNode extends MeshAnalysisNode {
  readonly x: number;
  readonly y: number;
  readonly radius: number;
}

export interface PositionedMeshEdge extends MeshAnalysisEdge {
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
  readonly labelX: number;
  readonly labelY: number;
}

export interface MeshGraphLayout {
  readonly nodes: readonly PositionedMeshNode[];
  readonly edges: readonly PositionedMeshEdge[];
}

const WIDTH = 1_000;
const HEIGHT = 620;

function labelOffset(id: string): number {
  const hash = [...id].reduce((value, character) => ((value * 31) + character.charCodeAt(0)) >>> 0, 0);
  return 10 + (hash % 3) * 8;
}

export function layoutMeshGraph(graph: MeshAnalysisGraph): MeshGraphLayout {
  const participants = graph.nodes
    .filter(({ kind }) => kind === "participant")
    .sort((left, right) => Number(right.own) - Number(left.own) || left.targetId.localeCompare(right.targetId));
  const agents = graph.nodes
    .filter(({ kind }) => kind === "media-agent")
    .sort((left, right) => left.targetId.localeCompare(right.targetId));
  const positioned: PositionedMeshNode[] = [];
  if (participants.length === 1 && agents.length === 0) {
    positioned.push(Object.freeze({ ...participants[0], x: WIDTH / 2, y: HEIGHT / 2, radius: 38 }));
  } else {
    participants.forEach((node, index) => {
      const angle = -Math.PI / 2 + (index * Math.PI * 2) / Math.max(1, participants.length);
      positioned.push(Object.freeze({
        ...node,
        x: Math.round(WIDTH / 2 + Math.cos(angle) * 400),
        y: Math.round(HEIGHT / 2 + Math.sin(angle) * 245),
        radius: 34,
      }));
    });
    agents.forEach((node, index) => {
      const spread = agents.length === 1 ? 0 : (index - (agents.length - 1) / 2) * 116;
      positioned.push(Object.freeze({ ...node, x: WIDTH / 2 + spread, y: HEIGHT / 2, radius: 42 }));
    });
  }
  const byId = new Map(positioned.map((node) => [node.id, node]));
  const edges: PositionedMeshEdge[] = [];
  for (const edge of graph.edges) {
    const from = byId.get(edge.from);
    const to = byId.get(edge.to);
    if (!from || !to) continue;
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const distance = Math.max(1, Math.hypot(dx, dy));
    const unitX = dx / distance;
    const unitY = dy / distance;
    const offset = labelOffset(edge.id) * (edge.id.length % 2 === 0 ? 1 : -1);
    edges.push(Object.freeze({
      ...edge,
      x1: Math.round(from.x + unitX * from.radius),
      y1: Math.round(from.y + unitY * from.radius),
      x2: Math.round(to.x - unitX * to.radius),
      y2: Math.round(to.y - unitY * to.radius),
      labelX: Math.round((from.x + to.x) / 2 - unitY * offset),
      labelY: Math.round((from.y + to.y) / 2 + unitX * offset),
    }));
  }
  return Object.freeze({ nodes: Object.freeze(positioned), edges: Object.freeze(edges) });
}

export function formatBitrate(bitsPerSecond: number | null): string {
  if (bitsPerSecond === null || !Number.isFinite(bitsPerSecond)) return "nicht messbar";
  const bounded = Math.max(0, bitsPerSecond);
  if (bounded >= 1_000_000) {
    return `${new Intl.NumberFormat("de-DE", { maximumFractionDigits: bounded >= 10_000_000 ? 1 : 2 }).format(bounded / 1_000_000)} Mbit/s`;
  }
  return `${new Intl.NumberFormat("de-DE", { maximumFractionDigits: bounded < 10_000 ? 1 : 0 }).format(bounded / 1_000)} kbit/s`;
}

@Component({
  selector: "app-mesh-analysis",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="analysis-shell" aria-labelledby="mesh-analysis-heading">
      <header class="analysis-heading">
        <div>
          <p class="eyebrow">Live-Telemetrie</p>
          <h1 id="mesh-analysis-heading">Mesh-Analyse</h1>
          <p>Aktuelle PeerConnections, Trusted Relays und Media-Agent-Routen dieses Raums. Die Raten sind kurze Näherungswerte aus WebRTC-Bytezählern.</p>
        </div>
        <label class="idle-toggle">
          <input id="mesh-show-idle" type="checkbox" [checked]="showIdleEdges()" (change)="setShowIdle($event)">
          <span><strong>Inaktive Kanten</strong><small>Auch Verbindungen ohne aktuelle Nutzdaten zeigen</small></span>
        </label>
      </header>

      @if (graph().nodes.length === 0) {
        <section class="surface empty-analysis" id="mesh-analysis-empty">
          <span class="empty-orbit" aria-hidden="true"><span></span></span>
          <div><h2>Noch keine Raumtopologie</h2><p>Tritt einem Raum bei. Die Analyse startet ohne Mikrofon-, Kamera- oder Bildschirmfreigabe.</p></div>
        </section>
      } @else {
        <div class="analysis-summary" aria-label="Topologie-Zusammenfassung">
          <div><span>Knoten</span><strong id="mesh-node-count">{{ graph().nodes.length }}</strong></div>
          <div><span>Sichtbare Kanten</span><strong id="mesh-edge-count">{{ visibleEdges().length }}</strong></div>
          <div><span>Topologie</span><strong>{{ topologyLabel(graph().topologyMode) }}</strong></div>
          <div><span>Gesamt beobachtet</span><strong>{{ formatBitrate(observedBitrate()) }}</strong></div>
        </div>

        <section class="analysis-grid">
          <div class="surface graph-panel">
            <div class="graph-toolbar">
              <div><span class="legend-dot participant"></span>Browser</div>
              <div><span class="legend-dot agent"></span>Media-Agent</div>
              <div><span class="legend-line relay"></span>Trusted Relay</div>
              <div><span class="legend-line federation"></span>Agent-Föderation</div>
              <div><span class="legend-line reported"></span>Peer-gemeldet</div>
            </div>
            <div class="graph-scroll">
              <svg id="mesh-analysis-graph" viewBox="0 0 1000 620" role="img" aria-labelledby="mesh-graph-title mesh-graph-description">
                <title id="mesh-graph-title">Interaktive WebRTC-Raumtopologie</title>
                <desc id="mesh-graph-description">Knoten sind Teilnehmer oder Media-Agenten. Kanten zeigen Verbindungen und ihre summierte Sende- und Empfangsrate.</desc>
                @for (edge of visibleEdges(); track edge.id) {
                  <g class="mesh-edge" [class.direct]="edge.kind === 'direct'" [class.trusted-relay]="edge.kind === 'trusted-relay'" [class.media-agent]="edge.kind === 'media-agent'" [class.agent-federation]="edge.kind === 'agent-federation'" [class.peer-reported]="edge.measurementSource === 'peer-reported'" [class.not-ready]="!edge.ready">
                    <line [attr.x1]="edge.x1" [attr.y1]="edge.y1" [attr.x2]="edge.x2" [attr.y2]="edge.y2"></line>
                    <rect class="edge-label-bg" [attr.x]="edge.labelX - edgeLabelWidth(edge) / 2" [attr.y]="edge.labelY - 12" [attr.width]="edgeLabelWidth(edge)" height="24" rx="8"></rect>
                    <text class="edge-label" [attr.x]="edge.labelX" [attr.y]="edge.labelY + 4">{{ edgeLabel(edge) }}</text>
                    <title>{{ edgeTitle(edge) }}</title>
                  </g>
                }
                @for (node of layout().nodes; track node.id) {
                  <g
                    class="mesh-node"
                    [class.agent]="node.kind === 'media-agent'"
                    [class.own]="node.own"
                    [class.selected]="selectedNode().id === node.id"
                    [attr.transform]="'translate(' + node.x + ' ' + node.y + ')'"
                    role="button"
                    tabindex="0"
                    [attr.aria-label]="nodeAriaLabel(node)"
                    [attr.aria-pressed]="selectedNode().id === node.id"
                    (click)="selectNode(node.id)"
                    (keydown)="activateNode($event, node.id)"
                  >
                    @if (node.kind === 'media-agent') {
                      <rect [attr.x]="-node.radius" [attr.y]="-node.radius" [attr.width]="node.radius * 2" [attr.height]="node.radius * 2" rx="14"></rect>
                      <path class="node-glyph" d="M-13 -6h26v18h-26zM-7 18h14M0 12v6M-7 1h3M1 1h6"></path>
                    } @else {
                      <circle cx="0" cy="0" [attr.r]="node.radius"></circle>
                      <circle class="node-head" cx="0" cy="-7" r="8"></circle>
                      <path class="node-glyph" d="M-15 18c2-12 28-12 30 0"></path>
                    }
                    @if (node.own) { <circle class="own-indicator" [attr.cx]="node.radius - 4" [attr.cy]="-node.radius + 4" r="6"></circle> }
                    <text class="node-label" x="0" [attr.y]="node.radius + 22">{{ shortLabel(node.label) }}</text>
                    <text class="node-rate" x="0" [attr.y]="node.radius + 39">↑ {{ formatBitrate(node.outgoingBps) }}</text>
                    <title>{{ nodeAriaLabel(node) }}</title>
                  </g>
                }
              </svg>
            </div>
            <p class="graph-note">Kantenwerte sind Upload plus Download der Verbindung. Durchgezogene Werte stammen von diesem Browser; gestrichelte Werte sind kurzlebige Angaben der jeweiligen Raum-Peers. „–“ bedeutet nicht lokal messbar.</p>
          </div>

          <aside class="surface node-details" aria-live="polite">
            @if (selectedNode(); as node) {
              <div class="detail-heading">
                <span class="detail-avatar" [class.agent]="node.kind === 'media-agent'">{{ node.kind === 'media-agent' ? 'A' : node.label.slice(0, 1).toUpperCase() }}</span>
                <div><p class="eyebrow">Ausgewählter Knoten</p><h2 id="mesh-selected-node">{{ node.label }}</h2><code>{{ node.targetId }}</code></div>
              </div>

              <section class="traffic-detail" aria-labelledby="mesh-traffic-heading">
                <div class="detail-section-heading"><h3 id="mesh-traffic-heading">Datenrate nach Inhalt</h3><small>Upload / Download</small></div>
                <dl>
                  <div class="total"><dt>Gesamt</dt><dd><strong>{{ formatBitrate(node.outgoingBps) }}</strong><span>{{ formatBitrate(node.incomingBps) }}</span></dd></div>
                  <div><dt><span class="media-dot audio"></span>Audio</dt><dd><strong>{{ formatBitrate(node.audioOutgoingBps) }}</strong><span>{{ formatBitrate(node.audioIncomingBps) }}</span></dd></div>
                  <div><dt><span class="media-dot video"></span>Kamera / Video</dt><dd><strong>{{ formatBitrate(node.videoOutgoingBps) }}</strong><span>{{ formatBitrate(node.videoIncomingBps) }}</span></dd></div>
                  <div><dt><span class="media-dot screen"></span>Bildschirmteilen</dt><dd><strong>{{ formatBitrate(node.screenOutgoingBps) }}</strong><span>{{ formatBitrate(node.screenIncomingBps) }}</span></dd></div>
                  <div><dt><span class="media-dot data"></span>DataChannel</dt><dd><strong>{{ formatBitrate(node.dataOutgoingBps) }}</strong><span>{{ formatBitrate(node.dataIncomingBps) }}</span></dd></div>
                </dl>
              </section>

              <dl class="node-facts">
                <div><dt>Typ</dt><dd>{{ nodeTypeLabel(node) }}</dd></div>
                <div><dt>Eigener Knoten</dt><dd>{{ node.own ? 'ja' : 'nein' }}</dd></div>
                <div><dt>Status</dt><dd>{{ node.connectionState }}</dd></div>
                <div><dt>Rolle</dt><dd>{{ nodeRoleLabel(node) }}</dd></div>
                <div><dt>ICE-Pfad</dt><dd>{{ node.icePath }}</dd></div>
                <div><dt>Linkklasse</dt><dd>{{ node.linkClass }}</dd></div>
                <div><dt>Freigaben</dt><dd>{{ publicationLabel(node) }}</dd></div>
                @if (node.kind === 'media-agent') {
                  <div><dt>Owner Peer-ID</dt><dd><code>{{ node.ownerPeerId }}</code></dd></div>
                  <div><dt>Bereite Browser</dt><dd>{{ node.readyPeerCount }}</dd></div>
                }
                <div><dt>Membership-Epoche</dt><dd>{{ graph().membershipEpoch || 'ausstehend' }}</dd></div>
                <div><dt>Route-Epoche</dt><dd>{{ graph().routeEpoch || 'ausstehend' }}</dd></div>
                <div><dt>Agent-Route-Epoche</dt><dd>{{ graph().mediaAgentRouteEpoch || 'nicht aktiv' }}</dd></div>
                <div><dt>Topologie-Epoche</dt><dd>{{ graph().topologyEpoch || 'ausstehend' }}</dd></div>
              </dl>

              <section class="connection-details">
                <h3>Verbindungen dieses Knotens</h3>
                @for (connection of selectedConnections(); track connection.edge.id) {
                  <article>
                    <div><strong>{{ connection.other.label }}</strong><span>{{ edgeKindLabel(connection.edge.kind) }}</span></div>
                    <dl>
                      <div><dt>Upload dorthin</dt><dd>{{ formatBitrate(connection.outgoing) }}</dd></div>
                      <div><dt>Download von dort</dt><dd>{{ formatBitrate(connection.incoming) }}</dd></div>
                      <div><dt>Messquelle</dt><dd>{{ measurementLabel(connection.edge.measurementSource) }}</dd></div>
                      <div><dt>Rollen</dt><dd>{{ connection.edge.roles.join(', ') }}</dd></div>
                    </dl>
                  </article>
                } @empty {
                  <p>Noch keine autorisierte Verbindung für diesen Knoten.</p>
                }
              </section>
            }
          </aside>
        </section>
      }
    </section>
  `,
})
export class MeshAnalysisComponent implements OnInit, OnDestroy {
  readonly showIdleEdges = signal(false);
  readonly selectedNodeId = signal("");
  readonly graph = this.analysis.graph;
  readonly layout = computed(() => layoutMeshGraph(this.graph()));
  readonly visibleEdges = computed(() => this.layout().edges.filter((edge) => (
    this.showIdleEdges() || edge.kind !== "direct" || (edge.totalBps !== null && edge.totalBps > 0)
  )));
  readonly selectedNode = computed(() => {
    const nodes = this.layout().nodes;
    return nodes.find(({ id }) => id === this.selectedNodeId())
      || nodes.find(({ own }) => own)
      || nodes[0]
      || null;
  });
  readonly selectedConnections = computed(() => {
    const node = this.selectedNode();
    if (!node) return [];
    const nodes = new Map(this.layout().nodes.map((entry) => [entry.id, entry]));
    return this.layout().edges.filter((edge) => edge.from === node.id || edge.to === node.id).map((edge) => {
      const selectedIsFrom = edge.from === node.id;
      return {
        edge,
        other: nodes.get(selectedIsFrom ? edge.to : edge.from)!,
        outgoing: (selectedIsFrom ? edge.fromTo : edge.toFrom)?.totalBps ?? null,
        incoming: (selectedIsFrom ? edge.toFrom : edge.fromTo)?.totalBps ?? null,
      };
    }).filter(({ other }) => Boolean(other));
  });
  readonly observedBitrate = computed(() => {
    const measured = this.layout().edges.map(({ totalBps }) => totalBps).filter((value): value is number => value !== null);
    return measured.length > 0 ? measured.reduce((total, value) => total + value, 0) : null;
  });

  constructor(readonly analysis: MeshAnalysisService) {}

  ngOnInit(): void {
    this.analysis.setViewing(true);
  }

  ngOnDestroy(): void {
    this.analysis.setViewing(false);
  }

  selectNode(nodeId: string): void {
    if (this.layout().nodes.some(({ id }) => id === nodeId)) this.selectedNodeId.set(nodeId);
  }

  activateNode(event: Event, nodeId: string): void {
    const keyboardEvent = event as KeyboardEvent;
    if (keyboardEvent.key !== "Enter" && keyboardEvent.key !== " ") return;
    keyboardEvent.preventDefault();
    this.selectNode(nodeId);
  }

  setShowIdle(event: Event): void {
    this.showIdleEdges.set((event.target as HTMLInputElement).checked);
  }

  formatBitrate(value: number | null): string { return formatBitrate(value); }

  edgeLabel(edge: MeshAnalysisEdge): string {
    return edge.totalBps === null ? "–" : formatBitrate(edge.totalBps);
  }

  edgeLabelWidth(edge: MeshAnalysisEdge): number {
    return Math.max(34, this.edgeLabel(edge).length * 7 + 14);
  }

  edgeTitle(edge: MeshAnalysisEdge): string {
    return `${this.edgeKindLabel(edge.kind)}: ${formatBitrate(edge.totalBps)}; Messquelle ${this.measurementLabel(edge.measurementSource)}`;
  }

  nodeAriaLabel(node: MeshAnalysisNode): string {
    return `${node.label}, ${this.nodeTypeLabel(node)}, Upload ${formatBitrate(node.outgoingBps)}, Download ${formatBitrate(node.incomingBps)}. Details anzeigen`;
  }

  shortLabel(value: string): string {
    return value.length > 17 ? `${value.slice(0, 15)}…` : value;
  }

  nodeTypeLabel(node: MeshAnalysisNode): string {
    return node.kind === "media-agent" ? "nativer Media-Agent" : "Browser-Teilnehmer";
  }

  nodeRoleLabel(node: MeshAnalysisNode): string {
    if (node.role === "primary") return "Primary Agent";
    if (node.role === "standby") return "Standby Agent";
    return "Raumteilnehmer";
  }

  edgeKindLabel(kind: MeshAnalysisEdge["kind"]): string {
    return ({
      direct: "Direkte PeerConnection",
      "trusted-relay": "Trusted Peer Relay",
      "media-agent": "Browser ↔ Media-Agent",
      "agent-federation": "Agent-Föderation",
    })[kind];
  }

  measurementLabel(source: MeshAnalysisEdge["measurementSource"]): string {
    return ({ local: "lokal gemessen", "peer-reported": "vom Raum-Peer gemeldet", unavailable: "nicht messbar" })[source];
  }

  topologyLabel(mode: MeshAnalysisGraph["topologyMode"]): string {
    return mode === "trusted_peer_relay" ? "Trusted Relay" : "Adaptives Mesh";
  }

  publicationLabel(node: MeshAnalysisNode): string {
    if (node.publications.length === 0) return "keine angekündigt";
    const labels: Record< string, string> = {
      microphone: "Audio",
      camera: "Kamera",
      screen: "Bildschirm",
      "screen-audio": "Bildschirmton",
    };
    return node.publications.map((source) => labels[source] || source).join(", ");
  }
}
