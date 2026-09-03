import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MediaAgentOnboardingService } from "./media-agent-onboarding.service";

const auth = { authorizationHeader: vi.fn(() => ({ Authorization: "Bearer access-token" })) };
const agent = {
  id: "edge-0123456789abcdef",
  label: "Arbeitszimmer",
  platform: "linux",
  keyFingerprint: "A".repeat(43),
  createdAt: Date.now() - 10_000,
  lastAuthenticatedAt: Date.now() - 1_000,
  revokedAt: 0,
  online: true,
};

describe("MediaAgentOnboardingService", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    auth.authorizationHeader.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not fetch, install or download anything on construction", () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    new MediaAgentOnboardingService(auth as never);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(click).not.toHaveBeenCalled();
  });

  it("lists only closed owner-bound agent contracts without triggering a download", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ agents: [agent] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    const service = new MediaAgentOnboardingService(auth as never);
    await service.load();
    expect(service.agents()).toEqual([agent]);
    expect(click).not.toHaveBeenCalled();
  });

  it("downloads an installer only from the explicit method and keeps no ticket in state", async () => {
    vi.useFakeTimers();
    const response = {
      agentId: agent.id,
      filename: "ananta-media-agent-linux-amd64.sh",
      target: "linux-amd64",
      expiresAt: Date.now() + 600_000,
      artifactSha256: "a".repeat(64),
      artifactBytes: 12_345,
      installer: `#!/bin/sh\n${"x".repeat(120)}\nMEDIA_AGENT_ENROLLMENT_TOKEN=secret-ticket`,
    };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify(response), {
      status: 201,
      headers: { "content-type": "application/json" },
    }));
    const createObjectURL = vi.fn(() => "blob:installer");
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createObjectURL });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revokeObjectURL });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    const service = new MediaAgentOnboardingService(auth as never);
    await service.downloadInstaller("linux-amd64", "Arbeitszimmer");
    expect(fetchMock).toHaveBeenCalledWith("/api/media-agents/enrollments", expect.objectContaining({ method: "POST" }));
    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(click).toHaveBeenCalledOnce();
    expect(revokeObjectURL).not.toHaveBeenCalled();
    await vi.runAllTimersAsync();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:installer");
    expect(JSON.stringify(service.pending())).not.toContain("secret-ticket");
  });

  it("revokes only an exact generated agent id", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ agentId: agent.id, revokedAt: Date.now() }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ agents: [{ ...agent, online: false, revokedAt: Date.now() }] }), { status: 200 }));
    const service = new MediaAgentOnboardingService(auth as never);
    await service.revoke(agent.id);
    expect(fetchMock.mock.calls[0][0]).toBe(`/api/media-agents/${agent.id}`);
    await expect(service.revoke("../../operator-agent")).rejects.toThrow("media_agent_not_found");
  });
});
