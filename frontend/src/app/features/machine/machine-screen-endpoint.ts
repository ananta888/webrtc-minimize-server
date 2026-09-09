import type { MachineScreenSource } from "./machine-screen-source";

/** Composes owned sources only; authorization remains in each source adapter. */
export function machineScreenEndpoint(
  screen: Pick<MachineScreenSource, "open" | "close" | "push" | "status" | "diagnostics">,
  audio: { close(): void },
) {
  const close = () => {
    let failed = false;
    try { audio.close(); } catch { failed = true; }
    try { screen.close(); } catch { failed = true; }
    if (failed) throw new Error("meet_screen_cleanup_failed");
  };
  return Object.freeze({
    open: (sourceId: string) => { close(); return screen.open(sourceId); },
    push: (generation: number, sequence: number, jpeg: string) => screen.push(generation, sequence, jpeg),
    close,
    status: () => screen.status(),
    diagnostics: () => screen.diagnostics(),
  });
}
