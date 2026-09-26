/** Reverse proxies (Caddy keeps idle upstream connections for up to 2 min)
 * reuse keep-alive sockets. Node's 5 s default closes them first, so a proxy
 * can write a POST into a socket the server is closing and answer 502; POSTs
 * are not retried. The server therefore outlives the proxy's idle timeout. */
export function applyHttpKeepAlive(server, { httpKeepAliveTimeoutMs }) {
  server.keepAliveTimeout = httpKeepAliveTimeoutMs;
  // Must exceed keepAliveTimeout, or Node drops a reused socket mid-headers.
  server.headersTimeout = httpKeepAliveTimeoutMs + 5_000;
  return server;
}
