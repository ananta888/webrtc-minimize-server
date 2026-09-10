/** Standalone, serialized test-page adapter. Synthetic WAV/canvas only: never
 * host capture or speaker output. Installed separately from the explicit UI click. */
export function installMachineWavCapture({ source, wav }) {
  if (!["microphone", "screen-audio"].includes(source)) throw new Error("test_audio_source_invalid");
  let disposed = false, current = null;
  addEventListener("pagehide", () => { disposed = true; current?.(); }, { once: true });

  const capture = async () => {
    if (disposed || current) throw new Error("test_audio_source_unavailable");
    const audio = new AudioContext();
    let destination, stream, canvas, decoded, closed = false, startSpeech, spoken = 0;
    const tracks = new Map(), players = new Set();
    const disconnectPlayer = (player, stop = false) => {
      if (!players.delete(player)) return;
      player.onended = null;
      if (stop) { try { player.stop(); } catch { /* A source may not have started. */ } }
      try { player.disconnect(); } catch { /* Cleanup continues for the other nodes. */ }
      player.buffer = null;
    };
    const close = () => {
      if (closed) return;
      closed = true;
      if (current === close) current = null;
      if (window.__startSyntheticReceiveSpeech === startSpeech) window.__startSyntheticReceiveSpeech = null;
      for (const [track, stop] of tracks) {
        track.removeEventListener("ended", close);
        try { stop(); } catch { /* Continue stopping the other owned tracks. */ }
      }
      tracks.clear();
      for (const player of [...players]) disconnectPlayer(player, true);
      try { destination?.disconnect(); } catch { /* Context closure is still required. */ }
      if (canvas) canvas.width = canvas.height = 0;
      decoded = null;
      try { void audio.close().catch(() => {}); } catch { /* Never revive a closed source. */ }
    };
    const ownTrack = track => {
      tracks.set(track, track.stop.bind(track));
      track.stop = close; track.addEventListener("ended", close, { once: true });
    };
    const createPlayer = () => {
      const player = audio.createBufferSource(); players.add(player);
      player.buffer = decoded; player.connect(destination);
      player.onended = () => disconnectPlayer(player);
      return player;
    };
    current = close;
    let invalidFixture = false;
    try {
      const bytes = Uint8Array.from(atob(wav), c => c.charCodeAt(0));
      let result;
      try { result = await audio.decodeAudioData(bytes.buffer); }
      finally { try { bytes.fill(0); } catch { /* Real decode may detach the input buffer. */ } }
      if (closed || disposed) throw new Error("closed");
      if (!Number.isFinite(result.duration) || result.duration < 1 || result.duration > 8 || result.numberOfChannels !== 1) {
        invalidFixture = true; throw new Error("invalid");
      }
      decoded = result;
      destination = audio.createMediaStreamDestination(); stream = destination.stream;
      for (const track of stream.getTracks()) ownTrack(track);
      // Pre-create the first source so construction failures occur before the UI
      // receives a live stream. Each utterance still requires its explicit callback.
      const firstPlayer = createPlayer();
      if (source === "screen-audio") {
        canvas = document.createElement("canvas"); canvas.width = 320; canvas.height = 180;
        const context = canvas.getContext("2d"); context.fillStyle = "#224466"; context.fillRect(0, 0, 320, 180);
        const video = canvas.captureStream(1).getVideoTracks()[0]; ownTrack(video); stream.addTrack(video);
      }
      startSpeech = () => {
        if (closed || disposed || spoken >= 3 || audio.state === "closed") throw new Error("test_audio_speech_budget_exhausted");
        try {
          const player = spoken === 0 ? firstPlayer : createPlayer();
          spoken++; player.start(audio.currentTime + 1);
        } catch { close(); throw new Error("test_audio_source_unavailable"); }
      };
      await audio.resume();
      if (closed || disposed) throw new Error("closed");
      window.__startSyntheticReceiveSpeech = startSpeech;
      return stream;
    } catch {
      close(); throw new Error(invalidFixture ? "test_audio_fixture_invalid" : "test_audio_source_unavailable");
    }
  };
  if (source === "microphone") navigator.mediaDevices.getUserMedia = capture;
  else navigator.mediaDevices.getDisplayMedia = capture;
}
