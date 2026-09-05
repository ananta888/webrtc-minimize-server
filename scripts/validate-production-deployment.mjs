import { readFileSync } from "node:fs";

function read(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

const policy = JSON.parse(read("infra/deployment/production-policy.v1.json"));
const ports = JSON.parse(read("infra/deployment/port-firewall-matrix.v1.json"));
const compose = read("infra/deployment/compose.production.yaml");
const baseCompose = read("compose.yaml");
const dockerfile = read("Dockerfile");
const dockerignore = read(".dockerignore");
const deploy = read("scripts/production-deploy.sh");
const smoke = read("scripts/production-smoke-gate.mjs");
const turnTlsSync = read("scripts/sync-turn-tls-certificate.sh");
const turnTlsService = read("infra/deployment/ananta-turn-tls-sync.service");
const turnTlsTimer = read("infra/deployment/ananta-turn-tls-sync.timer");

if (policy.version !== 1 || policy.broadcast?.enabledByDefault !== false
  || policy.release?.automaticRollback !== true || policy.container?.readOnlyRoot !== true) {
  throw new Error("invalid production deployment policy");
}
if (ports.version !== 1 || ports.defaultPolicy !== "deny" || !Array.isArray(ports.entries)
  || ports.entries.length < 10) throw new Error("invalid production port matrix");
for (const entry of ports.entries) {
  const allowed = new Set(["component", "direction", "transport", "ports", "source", "requiredWhen", "public"]);
  if (!entry || Object.keys(entry).some((field) => !allowed.has(field))
    || !new Set(["inbound", "outbound"]).has(entry.direction)
    || typeof entry.public !== "boolean") throw new Error("invalid production port entry");
}
const nodePort = ports.entries.find(({ component, direction }) => (
  component === "webrtc-control" && direction === "inbound"
));
if (!nodePort || nodePort.public || nodePort.ports !== "8080") throw new Error("Node port must remain private");
for (const required of [
  "read_only: true", "cap_drop: [\"ALL\"]", "no-new-privileges:true", "ports: !reset []",
  "pids_limit: 256", "healthcheck:", "max-size: 10m",
]) {
  if (!compose.includes(required)) throw new Error(`production hardening missing: ${required}`);
}
if (!baseCompose.includes("${WEBRTC_BIND_ADDRESS:-127.0.0.1}:${PORT:-8080}:8080")) {
  throw new Error("development host port must default to loopback");
}
if (!dockerfile.includes("USER node") || !dockerfile.includes("org.opencontainers.image.revision")
  || /COPY\s+\.\s+\./.test(dockerfile)) throw new Error("runtime image policy mismatch");
for (const ignored of [".env", ".git", "node_modules", "dist"]) {
  if (!dockerignore.split(/\r?\n/).includes(ignored)) throw new Error(`Docker context must ignore ${ignored}`);
}
for (const required of [
  "git status --porcelain", "previous-image", "--no-build --wait", "rollback",
  "production-smoke-gate.mjs", "ensure-broadcast-signing-key.mjs",
  "native-broadcast-deployment-enabled.mjs", "--profile native-packager",
  "EXPECT_NATIVE_BROADCAST",
]) {
  if (!deploy.includes(required)) throw new Error(`safe deploy gate missing: ${required}`);
}
if (!compose.includes("/run/secrets/broadcast-signing-private-key.pem:ro")) {
  throw new Error("broadcast signing key must be mounted read-only from deployment state");
}
for (const required of [
  "/healthz", "/readyz", "/config", "auth?.mode", "mediaE2ee?.mode", "content-security-policy",
  "native broadcast dependencies are not ready",
]) {
  if (!smoke.includes(required)) throw new Error(`external smoke assertion missing: ${required}`);
}
for (const productionFile of [compose, JSON.stringify(policy), JSON.stringify(ports)]) {
  if (/sharedSecret\s*["':=]+\s*(?!\$\{)[A-Za-z0-9+/]{16}/i.test(productionFile)) {
    throw new Error("literal secret found in production deployment files");
  }
}
for (const required of [
  "openssl verify", "-verify_hostname", "-checkend", "openssl pkey", "cmp -s",
  "mv -Tf", "com.docker.compose.project", "com.docker.compose.service",
]) {
  if (!turnTlsSync.includes(required)) throw new Error(`TURN TLS sync gate missing: ${required}`);
}
for (const required of [
  "NoNewPrivileges=yes", "ProtectSystem=strict", "ReadWritePaths=/etc/ananta/turn-tls",
]) {
  if (!turnTlsService.includes(required)) throw new Error(`TURN TLS service hardening missing: ${required}`);
}
if (!turnTlsTimer.includes("Persistent=true") || !turnTlsTimer.includes("RandomizedDelaySec=")) {
  throw new Error("TURN TLS renewal timer is not persistent and jittered");
}

process.stdout.write("Validated production deployment policy, ports, hardening, secrets and rollback gates.\n");
