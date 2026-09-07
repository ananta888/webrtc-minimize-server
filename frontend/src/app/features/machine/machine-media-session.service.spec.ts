import { describe, expect, it, vi } from "vitest";
import { MachineMediaSessionService } from "./machine-media-session.service";
import { MachinePublicationOwnership } from "./machine-publication-ownership";

describe("owned synthetic media endpoint", () => {
  it("requires a closed request bound to the verified Hub session before reaching the source port", async () => {
    const session = { machineContext: () => ({ hubSessionId: "hub-session" }) };
    const service = new MachineMediaSessionService(session as never, {} as never, new MachinePublicationOwnership());
    const publish = vi.spyOn(service.publication, "publish").mockResolvedValue();
    const request = { schema: "ananta.meet-media-source.v1", sourceId: "media:hub-session", outputs: ["speech"], mp4Base64: "synthetic" };
    for (const mutation of [{ sourceId: "human-desktop" }, { schema: "next" }, { token: "secret" }]) {
      expect(() => service.publish({ ...request, ...mutation })).toThrow("machine_media_source_denied");
    }
    for (const input of [null, [], "bad"]) expect(() => service.publish(input)).toThrow("machine_media_request_invalid");
    expect(publish).not.toHaveBeenCalled();
    await service.publish(request); expect(publish).toHaveBeenCalledExactlyOnceWith("synthetic", ["speech"]);
    service.ngOnDestroy();
  });
});
