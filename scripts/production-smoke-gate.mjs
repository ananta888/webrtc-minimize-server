const origin = String(process.env.PRODUCTION_ORIGIN || "").replace(/\/$/, "");
if (!/^https:\/\/[^/]+$/.test(origin)) {
  throw new Error("PRODUCTION_ORIGIN must be an HTTPS origin");
}

async function get(path, type) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await fetch(`${origin}${path}`, {
      signal: controller.signal,
      redirect: "error",
      headers: { accept: type },
    });
    if (!response.ok) throw new Error(`${path} returned ${response.status}`);
    if (new URL(response.url).origin !== origin) throw new Error(`${path} crossed origin`);
    return response;
  } finally {
    clearTimeout(timeout);
  }
}

const health = await (await get("/healthz", "application/json")).json();
if (health.status !== "ok" || !Number.isSafeInteger(health.rooms) || !Number.isSafeInteger(health.participants)) {
  throw new Error("invalid health response");
}
const readiness = await (await get("/readyz", "application/json")).json();
if (readiness.status !== "ok" || readiness.controlPlane !== "ready") {
  throw new Error("control plane is not ready");
}
const configResponse = await get("/config", "application/json");
const config = await configResponse.json();
if (config.auth?.mode !== "required" || config.mediaE2ee?.mode !== "required"
  || config.maxRoomParticipants !== 20 || typeof config.broadcast?.whip?.enabled !== "boolean") {
  throw new Error("unsafe or incompatible production runtime configuration");
}
const page = await get("/", "text/html");
if (!String(page.headers.get("content-security-policy") || "").includes("default-src 'self'")) {
  throw new Error("production CSP is missing");
}
const html = await page.text();
if (!html.includes("<app-root")) throw new Error("Angular application shell is missing");

process.stdout.write(JSON.stringify({
  status: "ok",
  origin,
  controlPlane: readiness.controlPlane,
  broadcast: readiness.broadcast,
  broadcastWhipEnabled: config.broadcast.whip.enabled,
}) + "\n");
