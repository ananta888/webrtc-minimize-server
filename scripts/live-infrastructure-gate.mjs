import { superviseLiveInfrastructure } from "./live-infrastructure-supervisor.mjs";

if (process.env.RUN_LIVE_INFRASTRUCTURE !== "1") {
  console.log("SKIP live Keycloak/TURN gate: set RUN_LIVE_INFRASTRUCTURE=1 with explicit test credentials");
} else {
  const report = await superviseLiveInfrastructure();
  console.log(JSON.stringify(report));
  process.exitCode = report.status === "passed" ? 0 : 1;
}
