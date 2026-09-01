const BATTERY_SCORE = Object.freeze({ mains: 90, unknown: 35, limited: 10, critical: -500 });
const NETWORK_SCORE = Object.freeze({ fast: 100, normal: 60, unknown: 25, constrained: -250 });
const CREATOR_PREFERENCE_SCORE = 240;

export function mediaAgentScore(candidate) {
  if (!candidate?.healthy || candidate.draining || candidate.battery === "critical"
    || candidate.network === "constrained" || candidate.visible === false) return Number.NEGATIVE_INFINITY;
  return (candidate.creatorOwned ? CREATOR_PREFERENCE_SCORE : 0)
    + (BATTERY_SCORE[candidate.battery] ?? BATTERY_SCORE.unknown)
    + (NETWORK_SCORE[candidate.network] ?? NETWORK_SCORE.unknown)
    + Math.max(0, Math.min(100, Number(candidate.capacity) || 0)) * 2
    - Math.max(0, Math.min(100, Number(candidate.load) || 0));
}

export function rankMediaAgents(candidates) {
  return candidates
    .map((candidate) => Object.freeze({ ...candidate, score: mediaAgentScore(candidate) }))
    .filter((candidate) => Number.isFinite(candidate.score))
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
}

export function planMediaAgents({
  candidates,
  currentPrimaryId = "",
  maxStandbys = 2,
  failover = false,
  approvedAgentIds = new Set(),
  switchMargin = 200,
}) {
  const ranked = rankMediaAgents(candidates);
  const current = ranked.find((candidate) => candidate.id === currentPrimaryId) || null;
  const best = ranked[0] || null;
  let primary = current;
  let takeover = null;

  if (!current && best) {
    if (!failover || best.automaticTakeover || approvedAgentIds.has(best.id)) primary = best;
    else takeover = best;
  } else if (current && best && best.id !== current.id && best.score >= current.score + switchMargin) {
    if (best.automaticTakeover || approvedAgentIds.has(best.id)) primary = best;
    else takeover = best;
  }

  const primaryId = primary?.id || "";
  const standbys = ranked
    .filter((candidate) => candidate.id !== primaryId)
    .slice(0, Math.max(0, maxStandbys));
  return Object.freeze({
    primary,
    standbys: Object.freeze(standbys),
    takeover,
    ranked: Object.freeze(ranked),
  });
}
