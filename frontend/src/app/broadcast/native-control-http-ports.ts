import type { BroadcastBrowserPortError } from "./broadcast-ports";

export interface NativeControlHttpPorts {
  fingerprint(): string | null;
  authorizationHeader(): Record<string, string>;
  readJson(response: Response, code: string, maximumBytes: number): Promise<Record<string, unknown>>;
  responseError(response: Response, code: string): BroadcastBrowserPortError;
}
