// Test-only opaque TLS forwarding on an owned internal network. Never bind a
// public/host port, change production origin policy or mount host credentials.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { privateMachineStun } from "./machine-stun-fixture.js";

function docker(args) {
  try {
    return execFileSync("docker", args, { encoding: "utf8", timeout: 30000, maxBuffer: 16384, stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch {
    throw new Error("test_docker_command_failed");
  }
}

export function privateMachineTlsProxy(lifetimeSeconds, run = docker, connectionLimit = 16) {
  if (!Number.isInteger(lifetimeSeconds) || lifetimeSeconds < 180 || lifetimeSeconds > 7380) throw new Error("test_lifetime_invalid");
  if (![16, 32].includes(connectionLimit)) throw new Error("test_proxy_connection_limit_invalid");
  const image = run(["image", "inspect", process.env.MEET_TEST_PROXY_IMAGE || "webrtc-ci-local-webrtc:latest", "--format", "{{.Id}}"]);
  if (!/^sha256:[a-f0-9]{64}$/.test(image)) throw new Error("test_proxy_image_missing");
  const name = "meet-test-tls-" + randomUUID();
  const network = name + "-network";
  let networkCreated = false, containerAttempted = false, closed = false;
  let stun;
  function close() {
    if (closed) return;
    closed = true;
    try {
      if (containerAttempted) run(["rm", "--force", name]);
    } finally {
      try { stun?.close(); } finally { if (networkCreated) run(["network", "rm", network]); }
    }
  }
  try {
    run(["network", "create", "--internal", network]); networkCreated = true;
    const info = JSON.parse(run(["network", "inspect", network]))[0];
    const gateway = info?.IPAM?.Config?.[0]?.Gateway;
    // Docker allocates an unused private bridge; .2 belongs only to this new
    // network. Reject unfamiliar IPv6/small subnet layouts rather than guess.
    if (!info?.Internal || isIP(gateway) !== 4 || !/^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/.test(gateway)
      || !gateway.endsWith(".1") || !/\/(1[6-9]|2[0-9])$/.test(info.IPAM.Config[0].Subnet)) throw new Error("test_private_proxy_network_invalid");
    const originHost = gateway.slice(0, -1) + "2";
    stun = privateMachineStun({ network, address: gateway.slice(0, -1) + "4", lifetimeSeconds }, run);
    return {
      listenHost: gateway, originHost, network, stunUrl: stun.url, close,
      observation() {
        if (closed || !containerAttempted) return { connectionDrops: 0 };
        return { connectionDrops: run(["logs", name]).split("\n").filter(line => line === "test_tls_connection_capacity").slice(0, 8).length };
      },
      start(port) {
        if (closed || containerAttempted || !Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("test_proxy_start_invalid");
        const code = `const net=require('node:net');const server=net.createServer(s=>{const o=net.connect(${port},${JSON.stringify(gateway)});
          s.setTimeout(120000,()=>s.destroy());s.on('error',()=>o.destroy());o.on('error',()=>s.destroy());s.on('close',()=>o.destroy());o.on('close',()=>s.destroy());s.pipe(o);o.pipe(s)});
          let drops=0;server.on('drop',()=>{if(drops<8){drops++;console.log('test_tls_connection_capacity')}});
          server.maxConnections=${connectionLimit};server.listen(443,'0.0.0.0');setTimeout(()=>process.exit(0),${lifetimeSeconds * 1000})`;
        containerAttempted = true;
        run(["create", "--name", name, "--network", network, "--ip", originHost,
          "--user=0:0", "--read-only", "--cap-drop=ALL", "--cap-add=NET_BIND_SERVICE", "--security-opt=no-new-privileges",
          "--memory=128m", "--pids-limit=32", "--cpus=.5", "--entrypoint=node", image, "--max-old-space-size=32", "-e", code]);
        run(["start", name]);
        stun.start();
      },
    };
  } catch (error) {
    close(); throw error;
  }
}
