// Serialized only into the private test browser. Fixed scalars, no source IDs,
// frames, PCM, claims, chat, exception text or exported application objects.
export function machineSourceFailureObservation() {
  const api = window.anantaMachine;
  const read = fn => { try { return fn(); } catch { return null; } };
  const number = value => Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000 ? value : null;
  const state = value => ["starting", "opening", "waiting", "open", "closed", "failed", "completed", "running", "held"].includes(value)
    ? value : "unknown";
  const speech = read(() => api.speech.status()), avatar = read(() => api.avatar.status());
  const screen = read(() => api.screen.status()), timing = read(() => api.timing.snapshot());
  const pulse = window.__avatarTestPulse, session = read(() => api.status());
  const codes = ["meet_speech_worklet_profile_invalid", "meet_speech_worklet_input_invalid",
    "meet_speech_worklet_expired_or_invalid", "meet_speech_worklet_underrun"];
  return {
    speech: { state: state(speech?.state), generation: number(speech?.generation),
      receivedSamples: number(speech?.receivedSamples), playedSamples: number(speech?.playedSamples) },
    avatar: { state: state(avatar?.state), generation: number(avatar?.generation) },
    controller: { pulses: number(pulse?.pulses), failures: number(pulse?.failures),
      maxGapMs: number(Math.ceil(pulse?.maxGapMs)), lastPulseAgeMs: number(Math.ceil(performance.now() - pulse?.lastPulseAt)) },
    session: { joined: session?.joined === true, generation: number(session?.lease?.generation),
      remainingMs: number(Math.floor(session?.lease?.expiresAt - Date.now())) },
    screen: { open: screen?.open === true, generation: number(screen?.generation), sequence: number(screen?.sequence) },
    timing: { available: timing !== null, speech: state(timing?.sources?.speech?.state),
      avatar: state(timing?.sources?.avatar?.state), screen: state(timing?.sources?.screen?.state) },
    speechErrors: (Array.isArray(window.__speechErrors) ? window.__speechErrors : []).slice(0, 8)
      .map(code => codes.includes(code) ? code : "unknown"),
  };
}
