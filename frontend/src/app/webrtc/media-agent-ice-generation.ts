export function mediaAgentIceUfrags(description: Pick<RTCSessionDescriptionInit, "sdp"> | null): ReadonlySet<string> {
  const values = new Set<string>();
  for (const line of (description?.sdp || "").split(/\r?\n/)) {
    if (!line.startsWith("a=ice-ufrag:")) continue;
    const value = line.slice("a=ice-ufrag:".length).trim();
    if (value) values.add(value);
  }
  return values;
}

export function mediaAgentCandidateMatchesDescription(
  candidate: RTCIceCandidateInit | null,
  description: Pick<RTCSessionDescriptionInit, "sdp"> | null,
): boolean {
  if (!description) return false;
  const usernameFragment = candidate?.usernameFragment?.trim();
  return !usernameFragment || mediaAgentIceUfrags(description).has(usernameFragment);
}
