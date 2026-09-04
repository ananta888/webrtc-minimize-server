import { describe, expect, it } from "vitest";

import { MOQ_UI_CAPABILITY_STATUS } from "./moq-capability-status";

describe("MOQ_UI_CAPABILITY_STATUS", () => {
  it("keeps the experimental path disabled and names exact incompatible drafts", () => {
    expect(MOQ_UI_CAPABILITY_STATUS).toMatchObject({
      enabled: false,
      status: "unavailable",
      transportVersion: "draft-ietf-moq-transport-20",
      locVersion: "draft-ietf-moq-loc-04",
      webTransportVersion: "RFC 9297",
      secureObjectsVersion: "draft-ietf-moq-secure-objects-01",
      fallback: "LL-HLS/HLS",
    });
    expect(MOQ_UI_CAPABILITY_STATUS.mediaMtx).toContain("draft-19");
    expect(MOQ_UI_CAPABILITY_STATUS.cloudflare).toContain("draft-14/draft-16");
    expect(MOQ_UI_CAPABILITY_STATUS.secureObjects).toContain("nicht integriert");
  });
});
