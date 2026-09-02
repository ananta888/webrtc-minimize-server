import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const template = readFileSync("frontend/src/app/features/room/room-page.component.html", "utf8");
const component = readFileSync("frontend/src/app/features/room/room-page.component.ts", "utf8");
const mediaControls = readFileSync("frontend/src/app/shared/media-control-bar.component.ts", "utf8");

describe("Room page information architecture", () => {
  it("links the top-right GitHub icon to this repository without reusing the app tab", () => {
    expect(template).toContain('id="github-repository"');
    expect(template).toContain('href="https://github.com/ananta888/webrtc-minimize-server"');
    expect(template).toContain('target="_blank"');
    expect(template).toContain('rel="noopener noreferrer"');
    expect(template).toContain('aria-label="GitHub-Repository webrtc-minimize-server öffnen"');
  });

  it("offers explicit navigation and separate public and owner room collections", () => {
    expect(template).toContain("Hauptmenü");
    expect(template).toContain("Öffentliche Räume");
    expect(template).toContain("Meine Räume");
    expect(template).toContain("directory.publicRooms()");
    expect(template).toContain("directory.ownRooms()");
    expect(template).toContain('(click)="enterListedRoom(room)"');
  });

  it("offers the room-bound mesh analysis as a separate non-capturing view", () => {
    expect(template).toContain('id="mesh-analysis-navigation"');
    expect(template).toContain("activeSection() === 'analysis'");
    expect(template).toContain("<app-mesh-analysis />");
    expect(component).toContain('"rooms" | "live" | "analysis" | "chat" | "settings"');
    expect(component).not.toContain("getUserMedia");
    expect(component).not.toContain("getDisplayMedia");
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

  it("offers media presets, configurable audio quality and a unique priority order through services", () => {
    expect(template).toContain('id="media-strategy-preset"');
    expect(template).toContain('id="media-strategy-preset-live"');
    expect(template).toContain('id="audio-quality-profile"');
    expect(template).toContain('id="microphone-applied-settings"');
    expect(template).toContain('id="media-priority-1"');
    expect(template).toContain('id="media-priority-2"');
    expect(template).toContain('id="media-priority-3"');
    expect(template).toContain('id="adaptive-video-mode"');
    expect(template).toContain('id="music-audio-warning"');
    expect(template).toContain("setMediaPriorityAt(0, $event)");
    expect(component).toContain("this.media.setMediaStrategyPreset(preset)");
    expect(component).toContain("this.media.setAudioQualityProfile(profile)");
    expect(component).toContain("this.media.setMediaPriorityAt(index, source)");
    expect(component).not.toContain("applyConstraints");
    expect(component).not.toContain("setParameters");
  });

  it("offers one receiver-owned ceiling for direct and media-agent paths without capture", () => {
    expect(template).toContain('id="receive-quality-profile-live"');
    expect(template).toContain('id="receive-quality-profile"');
    expect(template).toContain('id="receive-quality-description"');
    expect(template).toContain("option of receiveQuality.options");
    expect(template).toContain("zusätzliche Obergrenze nur für deinen Empfang");
    expect(template).toContain("Agent-Bildschirm ist derzeit Single-Layer");
    expect(template).not.toContain('id="media-agent-layer-limit"');
    expect(component).toContain("this.mesh.setReceiveQualityProfile(value)");
    expect(component).not.toContain("setMediaAgentLayerLimit");
    expect(component).not.toContain("getUserMedia");
    expect(component).not.toContain("getDisplayMedia");
  });

  it("keeps native media-agent consent explicit and shows bounded takeover controls", () => {
    expect(template).toContain('id="media-agent-consent"');
    expect(template).toContain('id="media-agent-auto-takeover"');
    expect(template).toContain('id="media-agent-takeover-request"');
    expect(template).toContain('id="accept-media-agent-takeover"');
    expect(template).toContain('id="decline-media-agent-takeover"');
    expect(template).toContain("Standardmäßig aus, raumgebunden und jederzeit widerrufbar");
    expect(template).toContain("mit den Defaults also bei 3–5 Personen");
    expect(template).toContain("mediaAgents?.minimumParticipants");
    expect(template).toContain("(!mediaAgents.selectedAgentOnline() && !mediaAgents.consentEnabled())");
    expect(template).toContain("Membership, Routen, Epochen und kurze Leases");
    expect(component).toContain("this.mediaAgents.setConsent(enabled)");
    expect(component).toContain("this.mediaAgents.respondToTakeover(accepted)");
    expect(component).not.toContain("getUserMedia");
    expect(component).not.toContain("getDisplayMedia");
  });

  it("offers explicit self-service installation without automatic download or capture", () => {
    expect(template).toContain('id="media-agent-promo"');
    expect(template).toContain("Media-Agent ansehen");
    expect(template).toContain('id="media-agent-onboarding"');
    expect(template).toContain('id="download-media-agent-installer"');
    expect(template).toContain('(submit)="$event.preventDefault(); downloadMediaAgentInstaller()"');
    expect(template).toContain("Keine Medienfreigabe und keine automatische Raumzustimmung");
    expect(template).toContain("SHA-256");
    expect(template).toContain("nicht mit einem kommerziellen Windows-/Apple-Code-Signing-Zertifikat signiert");
    expect(component).toContain("this.mediaAgentOnboarding.downloadInstaller(target, label)");
    expect(component).toContain("this.mediaAgentOnboarding.revoke(agentId)");
    expect(component).toContain("this.mediaAgentOnboarding.clear()");
    expect(component).not.toContain("getUserMedia");
    expect(component).not.toContain("getDisplayMedia");
  });
});
