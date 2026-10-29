export type DrawioHostEventName = "init" | "configure" | "load" | "autosave" | "save" | "exit";

export interface DrawioHostEvent {
  readonly event: DrawioHostEventName;
  readonly xml?: string;
}

const EVENTS = new Set<DrawioHostEventName>(["init", "configure", "load", "autosave", "save", "exit"]);
const XML_EVENTS = new Set<DrawioHostEventName>(["autosave", "save"]);
const MAX_XML_BYTES = 256 * 1024;

export const DRAWIO_EMBED_URL = [
  "/drawio/index.html",
  "?embed=1&proto=json&spin=1&lang=de&math=0&libraries=0",
  "&saveAndExit=0&noSaveBtn=1&noExitBtn=1&noPublishBtn=1",
  "&gapi=0&od=0&ms365=0&gh=0&gl=0&stealth=1&lockdown=1",
].join("");

export function parseDrawioEvent(value: unknown): DrawioHostEvent | null {
  let data: unknown = value;
  if (typeof data === "string") {
    try {
      data = JSON.parse(data);
    } catch {
      return null;
    }
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const record = data as Record<string, unknown>;
  const event = record["event"];
  if (typeof event !== "string" || !EVENTS.has(event as DrawioHostEventName)) return null;
  if (!XML_EVENTS.has(event as DrawioHostEventName)) return Object.freeze({ event: event as DrawioHostEventName });
  const xml = record["xml"];
  if (typeof xml !== "string" || new TextEncoder().encode(xml).byteLength > MAX_XML_BYTES) return null;
  return Object.freeze({ event: event as DrawioHostEventName, xml });
}

export function encodeDrawioAction(action: Readonly<Record<string, unknown>>): string {
  return JSON.stringify(action);
}

export function drawioLoadMessage(xml: string): Readonly<Record<string, unknown>> {
  return Object.freeze({ action: "load", xml, autosave: 1 });
}

export function drawioConfigureMessage(): Readonly<Record<string, unknown>> {
  return Object.freeze({ action: "configure", config: Object.freeze({}) });
}
