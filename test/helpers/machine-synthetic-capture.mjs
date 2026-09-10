/** Serialized into the owned test page. No host capture or speaker output.
 * stop() does not dispatch ended: explicit stop must own the graph cleanup. */
export function installMachineSyntheticCapture({ machine }) {
  let disposed = false;
  const cleanups = new Set();
  addEventListener("pagehide", () => {
    disposed = true;
    for (const close of [...cleanups]) close();
  }, { once: true });
  navigator.mediaDevices.getDisplayMedia = () => {
    ++window.__captures;
    throw new Error("human_display_forbidden");
  };
  navigator.mediaDevices.getUserMedia = async constraints => {
    ++window.__captures;
    if (machine || disposed || !constraints?.audio || constraints.video) throw new Error("human_capture_forbidden");
    const audio = new AudioContext();
    let oscillator, destination, track, nativeStop, closed = false;
    const close = () => {
      if (closed) return;
      closed = true; cleanups.delete(close);
      track?.removeEventListener("ended", close);
      try { nativeStop?.(); } catch { /* Continue clearing the owned graph. */ }
      try { oscillator?.stop(); } catch { /* Setup may not have started it. */ }
      try { oscillator?.disconnect(); } catch { /* Already disconnected. */ }
      try { destination?.disconnect(); } catch { /* Already disconnected. */ }
      try { void audio.close().catch(() => {}); } catch { /* Cleanup cannot revive the source. */ }
    };
    cleanups.add(close);
    try {
      oscillator = audio.createOscillator(); destination = audio.createMediaStreamDestination();
      track = destination.stream.getAudioTracks()[0]; nativeStop = track.stop.bind(track);
      track.stop = close; track.addEventListener("ended", close, { once: true });
      oscillator.frequency.value = 440;
      oscillator.connect(destination); oscillator.start();
      await audio.resume();
      if (closed || disposed) throw new Error("test_audio_source_closed");
      return destination.stream;
    } catch {
      close(); throw new Error("test_audio_source_unavailable");
    }
  };
}
