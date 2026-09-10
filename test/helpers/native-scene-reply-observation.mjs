import assert from "node:assert/strict";

const layouts = ["single", "screen-presenter", "side-by-side", "active-speaker", "grid", "waiting-slate", "end-slate"];
const types = ["source-program-scene-state", "source-program-scene-applied", "source-program-scene-rejected"];
const revision = value => Number.isSafeInteger(value) && value > 0 ? value : null;
const count = value => Array.isArray(value) && value.length <= 20 ? value.length : null;

/** Test-only receipt observation, never command authority or a media assertion. */
export function observeNativeSceneReply(value) {
  try {
    if (![1, 2].includes(value?.version) || !types.includes(value.type)) return null;
    const state = value.type === types[0], rejected = value.type === types[2];
    const row = { version: value.version, type: value.type, revision: rejected ? null : revision(value.sceneRevision),
      layout: state && layouts.includes(value.layout) ? value.layout : null,
      available: state ? count(value.availableSources) : null,
      selected: state ? count(value.sourceLeaseIds) : null,
      reason: rejected && value.reasonCode === "SCENE_NOT_APPLIED" ? "SCENE_NOT_APPLIED" : null };
    if (!rejected && row.revision === null || state && (row.layout === null || row.available === null || row.selected === null)
      || rejected && row.reason === null) return null;
    return Object.freeze(row);
  } catch { return null; }
}

export function recordNativeSceneReply(rows, value) {
  const row = observeNativeSceneReply(value);
  if (row) { rows.push(row); if (rows.length > 8) rows.shift(); }
}

export function assertFreshNativeSceneApply(rows, previous) {
  const current = rows.at(-1);
  assert.notEqual(current, previous, "scene action produced no new native receipt");
  assert.equal(current?.type, "source-program-scene-applied", "refresh-needed UI text is not an applied receipt");
  assert.equal(current.version, previous?.version, "native receipt must retain the negotiated scene version");
  assert.equal(current.revision, previous?.revision + 1, "native application must advance the queried scene revision");
}
