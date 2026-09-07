export function productionBroadcastScenario(value, { hasHandoff, privateViewer, refreshRestore }) {
  if (value === undefined || value === "full") return Object.freeze({ publicHandoffOnly: false, initialVisibility: "private" });
  if (value !== "public-handoff-only" || !hasHandoff || privateViewer || refreshRestore) {
    throw new Error("invalid_production_broadcast_scenario");
  }
  return Object.freeze({ publicHandoffOnly: true, initialVisibility: "public" });
}

// Serialized into only the explicit test page. No raw text or attributes leave it.
export function inspectProductionBroadcastUi() {
  const codes = selector => [...document.querySelectorAll(selector)].flatMap(element =>
    element.textContent?.match(/\b(?:broadcast|native|invalid|oidc|auth)_[a-z0-9_-]{1,80}\b/g) || []).slice(0, 5);
  const publisher = document.querySelector("#broadcast-program-status")?.textContent?.trim();
  const state = document.querySelector("app-broadcast-player .state")?.getAttribute("data-state");
  return {
    errors: codes("#app-error, app-broadcast-preflight > .error, #broadcast-open-error, app-broadcast-player [role=alert]"),
    publisher: ["Live", "Degradiert", "Übergabe läuft", "Gestoppt", "Fehlgeschlagen"].includes(publisher) ? publisher : "other",
    player: ["idle", "loading", "ready", "playing", "buffering", "failed", "ended", "unsupported"].includes(state) ? state : "other",
    startDisabled: Boolean(document.querySelector("#broadcast-start")?.disabled),
    stopPresent: Boolean(document.querySelector("#broadcast-stop")),
    reconnecting: Boolean(document.querySelector("#broadcast-viewer-reconnecting")),
  };
}
