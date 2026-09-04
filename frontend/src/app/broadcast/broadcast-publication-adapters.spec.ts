import { describe, expect, it, vi } from "vitest";

import { BroadcastDeliveryCapabilityService } from "./broadcast-delivery-capability.service";
import {
  MockBroadcastPublicationAdapter,
  NativeBridgeBroadcastPublicationAdapter,
  ProviderBroadcastPublicationAdapter,
  WhipBroadcastPublicationAdapter,
} from "./broadcast-publication-adapters";
import {
  BroadcastPublicationRequest,
  BroadcastPublicationTransport,
} from "./broadcast-ports";

function request(): BroadcastPublicationRequest {
  return {
    requestVersion: 1,
    program: {
      tenantId: "tn_aaaaaaaaaaaaaaaa",
      roomId: "room-alpha",
      programId: "prg_aaaaaaaaaaaaaaaa",
      programRevision: 4,
      programEpoch: 7,
    },
    composition: {
      compositionId: "composition-1",
      sourceIds: ["src_aaaaaaaaaaaaaaaa"],
    },
  };
}

function transport(adapterId: string): BroadcastPublicationTransport & {
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
} {
  return {
    start: vi.fn(async (input: BroadcastPublicationRequest) => ({
      sessionId: `${adapterId}-session`,
      adapterId,
      programId: input.program.programId,
      programEpoch: input.program.programEpoch,
    })),
    stop: vi.fn(async () => undefined),
  };
}

describe("broadcast publication adapters", () => {
  it("reports WHIP, Native Bridge and provider adapters unavailable instead of simulating success", async () => {
    const adapters = [
      new WhipBroadcastPublicationAdapter(),
      new NativeBridgeBroadcastPublicationAdapter(),
      new ProviderBroadcastPublicationAdapter("provider-pilot"),
    ];
    const capabilities = new BroadcastDeliveryCapabilityService(adapters);
    expect(capabilities.list().map(({ adapterId, available, reasonCode }) => ({
      adapterId,
      available,
      reasonCode,
    }))).toEqual([
      { adapterId: "native-bridge", available: false, reasonCode: "native-bridge-not-configured" },
      { adapterId: "provider-pilot", available: false, reasonCode: "provider-not-configured" },
      { adapterId: "whip-browser", available: false, reasonCode: "whip-not-configured" },
    ]);
    for (const adapter of adapters) {
      expect(() => capabilities.require(adapter.capability.adapterId)).toThrow(
        adapter.capability.reasonCode,
      );
      await expect(adapter.start(request(), new AbortController().signal)).rejects.toThrow(
        adapter.capability.reasonCode,
      );
    }
  });

  it("delegates configured adapters and makes stop idempotent without hiding transport failures", async () => {
    const whipTransport = transport("whip-browser");
    const adapter = new WhipBroadcastPublicationAdapter(whipTransport);
    const session = await adapter.start(request(), new AbortController().signal);
    expect(await adapter.start(request(), new AbortController().signal)).toBe(session);
    expect(adapter.capability.available).toBe(true);
    expect(adapter.capability.supportsSimulcast).toBe(false);
    expect(whipTransport.start).toHaveBeenCalledOnce();

    await expect(adapter.start({
      ...request(),
      composition: { compositionId: "composition-2", sourceIds: ["src_aaaaaaaaaaaaaaaa"] },
    }, new AbortController().signal)).rejects.toThrow("broadcast_publication_conflict");

    whipTransport.stop.mockRejectedValueOnce(new Error("gateway_stop_failed"));
    await expect(adapter.stop(session, new AbortController().signal)).rejects.toThrow("gateway_stop_failed");
    await adapter.stop(session, new AbortController().signal);
    await adapter.stop(session, new AbortController().signal);
    expect(whipTransport.stop).toHaveBeenCalledTimes(2);
  });

  it("coalesces concurrent identical starts and rejects a conflicting start while pending", async () => {
    let resolveStart!: (session: Awaited<ReturnType<BroadcastPublicationTransport["start"]>>) => void;
    const pending = new Promise<Awaited<ReturnType<BroadcastPublicationTransport["start"]>>>((resolve) => {
      resolveStart = resolve;
    });
    const whipTransport: BroadcastPublicationTransport = {
      start: vi.fn(() => pending),
      stop: vi.fn(async () => undefined),
    };
    const adapter = new WhipBroadcastPublicationAdapter(whipTransport);
    const signal = new AbortController().signal;
    const first = adapter.start(request(), signal);
    const second = adapter.start(request(), signal);
    await expect(adapter.start({
      ...request(),
      composition: { compositionId: "composition-2", sourceIds: ["src_aaaaaaaaaaaaaaaa"] },
    }, signal)).rejects.toThrow("broadcast_publication_conflict");
    expect(whipTransport.start).toHaveBeenCalledOnce();
    resolveStart({
      sessionId: "session-concurrent",
      adapterId: "whip-browser",
      programId: request().program.programId,
      programEpoch: request().program.programEpoch,
    });
    expect(await first).toBe(await second);
  });

  it("provides a stateful mock and rejects duplicate adapter identities", async () => {
    const mock = new MockBroadcastPublicationAdapter();
    const providerTransport = transport("provider-pilot");
    const provider = new ProviderBroadcastPublicationAdapter("provider-pilot", providerTransport, {
      supportsAudio: true,
      supportsVideo: true,
    });
    const capabilities = new BroadcastDeliveryCapabilityService([mock, provider]);
    expect(capabilities.require("mock-broadcast")).toBe(mock);
    expect(capabilities.require("provider-pilot")).toBe(provider);

    const session = await mock.start(request(), new AbortController().signal);
    await mock.stop(session, new AbortController().signal);
    expect(mock.starts).toHaveLength(1);
    expect(mock.stops).toHaveLength(1);
    expect(() => new BroadcastDeliveryCapabilityService([mock, mock])).toThrow(
      "invalid_broadcast_adapter_inventory",
    );
  });
});
