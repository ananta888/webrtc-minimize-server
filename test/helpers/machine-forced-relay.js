/** Test-only transport constraint. Uses the actual authorized HTTP response,
 * never a fabricated grant, a public config credential or an extra request. */
export function installMachineForcedRelay(expectedUrl) {
  let authorizedServers = [];
  const nativeFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = async (...args) => {
    const input = args[0], url = new URL(typeof input === "string" ? input : input.url, location.href);
    const session = url.origin === location.origin && ["/api/sessions", "/api/machine/sessions"].includes(url.pathname)
      && String(args[1]?.method || input.method || "GET").toUpperCase() === "POST";
    if (session) authorizedServers = [];
    const response = await nativeFetch(...args);
    if (!session || response.status !== 201) return response;
    if (response.redirected) throw new Error("test_relay_session_redirect");
    const body = await response.clone().json(), servers = body.icePolicy?.infrastructureRelayIceServers;
    if (body.icePolicy?.version !== 1 || !Array.isArray(servers) || servers.length !== 1)
      throw new Error("test_relay_session_invalid");
    const server = servers[0];
    if (!server || Object.keys(server).sort().join() !== "credential,credentialType,urls,username"
      || !Array.isArray(server.urls) || server.urls.length !== 1 || server.urls[0] !== expectedUrl
      || typeof server.username !== "string" || !/^\d+:[a-f0-9]{20}$/.test(server.username)
      || server.credentialType !== "password" || typeof server.credential !== "string"
      || !/^[A-Za-z0-9+/]{27}=$/.test(server.credential)) throw new Error("test_relay_session_invalid");
    authorizedServers = [Object.freeze({ ...server, urls: Object.freeze([...server.urls]) })];
    return response;
  };
  const Native = globalThis.RTCPeerConnection;
  globalThis.RTCPeerConnection = class extends Native {
    constructor(config, ...rest) {
      if (authorizedServers.length !== 1) throw new Error("test_relay_session_required");
      const servers = [...authorizedServers];
      super({ ...config, iceServers: servers, iceTransportPolicy: "relay" }, ...rest);
      this.fixtureServers = servers;
    }
    setConfiguration(config) {
      return super.setConfiguration({ ...config, iceServers: this.fixtureServers, iceTransportPolicy: "relay" });
    }
  };
}
