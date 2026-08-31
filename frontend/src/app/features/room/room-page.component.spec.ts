import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const template = readFileSync("frontend/src/app/features/room/room-page.component.html", "utf8");
const component = readFileSync("frontend/src/app/features/room/room-page.component.ts", "utf8");

describe("Room page information architecture", () => {
  it("offers explicit navigation and separate public and owner room collections", () => {
    expect(template).toContain("Hauptmenü");
    expect(template).toContain("Öffentliche Räume");
    expect(template).toContain("Meine Räume");
    expect(template).toContain("directory.publicRooms()");
    expect(template).toContain("directory.ownRooms()");
    expect(template).toContain('(click)="enterListedRoom(room)"');
  });

  it("keeps room visibility changes on an explicit owner action", () => {
    expect(template).toContain('(click)="setVisibility(room, room.visibility === \'public\' ? \'private\' : \'public\')"');
    expect(template).toContain('(click)="toggleCurrentVisibility()"');
    expect(component).toContain("if (!room.owned || room.visibility === visibility) return;");
    expect(component).toContain("await this.directory.update(room.roomId, { visibility });");
  });

  it("binds every capture source to its visible control and stops tracks before room switching", () => {
    expect(template).toContain('id="toggle-microphone"');
    expect(template).toContain('(click)="media.toggle(\'microphone\')"');
    expect(template).toContain('id="toggle-camera"');
    expect(template).toContain('(click)="media.toggle(\'camera\')"');
    expect(template).toContain('id="toggle-screen"');
    expect(template).toContain('(click)="media.toggle(\'screen\')"');
    expect(template).not.toContain("getUserMedia");
    expect(template).not.toContain("getDisplayMedia");
    expect(component.indexOf("if (this.session.joined()) this.media.stopAll();"))
      .toBeLessThan(component.indexOf("await this.session.join(room, name, mode);"));
  });
});
