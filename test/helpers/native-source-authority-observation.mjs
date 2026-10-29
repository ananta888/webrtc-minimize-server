/** Test-only passive projections of existing reads; never extra authorization or raw identifiers. */
export function observeNativeSourceAuthority(app, rows) {
  const restores = [], initial = new Map(), last = new Map();
  const field = (value, name) => Object.getOwnPropertyDescriptor(value ?? {}, name)?.value;
  const integer = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
  const append = (key, value) => {
    const encoded = JSON.stringify(value);
    if (last.get(key) === encoded) return;
    if (!last.has(key) && last.size >= 64) last.delete(last.keys().next().value);
    last.set(key, encoded);
    if (rows.length >= 64) rows.shift();
    rows.push(Object.freeze(value));
  };
  const targets = [[app.broadcastRuntime, "nativeSourceWriterContext", "writer", 2],
    [app.nativePackagers, "sourceContext", "packager", 1], [app.registry, "publication", "publication", 1]];
  for (const [owner, method, port, keyIndex] of targets) {
    const original = owner[method];
    if (typeof original !== "function") throw new Error("test_authority_observation_port_missing");
    const wrapped = function (...args) {
      const key = `${port}:${typeof args[keyIndex] === "string" ? args[keyIndex] : "unknown"}`;
      let value;
      try { value = original.apply(this, args); }
      catch (error) {
        try { append(key, { port, available: false, denied: true }); } catch { /* Advisory only. */ }
        throw error;
      }
      try {
        if (!initial.has(key) && initial.size < 64 && value) initial.set(key, Object.freeze({
          ...Object.fromEntries(["expiresAt", "leaseId", "packagerRef", "fencingRevision", "programEpoch",
            "generation", "publicationEpoch"].map(name => [name, field(value, name)])),
          deviceRef: field(field(value, "capability"), "deviceRef"),
        }));
        const first = initial.get(key), capability = field(value, "capability");
        const row = { port, available: value != null, denied: false };
        if (port === "writer" && value) Object.assign(row, {
          programRevision: integer(field(value, "programRevision")),
          authorityRevision: integer(field(value, "sourceAuthorityRevision")),
          expired: field(value, "expiresAt") <= Date.now(),
          expiryDecreased: field(value, "expiresAt") < field(first, "expiresAt"),
          bindingChanged: ["leaseId", "packagerRef", "fencingRevision", "programEpoch"]
            .some(name => field(first, name) !== field(value, name)),
          state: ["live", "degraded"].includes(field(value, "state")) ? field(value, "state") : "unknown",
        });
        if (port === "packager" && value) Object.assign(row, {
          online: field(value, "online") === true,
          generationChanged: field(value, "generation") !== field(first, "generation"),
          deviceChanged: field(capability, "deviceRef") !== field(first, "deviceRef"),
          expired: field(capability, "expiresAt") <= Date.now(),
          health: ["healthy", "degraded"].includes(field(capability, "health")) ? field(capability, "health") : "unknown",
        });
        if (port === "publication" && value) Object.assign(row, {
          epoch: integer(field(value, "publicationEpoch")),
          source: ["microphone", "screen-audio", "camera", "screen"].includes(field(value, "source"))
            ? field(value, "source") : "unknown",
          epochChanged: field(value, "publicationEpoch") !== field(first, "publicationEpoch"),
        });
        append(key, row);
      } catch { /* Observation cannot change policy results or errors. */ }
      return value;
    };
    owner[method] = wrapped;
    restores.push(() => { if (owner[method] === wrapped) owner[method] = original; });
  }
  return () => { restores.reverse().forEach(close => close()); initial.clear(); last.clear(); };
}
