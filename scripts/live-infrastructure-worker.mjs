// Internal owned process. The public CLI supervises and reaps this process group.
import { runLiveInfrastructure } from "./live-infrastructure-check.mjs";

try {
  if (typeof process.send !== "function" || process.env.RUN_LIVE_INFRASTRUCTURE !== "1") throw new Error();
  const relays = await runLiveInfrastructure();
  process.send({ status: "passed", relays });
} catch {
  if (typeof process.send === "function") process.send({ status: "failed", relays: [] });
  process.exitCode = 1;
} finally { if (process.connected) process.disconnect(); }
