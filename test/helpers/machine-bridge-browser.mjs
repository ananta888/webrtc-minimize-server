// A private fixture may ask its owning Python controller for an isolated browser.
// No application task, grant, media input or pre-existing user browser is accepted.
import { isIP } from "node:net";
import { parseMachineTrustJson } from "../../src/machine-trust-json.js";

export function bridgeBrowserLauncher({ send, receive, connect, timeoutMs = 60000 }) {
  let used = false;
  return async ({ engine, network, certificatePath, spki, originHost }) => {
    if (used || engine !== "chromium" || !/^meet-test-tls-[a-f0-9-]{36}-network$/.test(network || "")
      || typeof certificatePath !== "string" || certificatePath.length > 512 || !/^[A-Za-z0-9+/]{43}=$/.test(spki || "")
      || isIP(originHost || "") !== 4 || !/^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/.test(originHost)) {
      throw new Error("test_bridge_browser_request_invalid");
    }
    used = true;
    let timer;
    try {
      const pending = receive();
      send({ schema: "ananta.meet-test-browser-request.v1", test_network: network,
        certificate: certificatePath, spki });
      const message = await Promise.race([pending, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("test_bridge_browser_deadline")), timeoutMs);
      })]);
      if (message.done || typeof message.value !== "string" || message.value.length > 1024) throw new Error();
      const value = parseMachineTrustJson(message.value, 1024);
      if (!value || Object.keys(value).length !== 2 || value.schema !== "ananta.meet-test-browser-response.v1"
        || typeof value.endpoint !== "string") throw new Error();
      const url = new URL(value.endpoint), prefix = originHost.slice(0, originHost.lastIndexOf(".") + 1);
      if (url.protocol !== "ws:" || url.port !== "8099" || !url.hostname.startsWith(prefix)
        || !/^\d{1,3}$/.test(url.hostname.slice(prefix.length)) || url.username || url.password || url.search || url.hash
        || !/^\/[a-f0-9]{32}$/.test(url.pathname) || url.href !== value.endpoint) throw new Error();
      return await connect(value.endpoint, { timeout: 15000 });
    } catch {
      throw new Error("test_bridge_browser_unavailable");
    } finally { clearTimeout(timer); }
  };
}
