// Test-only address discovery. Not TURN relay evidence or a production service.
import { randomUUID } from "node:crypto";
import { isIP } from "node:net";

export function privateMachineStun({ network, address, lifetimeSeconds }, run) {
  if (!/^meet-test-tls-[a-f0-9-]{36}-network$/.test(network) || isIP(address) !== 4
    || !/^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/.test(address)
    || !Number.isInteger(lifetimeSeconds) || lifetimeSeconds < 180 || lifetimeSeconds > 7380) throw new Error("test_stun_scope_invalid");
  const image = run(["image", "inspect", process.env.MEET_TEST_STUN_IMAGE || "coturn/coturn:4.17.0", "--format", "{{.Id}}"]);
  if (!/^sha256:[a-f0-9]{64}$/.test(image)) throw new Error("test_stun_image_missing");
  const name = "meet-test-stun-" + randomUUID();
  let attempted = false, closed = false;
  return {
    url: `stun:${address}:3478`,
    start() {
      if (attempted || closed) throw new Error("test_stun_start_invalid");
      attempted = true;
      // The pinned Coturn executable carries NET_BIND_SERVICE file capability;
      // retain exactly that bounding bit even though this fixture uses port 3478.
      run(["create", "--name", name, "--network", network, "--ip", address,
        "--user=65534:65534", "--read-only", "--cap-drop=ALL", "--cap-add=NET_BIND_SERVICE", "--security-opt=no-new-privileges",
        "--memory=128m", "--pids-limit=32", "--cpus=.5", "--tmpfs=/tmp:size=16m,mode=1777",
        "--entrypoint=/usr/bin/timeout", image, "--signal=TERM", "--kill-after=5", String(lifetimeSeconds),
        "/usr/bin/turnserver", "-n", "--stun-only", "--no-auth", "--no-cli", "--no-tcp", "--no-tls", "--no-dtls",
        "--no-rfc5780", "--no-software-attribute", "--relay-threads=1", "--listening-ip=" + address,
        "--listening-port=3478", "--pidfile=/tmp/turnserver.pid", "--log-file=/dev/null", "--no-stdout-log"]);
      run(["start", name]);
      const running = run(["inspect", name, "--format", "{{.State.Running}}"]);
      if (running !== "true") throw new Error("test_stun_start_failed");
    },
    close() {
      if (closed) return; closed = true;
      if (attempted) run(["rm", "--force", name]);
    },
  };
}
