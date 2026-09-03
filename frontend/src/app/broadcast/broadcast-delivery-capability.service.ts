import { Inject, Injectable } from "@angular/core";

import {
  BROADCAST_PUBLICATION_ADAPTERS,
  BroadcastBrowserPortError,
  BroadcastDeliveryCapabilityPort,
  BroadcastPublicationCapability,
  BroadcastPublicationPort,
} from "./broadcast-ports";

const ADAPTER_ID = /^[a-z][a-z0-9-]{2,63}$/;
const REASON_CODE = /^[a-z][a-z0-9-]{2,63}$/;
const ADAPTER_KINDS = new Set(["whip", "native-bridge", "provider", "mock"]);
const INGEST_PROTOCOLS = new Set(["whip", "native-bridge", "provider", "mock"]);

function validCapability(adapter: BroadcastPublicationPort): boolean {
  const capability = adapter?.capability;
  return Boolean(capability)
    && capability.capabilityVersion === 1
    && ADAPTER_ID.test(capability.adapterId)
    && ADAPTER_KINDS.has(capability.kind)
    && typeof capability.available === "boolean"
    && Array.isArray(capability.ingestProtocols)
    && capability.ingestProtocols.length >= 1
    && capability.ingestProtocols.length <= 4
    && new Set(capability.ingestProtocols).size === capability.ingestProtocols.length
    && capability.ingestProtocols.every((protocol) => INGEST_PROTOCOLS.has(protocol))
    && typeof capability.supportsAudio === "boolean"
    && typeof capability.supportsVideo === "boolean"
    && typeof capability.supportsSimulcast === "boolean"
    && typeof adapter.start === "function"
    && typeof adapter.stop === "function"
    && (capability.available
      ? capability.reasonCode === undefined
      : typeof capability.reasonCode === "string" && REASON_CODE.test(capability.reasonCode));
}

@Injectable()
export class BroadcastDeliveryCapabilityService implements BroadcastDeliveryCapabilityPort {
  private readonly adapters = new Map<string, BroadcastPublicationPort>();

  constructor(
    @Inject(BROADCAST_PUBLICATION_ADAPTERS) adapters: readonly BroadcastPublicationPort[],
  ) {
    if (!Array.isArray(adapters) || adapters.length > 32) {
      throw new BroadcastBrowserPortError("invalid_broadcast_adapter_inventory");
    }
    for (const adapter of adapters) {
      const id = adapter?.capability?.adapterId;
      if (!id || !validCapability(adapter) || this.adapters.has(id)) {
        throw new BroadcastBrowserPortError("invalid_broadcast_adapter_inventory");
      }
      this.adapters.set(id, adapter);
    }
  }

  list(): readonly BroadcastPublicationCapability[] {
    return Object.freeze([...this.adapters.values()]
      .map((adapter) => adapter.capability)
      .sort((left, right) => left.adapterId.localeCompare(right.adapterId)));
  }

  require(adapterId: string): BroadcastPublicationPort {
    const adapter = this.adapters.get(adapterId);
    if (!adapter || !adapter.capability.available) {
      throw new BroadcastBrowserPortError(
        adapter?.capability.reasonCode || "broadcast_adapter_unavailable",
      );
    }
    return adapter;
  }
}
