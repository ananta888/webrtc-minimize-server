import { BroadcastBrowserPortError } from "./broadcast-ports";
import { WhipAudioEncodingPolicy } from "./whip-contracts";

export interface WhipIceCandidate {
  readonly candidate: string;
  readonly sdpMid: string | null;
  readonly sdpMLineIndex: number | null;
}

interface SdpSection {
  readonly media: string;
  readonly lines: string[];
}

interface ParsedSdp {
  readonly session: string[];
  readonly sections: SdpSection[];
}

const CONTROL = /[\u0000\u000b\u000c]/;
const ICE_VALUE = /^[A-Za-z0-9+/]{4,256}$/;
const MID = /^[A-Za-z0-9_-]{1,32}$/;

function fail(code: string): never {
  throw new BroadcastBrowserPortError(code);
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function parse(sdp: unknown, maximumBytes: number, code: string): ParsedSdp {
  if (typeof sdp !== "string" || byteLength(sdp) < 16 || byteLength(sdp) > maximumBytes
    || CONTROL.test(sdp)) fail(code);
  const lines = sdp.replace(/\r?\n/g, "\r\n").split("\r\n").filter(Boolean);
  if (lines[0] !== "v=0") fail(code);
  const session: string[] = [];
  const sections: SdpSection[] = [];
  let current: SdpSection | null = null;
  for (const line of lines) {
    if (line.length > 4_096 || !/^[a-z]=/.test(line)) fail(code);
    if (line.startsWith("m=")) {
      const media = line.slice(2).split(" ", 1)[0];
      current = { media, lines: [line] };
      sections.push(current);
    } else if (current) current.lines.push(line);
    else session.push(line);
  }
  if (sections.length < 1 || sections.length > 2) fail(code);
  return { session, sections };
}

function parseIceFragment(fragment: unknown, maximumBytes: number): ParsedSdp {
  if (typeof fragment !== "string" || byteLength(fragment) < 16 || byteLength(fragment) > maximumBytes
    || CONTROL.test(fragment)) fail("invalid_whip_ice_restart_response");
  const lines = fragment.replace(/\r?\n/g, "\r\n").split("\r\n").filter(Boolean);
  const session: string[] = [];
  const sections: SdpSection[] = [];
  let current: SdpSection | null = null;
  for (const line of lines) {
    if (line.length > 4_096 || !/^[a-z]=/.test(line)) fail("invalid_whip_ice_restart_response");
    if (line.startsWith("m=")) {
      const media = line.slice(2).split(" ", 1)[0];
      current = { media, lines: [line] };
      sections.push(current);
    } else if (current) current.lines.push(line);
    else session.push(line);
  }
  if (sections.length !== 1) fail("invalid_whip_ice_restart_response");
  return { session, sections };
}

function serialize(parsed: ParsedSdp): string {
  return `${[
    ...parsed.session,
    ...parsed.sections.flatMap(({ lines }) => lines),
  ].join("\r\n")}\r\n`;
}

function mediaPort(section: SdpSection): number {
  const value = Number(section.lines[0].split(/\s+/)[1]);
  return Number.isSafeInteger(value) ? value : -1;
}

function attribute(section: SdpSection, name: string): string | null {
  const prefix = `a=${name}:`;
  return section.lines.find((line) => line.startsWith(prefix))?.slice(prefix.length) || null;
}

function has(section: SdpSection, value: string): boolean {
  return section.lines.includes(`a=${value}`);
}

function validateBundle(parsed: ParsedSdp, code: string): void {
  const bundle = parsed.session.find((line) => line.startsWith("a=group:BUNDLE "));
  const mids = parsed.sections.map((section) => attribute(section, "mid"));
  if (!bundle || mids.some((mid) => !mid || !MID.test(mid))
    || new Set(mids).size !== mids.length
    || mids.some((mid) => !bundle.split(/\s+/).slice(1).includes(String(mid)))) fail(code);
}

function validateMediaSections(
  parsed: ParsedSdp,
  direction: "sendonly" | "recvonly",
  code: string,
  allowMissingRtcpMuxOnly = false,
): void {
  const mediaKinds = parsed.sections.map(({ media }) => media);
  if (mediaKinds.some((kind) => kind !== "audio" && kind !== "video")
    || new Set(mediaKinds).size !== mediaKinds.length
    || parsed.sections.some((section) => mediaPort(section) <= 0
      || !has(section, direction)
      || has(section, direction === "sendonly" ? "recvonly" : "sendonly")
      || has(section, "inactive")
      || !has(section, "rtcp-mux")
      || (!allowMissingRtcpMuxOnly && !has(section, "rtcp-mux-only")))) fail(code);
}

function applyOpusPolicy(parsed: ParsedSdp, policy: WhipAudioEncodingPolicy): void {
  if (!policy || policy.policyVersion !== 1
    || !Number.isSafeInteger(policy.opusBitsPerSecond)
    || policy.opusBitsPerSecond < 20_000 || policy.opusBitsPerSecond > 510_000
    || (policy.channelCount !== 1 && policy.channelCount !== 2)
    || typeof policy.dtx !== "boolean" || typeof policy.fec !== "boolean") {
    fail("invalid_whip_audio_policy");
  }
  const section = parsed.sections.find(({ media }) => media === "audio");
  if (!section) fail("whip_audio_policy_without_audio");
  const opus = section.lines.map((line) => /^a=rtpmap:(\d+) opus\/48000(?:\/2)?$/i.exec(line))
    .find((match) => match !== null);
  if (!opus) fail("whip_opus_unavailable");
  const payload = opus[1];
  const prefix = `a=fmtp:${payload} `;
  const index = section.lines.findIndex((line) => line.startsWith(prefix));
  const values = new Map<string, string>();
  if (index >= 0) {
    for (const part of section.lines[index].slice(prefix.length).split(";")) {
      const [key, value] = part.trim().split("=", 2);
      if (key && value && /^[A-Za-z0-9_-]{1,32}$/.test(key) && /^[A-Za-z0-9_.-]{1,64}$/.test(value)) {
        values.set(key.toLowerCase(), value);
      }
    }
  }
  values.set("maxaveragebitrate", String(policy.opusBitsPerSecond));
  values.set("stereo", policy.channelCount === 2 ? "1" : "0");
  values.set("sprop-stereo", policy.channelCount === 2 ? "1" : "0");
  values.set("usedtx", policy.dtx ? "1" : "0");
  values.set("useinbandfec", policy.fec ? "1" : "0");
  const line = `${prefix}${[...values].map(([key, value]) => `${key}=${value}`).join(";")}`;
  if (index >= 0) section.lines[index] = line;
  else section.lines.push(line);
}

export function prepareWhipOffer(
  sdp: unknown,
  maximumBytes: number,
  audioPolicy?: WhipAudioEncodingPolicy,
): string {
  const parsed = parse(sdp, maximumBytes, "invalid_whip_offer_sdp");
  for (const section of parsed.sections) {
    if (!has(section, "rtcp-mux")) fail("invalid_whip_offer_sdp");
    if (!has(section, "rtcp-mux-only")) {
      const index = section.lines.indexOf("a=rtcp-mux");
      section.lines.splice(index + 1, 0, "a=rtcp-mux-only");
    }
  }
  if (audioPolicy) applyOpusPolicy(parsed, audioPolicy);
  validateBundle(parsed, "invalid_whip_offer_sdp");
  validateMediaSections(parsed, "sendonly", "invalid_whip_offer_sdp");
  const streamIds = parsed.sections.map((section) => attribute(section, "msid")?.split(/\s+/)[0] || "");
  if (streamIds.some((id) => !id) || new Set(streamIds).size !== 1) fail("invalid_whip_offer_sdp");
  const normalized = serialize(parsed);
  if (byteLength(normalized) > maximumBytes) fail("invalid_whip_offer_sdp");
  return normalized;
}

export function validateWhipAnswer(
  sdp: unknown,
  maximumBytes: number,
  options: Readonly<{ allowMissingRtcpMuxOnly?: boolean }> = {},
): string {
  const parsed = parse(sdp, maximumBytes, "invalid_whip_answer_sdp");
  validateBundle(parsed, "invalid_whip_answer_sdp");
  validateMediaSections(
    parsed,
    "recvonly",
    "invalid_whip_answer_sdp",
    options.allowMissingRtcpMuxOnly === true,
  );
  return serialize(parsed);
}

function masterSection(parsed: ParsedSdp, code: string): SdpSection {
  validateBundle(parsed, code);
  const section = parsed.sections.find((candidate) => !has(candidate, "bundle-only")) || parsed.sections[0];
  if (!section) fail(code);
  return section;
}

export function createWhipIceFragment(
  localSdp: unknown,
  candidates: readonly WhipIceCandidate[],
  endOfCandidates: boolean,
  maximumBytes: number,
): string {
  const parsed = parse(localSdp, Math.max(maximumBytes, 512 * 1_024), "invalid_whip_local_sdp");
  const master = masterSection(parsed, "invalid_whip_local_sdp");
  const mid = attribute(master, "mid");
  const ufrag = attribute(master, "ice-ufrag");
  const password = attribute(master, "ice-pwd");
  if (!mid || !MID.test(mid) || !ufrag || !ICE_VALUE.test(ufrag)
    || !password || !ICE_VALUE.test(password)) fail("invalid_whip_local_sdp");
  const candidateLines = candidates.map((candidate) => {
    if (!candidate || typeof candidate.candidate !== "string"
      || candidate.candidate.length < 1 || candidate.candidate.length > 2_048
      || /[\r\n\u0000]/.test(candidate.candidate)
      || !candidate.candidate.startsWith("candidate:")
      || (candidate.sdpMid !== null && candidate.sdpMid !== mid)
      || (candidate.sdpMLineIndex !== null && candidate.sdpMLineIndex !== parsed.sections.indexOf(master))) {
      fail("invalid_whip_ice_candidate");
    }
    return `a=${candidate.candidate}`;
  });
  const group = parsed.session.find((line) => line.startsWith("a=group:BUNDLE ")) || "";
  const fragment = `${[
    group,
    master.lines[0],
    `a=mid:${mid}`,
    `a=ice-ufrag:${ufrag}`,
    `a=ice-pwd:${password}`,
    ...candidateLines,
    ...(endOfCandidates ? ["a=end-of-candidates"] : []),
  ].filter(Boolean).join("\r\n")}\r\n`;
  if (byteLength(fragment) > maximumBytes) fail("whip_ice_fragment_too_large");
  return fragment;
}

export function applyWhipIceRestartAnswer(
  previousAnswer: unknown,
  fragment: unknown,
  maximumSdpBytes: number,
  maximumFragmentBytes: number,
): string {
  const answer = parse(previousAnswer, maximumSdpBytes, "invalid_whip_answer_sdp");
  const restart = parseIceFragment(fragment, maximumFragmentBytes);
  const restartMaster = masterSection(restart, "invalid_whip_ice_restart_response");
  const ufrag = attribute(restartMaster, "ice-ufrag");
  const password = attribute(restartMaster, "ice-pwd");
  if (!ufrag || !ICE_VALUE.test(ufrag) || !password || !ICE_VALUE.test(password)) {
    fail("invalid_whip_ice_restart_response");
  }
  const candidateLines = restartMaster.lines.filter((line) => (
    line.startsWith("a=candidate:") || line === "a=end-of-candidates"
  ));
  const answerMaster = masterSection(answer, "invalid_whip_answer_sdp");
  answer.sections.forEach((section) => {
    section.lines.splice(1, section.lines.length - 1, ...section.lines.slice(1).filter((line) => (
      !line.startsWith("a=ice-ufrag:") && !line.startsWith("a=ice-pwd:")
      && !line.startsWith("a=candidate:") && line !== "a=end-of-candidates"
    )));
    const midIndex = Math.max(1, section.lines.findIndex((line) => line.startsWith("a=mid:")) + 1);
    section.lines.splice(midIndex, 0, `a=ice-ufrag:${ufrag}`, `a=ice-pwd:${password}`);
    if (section === answerMaster) section.lines.push(...candidateLines);
  });
  const normalized = serialize(answer);
  validateWhipAnswer(normalized, maximumSdpBytes);
  return normalized;
}
