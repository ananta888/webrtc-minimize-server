import type { JoinProofInput } from "../identity/device-identity.service";
import type { SessionOperation } from "./session-operation";
import { MachineSessionLease, parseMachineSessionLease } from "./machine-session-contract";

interface MachineRenewalPorts {
  readonly previous: MachineSessionLease;
  readonly startedAt: number;
  readonly roomId: string;
  readonly grant: string;
  readonly operation: SessionOperation;
  createProof(input: JoinProofInput): Promise<unknown>;
  current(): boolean;
  commit(lease: MachineSessionLease): void;
}

/** Loaded only for an explicit renewal. Neither HTTP success nor a delayed
 * expiry timer permits crossing the old lease's local validity boundary. */
export async function renewMachineLease(ports: MachineRenewalPorts): Promise<MachineSessionLease> {
  const { previous, roomId, grant, operation } = ports;
  let lastNow = ports.startedAt;
  const check = () => {
    operation.signal.throwIfAborted();
    const now = Date.now();
    if (!Number.isSafeInteger(now) || now < lastNow || now >= previous.expiresAt || !ports.current()) {
      throw new Error("machine_renewal_scope_changed");
    }
    lastNow = now;
    return now;
  };
  check();
  const deviceProof = await operation.wait(() => ports.createProof({ roomId, mode: "room", displayName: "Ananta (KI)",
    machineSessionId: previous.sessionId, expectedGeneration: previous.generation }));
  check();
  const response = await operation.wait(() => fetch("/api/machine/sessions/renew", {
    method: "POST", credentials: "same-origin", redirect: "error", signal: operation.signal,
    headers: { "content-type": "application/json", Authorization: `Bearer ${grant}` },
    body: JSON.stringify({ roomId, sessionId: previous.sessionId, expectedGeneration: previous.generation, deviceProof }),
  }));
  check();
  if (!response.ok) throw new Error("machine_renewal_denied");
  const body: unknown = await operation.wait(() => response.json());
  const next = parseMachineSessionLease(body, check());
  if (next.sessionId !== previous.sessionId || next.generation !== previous.generation + 1
    || next.absoluteExpiresAt !== previous.absoluteExpiresAt || next.expiresAt <= previous.expiresAt) {
    throw new Error("machine_renewal_scope_changed");
  }
  // No Promise handoff between the last authority observation and publication.
  check(); ports.commit(next);
  return next;
}
