const elements = Object.freeze({
  statusDot: document.querySelector("#status-dot"),
  connectionStatus: document.querySelector("#connection-status"),
  displayName: document.querySelector("#display-name"),
  roomId: document.querySelector("#room-id"),
  createRoom: document.querySelector("#create-room"),
  joinRoom: document.querySelector("#join-room"),
  leaveRoom: document.querySelector("#leave-room"),
  inviteUrl: document.querySelector("#invite-url"),
  copyInvite: document.querySelector("#copy-invite"),
  participantCount: document.querySelector("#participant-count"),
  mediaGrid: document.querySelector("#media-grid"),
  emptyMedia: document.querySelector("#empty-media"),
  microphone: document.querySelector("#toggle-microphone"),
  camera: document.querySelector("#toggle-camera"),
  screen: document.querySelector("#toggle-screen"),
  mediaError: document.querySelector("#media-error"),
  chatLog: document.querySelector("#chat-log"),
  chatForm: document.querySelector("#chat-form"),
  chatMessage: document.querySelector("#chat-message"),
  chatSubmit: document.querySelector("#chat-form button"),
});

const state = {
  config: { iceServers: [], maxRoomParticipants: 4 },
  socket: null,
  ownId: null,
  ownName: "",
  roomId: "",
  peers: new Map(),
  publications: new Map(),
  remoteTrackSources: new Map(),
  remoteElements: new Map(),
};

function setConnectionStatus(label, kind = "idle") {
  elements.connectionStatus.textContent = label;
  elements.statusDot.className = `dot ${kind}`;
}

function setJoined(joined) {
  elements.joinRoom.disabled = joined;
  elements.createRoom.disabled = joined;
  elements.leaveRoom.disabled = !joined;
  elements.displayName.disabled = joined;
  elements.roomId.disabled = joined;
  for (const button of [elements.microphone, elements.camera, elements.screen]) {
    button.disabled = !joined;
  }
  elements.chatMessage.disabled = !joined;
  elements.chatSubmit.disabled = !joined;
}

function updateParticipantCount() {
  const count = state.ownId ? state.peers.size + 1 : 0;
  elements.participantCount.textContent = `${count} / ${state.config.maxRoomParticipants}`;
}

function updateEmptyMedia() {
  elements.emptyMedia.hidden = state.remoteElements.size > 0 || state.publications.size > 0;
}

function addChatEntry(author, text, system = false) {
  const entry = document.createElement("div");
  entry.className = `chat-entry${system ? " system" : ""}`;
  const authorElement = document.createElement("strong");
  authorElement.textContent = author;
  const textElement = document.createElement("span");
  textElement.textContent = text;
  entry.append(authorElement, textElement);
  elements.chatLog.append(entry);
  elements.chatLog.scrollTop = elements.chatLog.scrollHeight;
  while (elements.chatLog.children.length > 100) elements.chatLog.firstChild.remove();
}

function webSocketUrl(roomId, name) {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const url = new URL(`${protocol}//${location.host}/signal`);
  url.searchParams.set("room", roomId);
  url.searchParams.set("name", name);
  return url;
}

function sendSignal(to, payload) {
  if (state.socket?.readyState !== WebSocket.OPEN) return;
  state.socket.send(JSON.stringify({ type: "signal", to, ...payload }));
}

function broadcastMediaState(source, track, active) {
  if (state.socket?.readyState !== WebSocket.OPEN) return;
  state.socket.send(JSON.stringify({
    type: "media-state",
    source,
    active,
    trackId: active ? track.id : null,
  }));
}

function announceLocalMedia() {
  for (const [source, publication] of state.publications) {
    for (const track of publication.stream.getTracks()) {
      const trackSource = source === "screen" && track.kind === "audio" ? "screen-audio" : source;
      broadcastMediaState(trackSource, track, true);
    }
  }
}

function sourceLabel(source, kind) {
  if (source === "camera") return "Kamera";
  if (source === "screen" || source === "screen-audio") return "Bildschirm";
  if (source === "microphone") return "Mikrofon";
  return kind === "audio" ? "Audio" : "Video";
}

function peerName(peerId) {
  return state.peers.get(peerId)?.name || "Peer";
}

function updateRemoteLabels(peerId) {
  const metadata = state.remoteTrackSources.get(peerId) || new Map();
  for (const item of state.remoteElements.values()) {
    if (item.peerId !== peerId) continue;
    const source = [...item.stream.getTracks()].map((track) => metadata.get(track.id)).find(Boolean);
    item.label.textContent = `${peerName(peerId)} · ${sourceLabel(source, item.kind)}`;
  }
}

function removeRemoteElement(key) {
  const item = state.remoteElements.get(key);
  if (!item) return;
  item.card.remove();
  state.remoteElements.delete(key);
  updateEmptyMedia();
}

function renderRemoteTrack(peerId, event) {
  const stream = event.streams[0] || new MediaStream([event.track]);
  const key = `${peerId}:${stream.id}`;
  let item = state.remoteElements.get(key);
  if (!item) {
    const card = document.createElement("article");
    card.className = "media-card";
    const label = document.createElement("span");
    label.className = "media-label";
    const hasVideo = stream.getVideoTracks().length > 0 || event.track.kind === "video";
    const media = document.createElement(hasVideo ? "video" : "audio");
    media.autoplay = true;
    media.controls = !hasVideo;
    if (hasVideo) media.playsInline = true;
    media.srcObject = stream;
    card.append(label, media);
    elements.mediaGrid.append(card);
    item = { peerId, card, label, media, stream, kind: hasVideo ? "video" : "audio" };
    state.remoteElements.set(key, item);
  } else {
    if (event.track.kind === "video" && item.kind === "audio") {
      const video = document.createElement("video");
      video.autoplay = true;
      video.playsInline = true;
      item.media.replaceWith(video);
      item.media = video;
      item.kind = "video";
    }
    item.media.srcObject = stream;
  }
  event.track.addEventListener("ended", () => {
    if ([...stream.getTracks()].every((track) => track.readyState === "ended")) removeRemoteElement(key);
  }, { once: true });
  updateRemoteLabels(peerId);
  updateEmptyMedia();
}

function attachDataChannel(peer, channel) {
  if (peer.channel && peer.channel !== channel) peer.channel.close();
  peer.channel = channel;
  channel.onopen = () => addChatEntry("System", `${peer.name}: Peer-Chat verbunden`, true);
  channel.onclose = () => {
    if (peer.channel === channel) peer.channel = null;
  };
  channel.onmessage = (event) => {
    if (typeof event.data !== "string" || event.data.length > 16_384) return;
    try {
      const message = JSON.parse(event.data);
      if (message.version !== 1 || message.type !== "chat" || typeof message.text !== "string") return;
      if (message.text.length < 1 || message.text.length > 2000) return;
      addChatEntry(peer.name, message.text);
    } catch {
      // Closed message contract: malformed or unknown messages are ignored.
    }
  };
}

function addLocalTracks(peer) {
  for (const publication of state.publications.values()) {
    for (const track of publication.stream.getTracks()) peer.pc.addTrack(track, publication.stream);
  }
}

function createPeer(peerId, name) {
  if (peerId === state.ownId) return null;
  const existing = state.peers.get(peerId);
  if (existing) return existing;
  const pc = new RTCPeerConnection({ iceServers: state.config.iceServers });
  const peer = {
    id: peerId,
    name: name || "Peer",
    pc,
    channel: null,
    polite: state.ownId > peerId,
    makingOffer: false,
    ignoreOffer: false,
    settingRemoteAnswerPending: false,
  };
  state.peers.set(peerId, peer);
  addLocalTracks(peer);

  pc.onicecandidate = ({ candidate }) => sendSignal(peerId, { candidate });
  pc.ontrack = (event) => renderRemoteTrack(peerId, event);
  pc.ondatachannel = ({ channel }) => attachDataChannel(peer, channel);
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === "failed") pc.restartIce();
  };
  pc.onnegotiationneeded = async () => {
    try {
      peer.makingOffer = true;
      await pc.setLocalDescription();
      sendSignal(peerId, { description: pc.localDescription });
    } catch (error) {
      addChatEntry("System", `Verhandlung mit ${peer.name} fehlgeschlagen: ${error.message}`, true);
    } finally {
      peer.makingOffer = false;
    }
  };
  if (state.ownId < peerId) {
    attachDataChannel(peer, pc.createDataChannel("chat", { ordered: true }));
  }
  updateParticipantCount();
  return peer;
}

async function acceptSignal(message) {
  const peer = createPeer(message.from, message.fromName);
  if (!peer) return;
  const { pc } = peer;
  try {
    if (message.description) {
      const description = message.description;
      const readyForOffer = !peer.makingOffer && (
        pc.signalingState === "stable" || peer.settingRemoteAnswerPending
      );
      const offerCollision = description.type === "offer" && !readyForOffer;
      peer.ignoreOffer = !peer.polite && offerCollision;
      if (peer.ignoreOffer) return;
      peer.settingRemoteAnswerPending = description.type === "answer";
      await pc.setRemoteDescription(description);
      peer.settingRemoteAnswerPending = false;
      if (description.type === "offer") {
        await pc.setLocalDescription();
        sendSignal(peer.id, { description: pc.localDescription });
      }
      return;
    }
    try {
      await pc.addIceCandidate(message.candidate);
    } catch (error) {
      if (!peer.ignoreOffer) throw error;
    }
  } catch (error) {
    peer.settingRemoteAnswerPending = false;
    addChatEntry("System", `WebRTC-Signal von ${peer.name} abgelehnt: ${error.message}`, true);
  }
}

function closePeer(peerId) {
  const peer = state.peers.get(peerId);
  if (!peer) return;
  peer.channel?.close();
  peer.pc.close();
  state.peers.delete(peerId);
  state.remoteTrackSources.delete(peerId);
  for (const [key, item] of state.remoteElements) {
    if (item.peerId === peerId) removeRemoteElement(key);
  }
  updateParticipantCount();
}

function handleServerMessage(message) {
  if (message.version !== 1 || typeof message.type !== "string") return;
  if (message.type === "welcome") {
    state.ownId = message.peerId;
    state.roomId = message.roomId;
    state.config.maxRoomParticipants = message.maxParticipants;
    for (const peer of message.peers) createPeer(peer.id, peer.name);
    setJoined(true);
    setConnectionStatus("Signaling verbunden", "connected");
    updateParticipantCount();
    announceLocalMedia();
    addChatEntry("System", `Raum ${message.roomId} beigetreten`, true);
    return;
  }
  if (message.type === "peer-joined") {
    createPeer(message.peer.id, message.peer.name);
    announceLocalMedia();
    addChatEntry("System", `${message.peer.name} ist beigetreten`, true);
    return;
  }
  if (message.type === "peer-left") {
    const name = peerName(message.peerId);
    closePeer(message.peerId);
    addChatEntry("System", `${name} hat den Raum verlassen`, true);
    return;
  }
  if (message.type === "signal") {
    void acceptSignal(message);
    return;
  }
  if (message.type === "media-state") {
    const tracks = state.remoteTrackSources.get(message.from) || new Map();
    if (message.active) tracks.set(message.trackId, message.source);
    else {
      for (const [trackId, source] of tracks) if (source === message.source) tracks.delete(trackId);
    }
    state.remoteTrackSources.set(message.from, tracks);
    updateRemoteLabels(message.from);
    return;
  }
  if (message.type === "error") {
    addChatEntry("Server", `Fehler: ${message.code}`, true);
    if (message.code === "room_full") setConnectionStatus("Raum ist voll", "error");
  }
}

function joinRoom() {
  const name = elements.displayName.value.trim();
  const roomId = elements.roomId.value.trim().toLowerCase();
  if (!name || !roomId) {
    setConnectionStatus("Name und Raumcode fehlen", "error");
    return;
  }
  sessionStorage.setItem("webrtc-display-name", name);
  setConnectionStatus("Verbindung wird aufgebaut", "connecting");
  const socket = new WebSocket(webSocketUrl(roomId, name));
  state.socket = socket;
  state.ownName = name;
  socket.onmessage = (event) => {
    try { handleServerMessage(JSON.parse(event.data)); }
    catch { addChatEntry("Server", "Ungültige Servernachricht verworfen", true); }
  };
  socket.onerror = () => setConnectionStatus("Signaling fehlgeschlagen", "error");
  socket.onclose = () => {
    if (state.socket !== socket) return;
    state.socket = null;
    for (const peerId of [...state.peers.keys()]) closePeer(peerId);
    state.ownId = null;
    setJoined(false);
    setConnectionStatus("Nicht verbunden", "idle");
    updateParticipantCount();
  };
}

function stopPublication(source) {
  const publication = state.publications.get(source);
  if (!publication) return;
  const tracks = publication.stream.getTracks();
  for (const peer of state.peers.values()) {
    for (const sender of peer.pc.getSenders()) {
      if (sender.track && tracks.includes(sender.track)) peer.pc.removeTrack(sender);
    }
  }
  for (const track of tracks) {
    const trackSource = source === "screen" && track.kind === "audio" ? "screen-audio" : source;
    broadcastMediaState(trackSource, track, false);
    track.onended = null;
    track.stop();
  }
  publication.card.remove();
  state.publications.delete(source);
  if (source === "microphone") elements.microphone.textContent = "🎙 Mikrofon starten";
  if (source === "camera") elements.camera.textContent = "● Kamera starten";
  if (source === "screen") elements.screen.textContent = "▣ Bildschirm teilen";
  updateEmptyMedia();
}

function renderLocalPublication(source, stream) {
  const card = document.createElement("article");
  card.className = "media-card";
  const label = document.createElement("span");
  label.className = "media-label";
  label.textContent = `Du · ${sourceLabel(source)}`;
  const hasVideo = stream.getVideoTracks().length > 0;
  const media = document.createElement(hasVideo ? "video" : "audio");
  media.autoplay = true;
  media.muted = true;
  if (hasVideo) media.playsInline = true;
  else media.controls = true;
  media.srcObject = stream;
  card.append(label, media);
  elements.mediaGrid.prepend(card);
  return card;
}

async function startPublication(source) {
  elements.mediaError.textContent = "";
  let stream;
  try {
    if (source === "microphone") {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true }, video: false,
      });
    } else if (source === "camera") {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { width: { ideal: 1280, max: 1920 }, height: { ideal: 720, max: 1080 }, frameRate: { ideal: 24, max: 30 } },
      });
    } else {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 15, max: 30 } }, audio: true,
      });
    }
    if (state.publications.has(source)) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }
    const card = renderLocalPublication(source, stream);
    const publication = { source, stream, card };
    state.publications.set(source, publication);
    for (const peer of state.peers.values()) {
      for (const track of stream.getTracks()) peer.pc.addTrack(track, stream);
    }
    for (const track of stream.getTracks()) {
      const trackSource = source === "screen" && track.kind === "audio" ? "screen-audio" : source;
      broadcastMediaState(trackSource, track, true);
    }
    if (source === "screen") {
      const videoTrack = stream.getVideoTracks()[0];
      if (videoTrack) videoTrack.onended = () => stopPublication("screen");
      elements.screen.textContent = "■ Bildschirmfreigabe stoppen";
    } else if (source === "camera") elements.camera.textContent = "■ Kamera stoppen";
    else elements.microphone.textContent = "■ Mikrofon stoppen";
    updateEmptyMedia();
  } catch (error) {
    stream?.getTracks().forEach((track) => track.stop());
    elements.mediaError.textContent = error.name === "NotAllowedError"
      ? "Die Browserfreigabe wurde abgelehnt."
      : `Medienquelle konnte nicht gestartet werden: ${error.message}`;
  }
}

function togglePublication(source) {
  if (state.publications.has(source)) stopPublication(source);
  else void startPublication(source);
}

function leaveRoom() {
  for (const source of [...state.publications.keys()]) stopPublication(source);
  state.socket?.close(1000, "user_leave");
}

async function createRoom() {
  setConnectionStatus("Raum wird erstellt", "connecting");
  try {
    const response = await fetch("/api/rooms", { method: "POST" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const result = await response.json();
    elements.roomId.value = result.roomId;
    elements.inviteUrl.value = result.inviteUrl;
    elements.copyInvite.disabled = false;
    history.replaceState(null, "", `/?room=${encodeURIComponent(result.roomId)}`);
    setConnectionStatus("Raumcode erstellt", "idle");
  } catch (error) {
    setConnectionStatus(`Raum konnte nicht erstellt werden: ${error.message}`, "error");
  }
}

async function copyInvite() {
  try {
    await navigator.clipboard.writeText(elements.inviteUrl.value);
    setConnectionStatus("Einladungslink kopiert", state.ownId ? "connected" : "idle");
  } catch {
    elements.inviteUrl.select();
    setConnectionStatus("Link ist markiert – bitte kopieren", "idle");
  }
}

elements.createRoom.addEventListener("click", createRoom);
elements.joinRoom.addEventListener("click", joinRoom);
elements.leaveRoom.addEventListener("click", leaveRoom);
elements.copyInvite.addEventListener("click", copyInvite);
elements.microphone.addEventListener("click", () => togglePublication("microphone"));
elements.camera.addEventListener("click", () => togglePublication("camera"));
elements.screen.addEventListener("click", () => togglePublication("screen"));
elements.chatForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = elements.chatMessage.value.trim();
  if (!text) return;
  const encoded = JSON.stringify({ version: 1, type: "chat", text, sentAt: Date.now() });
  let recipients = 0;
  for (const peer of state.peers.values()) {
    if (peer.channel?.readyState === "open") {
      peer.channel.send(encoded);
      recipients += 1;
    }
  }
  if (recipients) {
    addChatEntry("Du", text);
    elements.chatMessage.value = "";
  } else addChatEntry("System", "Noch kein Peer-DataChannel verbunden", true);
});
window.addEventListener("beforeunload", () => {
  for (const publication of state.publications.values()) {
    publication.stream.getTracks().forEach((track) => track.stop());
  }
  state.socket?.close();
});

async function initialize() {
  const roomId = new URLSearchParams(location.search).get("room");
  if (roomId) {
    elements.roomId.value = roomId;
    elements.inviteUrl.value = location.href;
    elements.copyInvite.disabled = false;
  }
  elements.displayName.value = sessionStorage.getItem("webrtc-display-name") || "";
  try {
    const response = await fetch("/config");
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    state.config = await response.json();
    updateParticipantCount();
  } catch (error) {
    setConnectionStatus(`Konfiguration fehlt: ${error.message}`, "error");
    elements.joinRoom.disabled = true;
  }
  updateEmptyMedia();
}

void initialize();
