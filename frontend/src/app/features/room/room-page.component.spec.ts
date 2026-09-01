import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const template = readFileSync("frontend/src/app/features/room/room-page.component.html", "utf8");
const component = readFileSync("frontend/src/app/features/room/room-page.component.ts", "utf8");
const mediaControls = readFileSync("frontend/src/app/shared/media-control-bar.component.ts", "utf8");

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
    expect(template).toContain("session.joined() && activeSection() !== 'live'");
    expect(template.match(/<app-media-control-bar/g)).toHaveLength(2);
    expect(mediaControls).toContain('id="toggle-microphone"');
    expect(mediaControls).toContain('(click)="media.toggle(\'microphone\')"');
    expect(mediaControls).toContain('id="toggle-camera"');
    expect(mediaControls).toContain('(click)="media.toggle(\'camera\')"');
    expect(mediaControls).toContain('id="toggle-screen"');
    expect(mediaControls).toContain('(click)="media.toggle(\'screen\')"');
    expect(mediaControls).not.toContain("getUserMedia");
    expect(mediaControls).not.toContain("getDisplayMedia");
    expect(component.indexOf("if (this.session.joined()) this.media.stopAll();"))
      .toBeLessThan(component.indexOf("await this.session.join(room, name, mode);"));
  });

  it("offers separate camera and screen ceilings without owning capture APIs", () => {
    expect(template).toContain('id="camera-resolution"');
    expect(template).toContain('id="camera-frame-rate"');
    expect(template).toContain('id="screen-resolution"');
    expect(template).toContain('id="screen-frame-rate"');
    expect(template).toContain('id="camera-applied-settings"');
    expect(template).toContain('id="screen-applied-settings"');
    expect(template).toContain('id="screen-audio-enabled"');
    expect(template).toContain('id="screen-audio-status"');
    expect(template).toContain('id="screen-audio-warning"');
    expect(template).toContain("setVideoResolution('camera', $event)");
    expect(template).toContain("setVideoFrameRate('screen', $event)");
    expect(component).toContain("this.media.setVideoResolution(source, resolutionId)");
    expect(component).toContain("this.media.setVideoFrameRate(source, frameRate)");
    expect(component).toContain("this.media.setScreenAudioEnabled(enabled)");
    expect(component).not.toContain("getUserMedia");
    expect(component).not.toContain("getDisplayMedia");
  });
});
