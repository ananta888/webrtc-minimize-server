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
const caddy = read("infra/reverse-proxy/Caddyfile.webrtc.production");

if (policy.version !== 1 || policy.broadcast?.enabledByDefault !== false
  || policy.release?.automaticRollback !== true || policy.container?.readOnlyRoot !== true
  || policy.egress?.enforcement !== "DOCKER-USER source-subnet allowlist maintained by pinned firewall guard"
  || policy.egress?.nativePackagerIceTransportPolicy !== "relay") {
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
  "pids_limit: 256", "healthcheck:", "max-size: 10m", "networks: !override",
  "reverse-proxy:", "broadcast-origin:", "native-packager:",
  "production-egress-firewall:", "network_mode: host", "cap_add: [\"NET_ADMIN\"]",
  "NATIVE_PACKAGER_ICE_TRANSPORT_POLICY: relay", "control-egress:", "packager-egress:",
]) {
  if (!compose.includes(required)) throw new Error(`production hardening missing: ${required}`);
}
if ((compose.match(/networks: !override/g) || []).length !== 2
  || !/native-packager:\s+[\s\S]*?networks: !override\s+packager-egress:/m.test(compose)) {
  throw new Error("production services must use their minimal network sets");
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
  "docker image tag", "webrtc-minimize-server:rollback", "previous_file.new",
  "production-smoke-gate.mjs", "ensure-broadcast-signing-key.mjs",
  "native-broadcast-deployment-enabled.mjs", "--profile native-packager",
  "EXPECT_NATIVE_BROADCAST", "production-egress-firewall",
  "rotate-broadcast-key", "CONFIRM_BROADCAST_KEY_ROTATION", "Signing-key rotation failed",
  "mv -Tf", "previous_key", "--force-recreate",
]) {
  if (!deploy.includes(required)) throw new Error(`safe deploy gate missing: ${required}`);
}
const egressFirewall = read("scripts/production-egress-firewall.sh");
for (const required of [
  "DOCKER-USER", "ananta-control-default-deny", "ananta-packager-default-deny",
  "--dport 443", "--dport 3478", "--dport 5349", "ESTABLISHED,RELATED",
]) {
  if (!egressFirewall.includes(required)) throw new Error(`egress enforcement missing: ${required}`);
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
for (const required of [
  "https://webrtc.ananta.de", "not method GET HEAD POST PUT PATCH DELETE OPTIONS",
  "max_size 256KB", "X-Forwarded-Host webrtc.ananta.de", "response_header_timeout 10s",
]) {
  if (!caddy.includes(required)) throw new Error(`Caddy production boundary missing: ${required}`);
}
for (const forbidden of ["/debug", "/metrics", "/pprof", "reverse_proxy broadcast-gateway"]) {
  if (caddy.includes(forbidden)) throw new Error(`Caddy production boundary exposes forbidden path: ${forbidden}`);
}

process.stdout.write("Validated production deployment policy, ports, hardening, secrets and rollback gates.\n");
