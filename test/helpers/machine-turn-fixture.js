// Ephemeral authenticated TURN on the fixture's owned internal bridge only.
import { randomBytes, randomUUID } from "node:crypto";
import { isIP } from "node:net";

export function privateMachineTurn({ network, address, lifetimeSeconds, transport, participants = 2 }, run) {
  if (!/^meet-test-tls-[a-f0-9-]{36}-network$/.test(network) || isIP(address) !== 4
    || !/^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/.test(address)
    || !Number.isInteger(lifetimeSeconds) || lifetimeSeconds < 180 || lifetimeSeconds > 7380
    || !["udp", "tcp"].includes(transport) || ![2, 3].includes(participants)) throw new Error("test_turn_scope_invalid");
  // Coturn reserves max-bps per allocation even when idle. Keep total capacity
  // fixed; six three-party mesh allocations must not compete for four slots.
  const maxBps = participants === 3 ? 500_000 : 1_000_000;
  const image = run(["image", "inspect", process.env.MEET_TEST_STUN_IMAGE || "coturn/coturn:4.17.0", "--format", "{{.Id}}"]);
  if (!/^sha256:[a-f0-9]{64}$/.test(image)) throw new Error("test_turn_image_missing");
  const name = "meet-test-turn-" + randomUUID(), secret = randomBytes(32).toString("hex");
  let attempted = false, closed = false;
  return {
    config: Object.freeze({ turnUrls: Object.freeze([`turn:${address}:3478?transport=${transport}`]),
      turnSharedSecret: secret, turnRealm: "machine-fixture.test", turnCredentialTtlMs: 120_000 }),
    start() {
      if (attempted || closed) throw new Error("test_turn_start_invalid");
      attempted = true;
      run(["create", "--name", name, "--network", network, "--ip", address,
        "--user=65534:65534", "--read-only", "--cap-drop=ALL", "--cap-add=NET_BIND_SERVICE", "--security-opt=no-new-privileges",
        "--memory=128m", "--pids-limit=32", "--cpus=.5", "--tmpfs=/tmp:size=16m,mode=1777",
        "--entrypoint=/usr/bin/timeout", image, "--signal=TERM", "--kill-after=5", String(lifetimeSeconds),
        "/usr/bin/turnserver", "-n", "--use-auth-secret", "--static-auth-secret=" + secret,
        "--realm=machine-fixture.test", "--no-cli", transport === "udp" ? "--no-tcp" : "--no-udp",
        "--no-tls", "--no-dtls", "--no-tcp-relay", "--no-rfc5780", "--no-software-attribute", "--relay-threads=1",
        "--listening-ip=" + address, "--relay-ip=" + address, "--listening-port=3478", "--min-port=49160", "--max-port=49191",
        "--total-quota=16", "--user-quota=8", "--bps-capacity=4000000", "--max-bps=" + maxBps,
        "--denied-peer-ip=0.0.0.0-255.255.255.255", "--allowed-peer-ip=" + address,
        "--pidfile=/tmp/turnserver.pid", "--log-file=/dev/null", "--no-stdout-log"]);
      run(["start", name]);
      if (run(["inspect", name, "--format", "{{.State.Running}}"]) !== "true") throw new Error("test_turn_start_failed");
    },
    close() {
      if (closed) return; closed = true;
      if (attempted) run(["rm", "--force", name]);
    },
  };
}
