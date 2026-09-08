// Private fixture instrumentation only. Never installs in an application build.
export function installDialogObservation() {
  if (window.__dialogObservation) throw new Error("test_dialog_probe_already_installed");
  const state = { sent: null, answer: null, requests: 0, queued: 0, sendFailures: 0,
    peak: 0, activeWindows: 0, windows: 0, failed: false, closed: false };
  const channels = new WeakSet(), tracks = new Map();
  // Retain only opaque context names in the private page, never key bytes.
  // Matching is diagnostic, not proof that a key was installed or a frame decrypted.
  const keyed = new Set(), attached = new Set();
  const NativeWorker = window.Worker, NativeTransform = window.RTCRtpScriptTransform;
  let ObservedWorker, ObservedTransform;
  if (NativeWorker && NativeTransform) {
    ObservedWorker = class extends NativeWorker {
      postMessage(value, ...rest) {
        if (!state.closed && value?.type === "set-key" && value.direction === "decrypt" && keyed.size < 32) keyed.add(value.contextId);
        return super.postMessage(value, ...rest);
      }
    };
    ObservedTransform = class extends NativeTransform {
      constructor(worker, options, ...rest) {
        super(worker, options, ...rest);
        if (!state.closed && options?.direction === "decrypt" && attached.size < 32) attached.add(options.contextId);
      }
    };
    window.Worker = ObservedWorker; window.RTCRtpScriptTransform = ObservedTransform;
  }
  function chat(raw) {
    if (typeof raw !== "string" || raw.length > 16384) return null;
    try {
      const value = JSON.parse(raw);
      if (!value || value.version !== 2 || value.type !== "chat" || typeof value.text !== "string"
        || !value.text.trim() || [...value.text].length > 450 || !/^[a-f0-9]{32}$/.test(value.messageId)
        || typeof value.replyTo !== "string" || value.replyTo && !/^[a-f0-9]{32}$/.test(value.replyTo)) return null;
      return value;
    } catch { return null; }
  }
  function observeChannel(channel) {
    if (channel.label !== "chat" || channels.has(channel)) return;
    channels.add(channel);
    const send = channel.send;
    channel.send = function (raw) {
      const value = chat(raw);
      const observed = !state.closed && value && value.replyTo === "";
      if (observed) {
        if (state.requests >= 8) throw new Error("test_dialog_probe_budget");
        state.requests++;
        state.sent = { id: value.messageId, room: value.roomId, epoch: value.membershipEpoch,
          before: document.querySelectorAll("#chat-log .chat-entry:not(.system) span").length };
        state.answer = null;
      }
      try {
        const result = send.call(this, raw);
        if (observed && !state.closed) state.queued++;
        return result;
      } catch (error) {
        if (observed && !state.closed) state.sendFailures++;
        throw error;
      }
    };
    channel.addEventListener("message", ({ data }) => {
      const value = chat(data), sent = state.sent;
      if (!state.closed && value && sent && !state.answer && value.replyTo === sent.id && value.roomId === sent.room
        && value.membershipEpoch === sent.epoch) state.answer = value.text;
    });
  }
  async function observeAudio(track) {
    if (state.closed || track.kind !== "audio" || tracks.has(track)) return;
    if (tracks.size >= 4) { state.failed = true; return; }
    let context;
    try {
      context = new AudioContext(); const entry = { context, timer: null }; tracks.set(track, entry);
      const source = context.createMediaStreamSource(new MediaStream([track]));
      const analyser = context.createAnalyser(), quiet = context.createGain(); quiet.gain.value = 0;
      source.connect(analyser); analyser.connect(quiet); quiet.connect(context.destination); await context.resume();
      if (state.closed) { await context.close(); return; }
      entry.timer = setInterval(() => {
        const pcm = new Float32Array(analyser.fftSize); analyser.getFloatTimeDomainData(pcm);
        state.peak = Math.max(state.peak, ...pcm.map(Math.abs)); state.windows++;
        if (pcm.some(value => Math.abs(value) > .01)) state.activeWindows++;
      }, 20);
    } catch { state.failed = true; await context?.close().catch(() => undefined); }
  }
  function observePeer(peer) {
    peer.addEventListener("datachannel", ({ channel }) => observeChannel(channel));
    peer.addEventListener("track", ({ track }) => { void observeAudio(track); });
    for (const receiver of peer.getReceivers()) void observeAudio(receiver.track);
  }
  const Native = window.RTCPeerConnection;
  const Observed = class extends Native {
    constructor(...args) { super(...args); observePeer(this); }
    createDataChannel(...args) { const channel = super.createDataChannel(...args); observeChannel(channel); return channel; }
  };
  window.RTCPeerConnection = Observed;
  for (const peer of window.__pcs || []) observePeer(peer);
  function renderedAnswer() {
    const nodes = [...document.querySelectorAll("#chat-log .chat-entry:not(.system) span")];
    return Boolean(state.answer && state.sent && nodes.length >= state.sent.before + 2
      && nodes.at(-1)?.textContent === state.answer);
  }
  window.__dialogObservation = {
    chatStatus() { return { attempted: state.requests, queued: state.queued, send_failures: state.sendFailures,
      answer_seen: Boolean(state.answer), rendered: renderedAnswer() }; },
    resetAudio() { state.peak = state.activeWindows = state.windows = 0; },
    status() { return { correlated: renderedAnswer(), failed: state.failed,
      peak: state.peak, active_windows: state.activeWindows, windows: state.windows,
      audio_tracks: tracks.size, running_contexts: [...tracks.values()].filter(entry => entry.context.state === "running").length,
      muted_audio_tracks: [...tracks.keys()].filter(track => track.muted).length,
      decrypt_contexts: attached.size, keyed_contexts: keyed.size,
      matched_contexts: [...attached].filter(context => keyed.has(context)).length }; },
    async answer() {
      const text = state.answer;
      // Raw channel observation alone is not application acceptance. Require the
      // actual rendered chat, whose ingress checks current machine membership.
      if (!text || !renderedAnswer()) {
        throw new Error("test_dialog_answer_not_rendered");
      }
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
      return { correlated: true, text_sha256: [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("") };
    },
    async close() {
      state.closed = true;
      if (window.RTCPeerConnection === Observed) window.RTCPeerConnection = Native;
      if (window.Worker === ObservedWorker) window.Worker = NativeWorker;
      if (window.RTCRtpScriptTransform === ObservedTransform) window.RTCRtpScriptTransform = NativeTransform;
      keyed.clear(); attached.clear();
      state.answer = state.sent = null;
      state.requests = state.queued = state.sendFailures = 0;
      for (const { context, timer } of tracks.values()) { clearInterval(timer); await context.close().catch(() => undefined); }
      tracks.clear();
    },
  };
}
