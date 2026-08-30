const DEFAULTS = Object.freeze({
  windowMs: 30_000,
  cooldownMs: 60_000,
  minimumSamples: 5,
  minimumObservers: 2,
  minimumDeliveryRatio: 0.8,
  maximumDelayMs: 3_000,
});

export class RelayHealthTracker {
  #options;
  #rooms = new Map();

  constructor(options = {}) {
    this.#options = { ...DEFAULTS, ...options };
  }

  observe(roomId, observerPeerId, observation, memberCount, now = Date.now()) {
    let room = this.#rooms.get(roomId);
    if (!room) {
      room = { observations: new Map(), blockedUntil: new Map() };
      this.#rooms.set(roomId, room);
    }
    const key = `${observation.routeEpoch}:${observation.relayPeerId}`;
    let reports = room.observations.get(key);
    if (!reports) {
      reports = new Map();
      room.observations.set(key, reports);
    }
    reports.set(observerPeerId, { ...observation, observedAt: now });
    this.#pruneRoom(room, now);

    const unhealthy = [...reports.values()].filter((report) => (
      report.sampleCount >= this.#options.minimumSamples
      && (
        report.deliveryRatio < this.#options.minimumDeliveryRatio
        || report.delayMs > this.#options.maximumDelayMs
      )
    ));
    const quorum = Math.max(
      this.#options.minimumObservers,
      Math.floor(Math.max(1, memberCount - 1) / 2) + 1,
    );
    if (unhealthy.length < quorum) return false;
    room.blockedUntil.set(observation.relayPeerId, now + this.#options.cooldownMs);
    room.observations.delete(key);
    return true;
  }

  blockedRelayIds(roomId, now = Date.now()) {
    const room = this.#rooms.get(roomId);
    if (!room) return new Set();
    this.#pruneRoom(room, now);
    return new Set(
      [...room.blockedUntil].filter(([, blockedUntil]) => blockedUntil > now).map(([peerId]) => peerId),
    );
  }

  leave(roomId, peerId) {
    const room = this.#rooms.get(roomId);
    if (!room) return;
    room.blockedUntil.delete(peerId);
    for (const [key, reports] of room.observations) {
      reports.delete(peerId);
      if (key.endsWith(`:${peerId}`) || reports.size === 0) room.observations.delete(key);
    }
  }

  removeRoom(roomId) {
    this.#rooms.delete(roomId);
  }

  #pruneRoom(room, now) {
    for (const [key, reports] of room.observations) {
      for (const [observerPeerId, report] of reports) {
        if (now - report.observedAt > this.#options.windowMs) reports.delete(observerPeerId);
      }
      if (reports.size === 0) room.observations.delete(key);
    }
    for (const [peerId, blockedUntil] of room.blockedUntil) {
      if (blockedUntil <= now) room.blockedUntil.delete(peerId);
    }
  }
}
