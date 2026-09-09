// Serialized private observer: correlate audio and displayed video through the
// same real RTCPeerConnection. No stream bytes or identity strings are exported.
export function installMultiPublisherObservation() {
  if (window.__multiPublisher) throw new Error("test_multi_observer_duplicate");
  const tracks = new Map(); let closed = false, failed = false;
  const Native = window.RTCPeerConnection;
  async function observe(pc, track) {
    if (closed || track.kind !== "audio" || tracks.has(track)) return;
    if (tracks.size >= 4) { failed = true; return; }
    let context;
    try {
      context = new AudioContext();
      const entry = { pc, track, context, analyser: null, timer: null, active: 0, peak: 0 };
      tracks.set(track, entry);
      const source = context.createMediaStreamSource(new MediaStream([track]));
      const analyser = context.createAnalyser(), quiet = context.createGain(); quiet.gain.value = 0;
      entry.analyser = analyser;
      source.connect(analyser); analyser.connect(quiet); quiet.connect(context.destination);
      await context.resume();
      if (closed) { await context.close(); return; }
      entry.timer = setInterval(() => {
        const pcm = new Float32Array(analyser.fftSize); analyser.getFloatTimeDomainData(pcm);
        const peak = Math.max(...pcm.map(Math.abs));
        entry.peak = Math.max(entry.peak, peak); if (peak > .01) entry.active++;
      }, 20);
    } catch { failed = true; await context?.close().catch(() => undefined); }
  }
  function attach(pc) { pc.addEventListener("track", ({ track }) => { void observe(pc, track); }); }
  const Observed = class extends Native { constructor(...args) { super(...args); attach(this); } };
  window.RTCPeerConnection = Observed;
  for (const pc of window.__pcs || []) attach(pc);
  function frame(element) {
    const video = element?.querySelector("video");
    if (!video?.srcObject || video.readyState < 2 || !video.videoWidth) return null;
    const canvas = document.createElement("canvas"); canvas.width = canvas.height = 1;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(video, video.videoWidth / 2, video.videoHeight * .4, 1, 1, 0, 0, 1, 1);
    const pixel = [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3); canvas.width = canvas.height = 0;
    return pixel;
  }
  function requirePeers(peers) {
      if (!Array.isArray(peers) || peers.length !== 2 || !peers.every(p => typeof p === "string" && /^[a-f0-9]{16}$/.test(p))) {
        throw new Error("test_multi_peer_projection");
      }
  }
  function associated(peer) {
    const elements = [...document.querySelectorAll(".remote-media[data-peer-id]")].filter(el => el.dataset.peerId === peer);
    const videoTracks = elements.flatMap(el => el.querySelector("video")?.srcObject?.getVideoTracks() || []);
    const audio = [...tracks.values()].filter(entry => entry.pc.getReceivers().some(r => videoTracks.includes(r.track)));
    return { elements, audio };
  }
  function audible(entry) {
    if (closed || failed || entry.track.readyState !== "live" || entry.context.state !== "running" || !entry.analyser) return false;
    const pcm = new Float32Array(entry.analyser.fftSize); entry.analyser.getFloatTimeDomainData(pcm);
    return pcm.some(sample => Math.abs(sample) > .01);
  }
  window.__multiPublisher = {
    quiet() {
      // Include retired connections, not only audio still associated with DOM.
      return { failed: closed || failed, tracks: tracks.size, active: [...tracks.values()].some(audible) };
    },
    active(peers) {
      requirePeers(peers);
      // Fresh samples in the same browser callback, not accumulated historical
      // peaks from two non-overlapping speech turns.
      return peers.map(peer => associated(peer).audio.some(audible));
    },
    snapshot(peers) {
      requirePeers(peers);
      return { failed, publishers: peers.map(peer => {
        const { elements, audio } = associated(peer);
        return { camera: frame(elements.find(el => el.dataset.source === "camera")),
          screen: frame(elements.find(el => el.dataset.source === "screen")),
          audioTracks: audio.length, active: audio.reduce((sum, item) => sum + item.active, 0),
          peak: Math.max(0, ...audio.map(item => item.peak)) };
      }) };
    },
    reset() { for (const entry of tracks.values()) { entry.active = 0; entry.peak = 0; } },
    async close() {
      closed = true; if (window.RTCPeerConnection === Observed) window.RTCPeerConnection = Native;
      for (const entry of tracks.values()) { clearInterval(entry.timer); await entry.context.close().catch(() => undefined); }
      tracks.clear();
    },
  };
}
