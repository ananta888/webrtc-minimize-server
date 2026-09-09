import type { OverlayTrafficClass } from "./opaque-data-overlay";

const QUEUE_LIMITS = Object.freeze({
  control: { messages: 32, bytes: 128 * 1024 },
  rekey: { messages: 32, bytes: 128 * 1024 },
  event: { messages: 64, bytes: 512 * 1024 },
  bulk: { messages: 96, bytes: 1024 * 1024 },
});
const TRAFFIC_CLASSES: readonly OverlayTrafficClass[] = ["control", "rekey", "event", "bulk"];

export class BoundedOverlayQueue {
  #items = new Map<OverlayTrafficClass, string[]>(TRAFFIC_CLASSES.map(kind => [kind, []]));

  enqueue(trafficClass: OverlayTrafficClass, payload: string): boolean {
    const queue = this.#items.get(trafficClass)!;
    const limit = QUEUE_LIMITS[trafficClass];
    const bytes = queue.reduce((sum, item) => sum + item.length, 0);
    if (queue.length >= limit.messages || bytes + payload.length > limit.bytes) {
      if (trafficClass === "bulk") return false;
      queue.shift();
    }
    queue.push(payload);
    return true;
  }

  flush(send: (payload: string) => boolean): void {
    for (const trafficClass of TRAFFIC_CLASSES) {
      const queue = this.#items.get(trafficClass)!;
      while (queue.length > 0 && send(queue[0])) queue.shift();
    }
  }

  clear(): void {
    for (const queue of this.#items.values()) queue.length = 0;
  }
}
