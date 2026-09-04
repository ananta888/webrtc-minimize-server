import { Injectable } from "@angular/core";

import { BrowserWhipBroadcastRuntimeService } from "./broadcast-browser-runtime.service";
import { NativePackagerBroadcastRuntimeService } from "./native-packager-broadcast-runtime.service";
import { BroadcastBrowserPortError, BroadcastPublicationSession, BroadcastStatsPort, BroadcastStatsSample } from "./broadcast-ports";

@Injectable()
export class BroadcastStatsRouterService implements BroadcastStatsPort {
  constructor(
    private readonly whip: BrowserWhipBroadcastRuntimeService,
    private readonly native: NativePackagerBroadcastRuntimeService,
  ) {}

  subscribe(session: BroadcastPublicationSession, listener: (sample: BroadcastStatsSample) => void): () => void {
    if (session.adapterId === "whip-browser") return this.whip.subscribe(session, listener);
    if (session.adapterId === "native-bridge") return this.native.subscribe(session, listener);
    throw new BroadcastBrowserPortError("broadcast_stats_adapter_unavailable");
  }
}
