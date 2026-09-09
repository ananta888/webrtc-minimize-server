import { setTimeout as delay } from "node:timers/promises";
import { BroadcastRuntimeError } from "./broadcast-runtime-registry.js";
import { NativePackagerAssignmentError } from "./native-packager-assignment.js";

// This coordinator owns the real stop-ACK barrier, not the browser or agent.
// A failed/disconnected writer is not equivalent to a terminal stopped ACK.
export async function handoffNativePackager({ runtime, assignments, identity, ownerPrincipal,
  programId, input, getMember, send, signal, clock = Date.now }) {
  runtime.nativeControl(identity, getMember(), programId); // Do not enumerate foreign program/assignment state.
  const previous = assignments.activeForProgram(programId);
  if (!previous || !new Set(["running", "degraded"]).has(previous.state)
    || previous.programEpoch !== input.expectedProgramEpoch
    || previous.fencingRevision !== input.expectedFencingRevision) {
    throw new BroadcastRuntimeError("stale_broadcast_handoff_writer", 409);
  }
  const admit = request => {
    if (assignments.activeForPackager(input.packagerId)) {
      throw new NativePackagerAssignmentError("native_packager_assignment_conflict", 409);
    }
    return previous.inputMode === "trusted-sframe-v1"
      ? assignments.admitSourceProgram(ownerPrincipal, input.packagerId, request, getMember()?.id, clock())
      : assignments.admit(ownerPrincipal, input.packagerId, request, clock());
  };
  signal.throwIfAborted();
  const pending = runtime.beginNativeHandoff(identity, getMember(), programId, input, admit, clock());
  const drainDeadline = performance.now() + 12_000;
  let installed = false;
  try {
    if (pending.previousPackagerId !== previous.packagerId) throw new BroadcastRuntimeError("stale_broadcast_handoff_writer", 409);
    const stopped = assignments.stop(ownerPrincipal, previous.packagerId, previous.assignmentId, "PACKAGER_HANDOFF", clock());
    if (!stopped.command || !send(previous.packagerId, stopped.command)) {
      throw new NativePackagerAssignmentError("native_packager_handoff_stop_delivery_failed", 503);
    }
    for (;;) {
      signal.throwIfAborted();
      if (clock() >= pending.expiresAt || performance.now() >= drainDeadline) {
        throw new BroadcastRuntimeError("broadcast_handoff_stop_timeout", 409);
      }
      const status = assignments.handoffStopStatus(ownerPrincipal, previous.assignmentId);
      if (status === "failed") throw new BroadcastRuntimeError("broadcast_handoff_writer_failed", 409);
      if (status === "stopped") break;
      await delay(Math.min(25, Math.max(1, drainDeadline - performance.now())), undefined, { signal });
    }
    signal.throwIfAborted();
    const member = getMember(); // Fresh room/device membership after asynchronous drain.
    const prepared = runtime.completeNativeHandoff(identity, member, pending, admit, clock());
    installed = true;
    const prepare = previous.inputMode === "trusted-sframe-v1"
      ? assignments.prepareSourceProgram.bind(assignments) : assignments.prepare.bind(assignments);
    const assignment = prepare(ownerPrincipal, input.packagerId, prepared.admission,
      prepared.lease, member.id, clock());
    if (!send(input.packagerId, assignment.command)) {
      throw new NativePackagerAssignmentError("native_packager_offline", 503);
    }
    return Object.freeze({ assignment: assignment.snapshot, program: prepared.program });
  } catch (error) {
    if (installed) {
      assignments.failPackager(input.packagerId, "HANDOFF_DELIVERY_FAILED", clock());
      runtime.stopProgram(identity, programId, clock());
    } else runtime.cancelNativeHandoff(identity, pending, clock());
    if (signal.aborted) throw new BroadcastRuntimeError("broadcast_handoff_aborted", 409);
    throw error;
  }
}
