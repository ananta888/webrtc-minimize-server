import { Injectable, signal } from "@angular/core";

import { OidcAuthService } from "../auth/oidc-auth.service";

export type RoomVisibility = "private" | "public";

export interface RoomSummary {
  readonly roomId: string;
  readonly title: string;
  readonly visibility: RoomVisibility;
  readonly participantCount: number;
  readonly maxParticipants: number;
  readonly owned: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface DirectoryResponse {
  readonly publicRooms: readonly unknown[];
  readonly ownRooms: readonly unknown[];
}

interface CreatedRoomResponse {
  readonly roomId?: string;
  readonly title?: string;
  readonly visibility?: RoomVisibility;
  readonly inviteUrl?: string;
  readonly error?: string;
}

function parseRoomSummary(value: unknown): RoomSummary {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("room_directory_invalid");
  const room = value as Partial<RoomSummary>;
  if (
    typeof room.roomId !== "string"
    || !/^room-[a-f0-9]{18}$/.test(room.roomId)
    || typeof room.title !== "string"
    || !room.title
    || !new Set(["private", "public"]).has(String(room.visibility))
    || !Number.isInteger(room.participantCount)
    || Number(room.participantCount) < 0
    || !Number.isInteger(room.maxParticipants)
    || Number(room.maxParticipants) < 2
    || Number(room.maxParticipants) > 20
    || typeof room.owned !== "boolean"
    || typeof room.createdAt !== "string"
    || Number.isNaN(Date.parse(room.createdAt))
    || typeof room.updatedAt !== "string"
    || Number.isNaN(Date.parse(room.updatedAt))
  ) throw new Error("room_directory_invalid");
  return room as RoomSummary;
}

@Injectable({ providedIn: "root" })
export class RoomDirectoryService {
  readonly publicRooms = signal<readonly RoomSummary[]>([]);
  readonly ownRooms = signal<readonly RoomSummary[]>([]);
  readonly busy = signal(false);
  readonly error = signal("");

  constructor(private readonly auth: OidcAuthService) {}

  async load(): Promise<void> {
    this.busy.set(true);
    this.error.set("");
    try {
      const response = await fetch("/api/rooms", { headers: this.auth.authorizationHeader() });
      const body = await response.json() as DirectoryResponse & { error?: string };
      if (!response.ok) throw new Error(body.error || "room_directory_failed");
      if (!Array.isArray(body.publicRooms) || !Array.isArray(body.ownRooms)) {
        throw new Error("room_directory_invalid");
      }
      this.publicRooms.set(body.publicRooms.map(parseRoomSummary));
      this.ownRooms.set(body.ownRooms.map(parseRoomSummary));
    } catch (error) {
      this.publicRooms.set([]);
      this.ownRooms.set([]);
      this.error.set(error instanceof Error ? error.message : "room_directory_failed");
    } finally {
      this.busy.set(false);
    }
  }

  async create(title: string, visibility: RoomVisibility): Promise<CreatedRoomResponse> {
    return this.request<CreatedRoomResponse>("/api/rooms", {
      method: "POST",
      body: JSON.stringify({ mode: "room", title, visibility }),
    });
  }

  async update(roomId: string, changes: { title?: string; visibility?: RoomVisibility }): Promise<RoomSummary> {
    const result = await this.request<{ room?: unknown }>(`/api/rooms/${encodeURIComponent(roomId)}`, {
      method: "PATCH",
      body: JSON.stringify(changes),
    });
    const room = parseRoomSummary(result.room);
    this.replace(room);
    return room;
  }

  clearOwnRooms(): void {
    this.ownRooms.set([]);
  }

  private async request<T>(url: string, options: RequestInit): Promise<T> {
    this.busy.set(true);
    this.error.set("");
    try {
      const response = await fetch(url, {
        ...options,
        headers: {
          ...(options.body ? { "content-type": "application/json" } : {}),
          ...this.auth.authorizationHeader(),
        },
      });
      const body = await response.json() as T & { error?: string };
      if (!response.ok) throw new Error(body.error || "room_request_failed");
      return body;
    } catch (error) {
      const message = error instanceof Error ? error.message : "room_request_failed";
      this.error.set(message);
      throw error;
    } finally {
      this.busy.set(false);
    }
  }

  private replace(room: RoomSummary): void {
    this.ownRooms.update((rooms) => rooms.map((candidate) => candidate.roomId === room.roomId ? room : candidate));
    this.publicRooms.update((rooms) => {
      const withoutRoom = rooms.filter((candidate) => candidate.roomId !== room.roomId);
      return room.visibility === "public" ? [room, ...withoutRoom] : withoutRoom;
    });
  }
}
