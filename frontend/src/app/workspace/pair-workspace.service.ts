import { Injectable, signal } from "@angular/core";

import { OidcAuthService } from "../auth/oidc-auth.service";

export interface WorkspaceEvent {
  readonly sequence: number;
  readonly eventId: string;
  readonly actorPrincipal: string;
  readonly kind: "note" | "decision" | "task" | "artifact" | "system";
  readonly payload: Readonly<Record<string, unknown>>;
  readonly digest: string;
  readonly createdAt: number;
}

export interface WorkspaceSummary {
  readonly workspaceId: string;
  readonly roomId: string;
  readonly title: string;
  readonly role: "owner" | "editor" | "viewer";
  readonly members: readonly Readonly<{ principal: string; role: string; createdAt: number }>[];
}

@Injectable({ providedIn: "root" })
export class PairWorkspaceService {
  readonly workspaces = signal<readonly Omit<WorkspaceSummary, "members">[]>([]);
  readonly workspace = signal<WorkspaceSummary | null>(null);
  readonly events = signal<readonly WorkspaceEvent[]>([]);
  readonly error = signal("");
  readonly busy = signal(false);
  private readonly presenceLeaseId = crypto.randomUUID();
  private presenceEpoch = 0;

  constructor(private readonly auth: OidcAuthService) {}

  async loadList(): Promise<void> {
    try {
      const result = await this.request<{ workspaces: Omit<WorkspaceSummary, "members">[] }>("/api/workspaces");
      this.workspaces.set(result.workspaces);
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : "workspace_list_failed");
    }
  }

  async load(workspaceId: string): Promise<void> {
    if (!workspaceId) return this.clear();
    this.busy.set(true);
    this.error.set("");
    try {
      const [workspace, timeline] = await Promise.all([
        this.request<WorkspaceSummary>(`/api/workspaces/${workspaceId}`),
        this.request<{ events: WorkspaceEvent[] }>(`/api/workspaces/${workspaceId}/events?limit=200`),
      ]);
      this.workspace.set(workspace);
      this.events.set(timeline.events);
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : "workspace_load_failed");
    } finally {
      this.busy.set(false);
    }
  }

  async append(kind: WorkspaceEvent["kind"], payload: Readonly<Record<string, unknown>>): Promise<boolean> {
    const workspaceId = this.workspace()?.workspaceId;
    if (!workspaceId || this.workspace()?.role === "viewer") return false;
    try {
      await this.request(`/api/workspaces/${workspaceId}/events`, {
        method: "POST",
        body: JSON.stringify({ eventId: crypto.randomUUID(), kind, payload }),
      });
      await this.load(workspaceId);
      return true;
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : "workspace_event_failed");
      return false;
    }
  }

  async setCursor(sequence: number): Promise<void> {
    const workspaceId = this.workspace()?.workspaceId;
    if (!workspaceId) return;
    await this.request(`/api/workspaces/${workspaceId}/cursor`, {
      method: "PUT", body: JSON.stringify({ sequence }),
    });
  }

  async setPresence(state: "active" | "away" | "offline"): Promise<void> {
    const workspaceId = this.workspace()?.workspaceId;
    if (!workspaceId) return;
    await this.request(`/api/workspaces/${workspaceId}/presence`, {
      method: "PUT",
      body: JSON.stringify({
        state,
        documentId: "timeline",
        line: this.events().at(-1)?.sequence || 0,
        column: 0,
        leaseId: this.presenceLeaseId,
        epoch: ++this.presenceEpoch,
        ttlMs: 30_000,
      }),
    });
  }

  clear(): void {
    this.workspace.set(null);
    this.events.set([]);
    this.error.set("");
  }

  private async request<T = unknown>(url: string, options: RequestInit = {}): Promise<T> {
    const response = await fetch(url, {
      ...options,
      headers: {
        ...(options.body ? { "content-type": "application/json" } : {}),
        ...this.auth.authorizationHeader(),
        ...options.headers,
      },
    });
    const body = await response.json() as T & { error?: string };
    if (!response.ok) throw new Error(body.error || "workspace_request_failed");
    return body;
  }
}
