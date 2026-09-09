// Receiver-only sampled overlap observation. Never changes membership or grants.
export async function installSpeakerFloorObservation(peers) {
  if (window.__speakerFloor || !Array.isArray(peers) || peers.length !== 2 || peers[0] === peers[1]
    || !peers.every(p => typeof p === "string" && /^[a-f0-9]{16}$/.test(p))) {
    throw new Error("test_floor_observer_binding_invalid");
  }
  const connections = peers.map(peer => {
    const element = [...document.querySelectorAll('.remote-media[data-source="screen"]')]
      .find(el => el.dataset.peerId === peer);
    const video = element?.querySelector("video");
    if (!video?.srcObject || video.readyState < 2 || !video.videoWidth) return null;
    const tracks = video.srcObject.getVideoTracks();
    const matches = (window.__pcs || []).filter(pc => pc.connectionState === "connected"
      && pc.getReceivers().some(receiver => tracks.includes(receiver.track)));
    return matches.length === 1 ? matches[0] : null;
  });
  if (connections.some(pc => pc === null) || connections[0] === connections[1]) {
    throw new Error("test_floor_observer_connection_invalid");
  }
  const context = new AudioContext(), tracks = new Map();
  const quiet = context.createGain(); quiet.gain.value = 0; quiet.connect(context.destination);
  let closed = false, timer = null, created = 0, failed = false;
  let samples = 0, overlap = 0, maxGap = 0;
  let started = 0, previous = 0, lastAudible = 0;
  const first = [null, null], last = [null, null], counts = [0, 0]; let active = [false, false];
  function sample() {
    if (closed || failed) return;
    const now = performance.now(), stamp = Math.round(performance.timeOrigin + now);
    maxGap = Math.max(maxGap, now - previous); previous = now;
    if (now - started > 60000 || samples >= 3000 || maxGap > 250 || context.state !== "running"
      || connections.some(pc => pc.connectionState !== "connected")) {
      failed = true; clearInterval(timer); return;
    }
    try {
      for (const [track, entry] of tracks) if (track.readyState === "ended") {
        entry.source.disconnect(); entry.analyser.disconnect(); tracks.delete(track);
      }
      connections.forEach((pc, index) => {
        for (const { track } of pc.getReceivers()) {
          if (!track || track.kind !== "audio" || track.readyState !== "live" || tracks.has(track)) continue;
          if (++created > 8) throw new Error("test_floor_observer_track_budget");
          const source = context.createMediaStreamSource(new MediaStream([track]));
          const analyser = context.createAnalyser();
          source.connect(analyser); analyser.connect(quiet);
          tracks.set(track, { index, source, analyser, pcm: new Float32Array(analyser.fftSize) });
        }
      });
      active = [false, false];
      // All current samples are read in this single callback. Accumulated
      // historical peaks from non-overlapping turns never count as overlap.
      for (const entry of tracks.values()) {
        entry.analyser.getFloatTimeDomainData(entry.pcm);
        if (entry.pcm.some(value => Math.abs(value) > .01)) active[entry.index] = true;
      }
      samples++;
      active.forEach((value, i) => { if (value) { counts[i]++; first[i] ??= stamp; last[i] = stamp; } });
      if (active.some(Boolean)) lastAudible = now;
      if (active.every(Boolean)) overlap++;
    } catch { failed = true; clearInterval(timer); }
  }
  try {
    await context.resume();
    if (context.state !== "running") throw new Error("test_floor_observer_audio_unavailable");
    started = previous = lastAudible = performance.now();
    window.__speakerFloor = {
      snapshot() {
        return { failed, samples, overlap, max_gap_ms: Math.ceil(maxGap), active: [...active],
          quiet_ms: Math.max(0, Math.floor(performance.now() - lastAudible)),
          counts: [...counts], first_at_ms: [...first], last_at_ms: [...last] };
      },
      async close() {
        if (closed) return;
        closed = true; clearInterval(timer);
        for (const entry of tracks.values()) { entry.source.disconnect(); entry.analyser.disconnect(); }
        tracks.clear(); quiet.disconnect(); await context.close();
      },
    };
    timer = setInterval(sample, 20);
    sample();
    if (failed) throw new Error("test_floor_observer_audio_unavailable");
  } catch (error) {
    clearInterval(timer); await context.close().catch(() => undefined); throw error;
  }
}
