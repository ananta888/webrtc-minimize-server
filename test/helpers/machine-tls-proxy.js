// Test-only opaque TLS forwarding on an owned internal network. Never bind a
// public/host port, change production origin policy or mount host credentials.
import { machineDockerCommand as docker } from "./machine-docker-command.js";
import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { privateMachineStun } from "./machine-stun-fixture.js";
import { privateMachineTurn } from "./machine-turn-fixture.js";
import { observeMachineProxyFailure } from "./machine-proxy-failure-observation.mjs";

export function privateMachineTlsProxy(lifetimeSeconds, run = docker, connectionLimit = 16, icePath = "direct", relayParticipants = 2,
  inspectFailure = observeMachineProxyFailure, engine = process.env.MEET_TEST_PROXY_ENGINE || "node") {
  if (!["node", "native-v1"].includes(engine)) throw new Error("test_proxy_engine_invalid");
  if (!["direct", "turn-udp", "turn-tcp"].includes(icePath)) throw new Error("test_ice_path_invalid");
  if (![2, 3].includes(relayParticipants)) throw new Error("test_turn_scope_invalid");
  if (!Number.isInteger(lifetimeSeconds) || lifetimeSeconds < 180 || lifetimeSeconds > 7380) throw new Error("test_lifetime_invalid");
  if (![16, 32].includes(connectionLimit)) throw new Error("test_proxy_connection_limit_invalid");
  const defaultImage = engine === "native-v1" ? "webrtc-test-tls-proxy:native-v1" : "webrtc-ci-local-webrtc:latest";
  const image = run(["image", "inspect", process.env.MEET_TEST_PROXY_IMAGE || defaultImage, "--format", "{{.Id}}"]);
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
    // Docker 28 permits --ip only in an explicitly configured subnet. Let Docker
    // select a free private pool first, then re-reserve exactly that pool. The
    // temporary network is still empty and owned by this fixture. A competing
    // allocation fails creation; never scan, retry with guessed IPs or relax ICE.
    const subnet = info.IPAM.Config[0].Subnet;
    run(["network", "rm", network]); networkCreated = false;
    run(["network", "create", "--internal", "--subnet", subnet, "--gateway", gateway, network]); networkCreated = true;
    const reserved = JSON.parse(run(["network", "inspect", network]))[0];
    if (!reserved?.Internal || reserved.IPAM?.Config?.length !== 1
      || reserved.IPAM.Config[0].Subnet !== subnet || reserved.IPAM.Config[0].Gateway !== gateway) {
      throw new Error("test_private_proxy_network_invalid");
    }
    const originHost = gateway.slice(0, -1) + "2";
    const iceScope = { network, address: gateway.slice(0, -1) + "4", lifetimeSeconds };
    stun = icePath === "direct" ? privateMachineStun(iceScope, run)
      : privateMachineTurn({ ...iceScope, transport: icePath.slice(5), participants: relayParticipants }, run);
    return {
      listenHost: gateway, originHost, network, stunUrl: stun.url, turnConfig: stun.config, close,
      observation() {
        if (closed || !containerAttempted) return { connectionDrops: 0 };
        return { connectionDrops: run(["logs", name]).split("\n").filter(line => line === "test_tls_connection_capacity").slice(0, 8).length };
      },
      failureObservation() { return closed || !containerAttempted ? null : inspectFailure(name); },
      start(port) {
        if (closed || containerAttempted || !Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("test_proxy_start_invalid");
        const code = `console.log('test_tls_process_entered');const net=require('node:net');console.log('test_tls_network_module_loaded');const server=net.createServer(s=>{const o=net.connect(${port},${JSON.stringify(gateway)});
          s.setTimeout(120000,()=>s.destroy());s.on('error',()=>o.destroy());o.on('error',()=>s.destroy());s.on('close',()=>o.destroy());o.on('close',()=>s.destroy());s.pipe(o);o.pipe(s)});
          let drops=0;server.on('drop',()=>{if(drops<8){drops++;console.log('test_tls_connection_capacity')}});
          server.once('listening',()=>console.log('test_tls_listener_ready'));
          server.maxConnections=${connectionLimit};server.listen(443,'0.0.0.0');setTimeout(()=>process.exit(0),${lifetimeSeconds * 1000})`;
        containerAttempted = true;
        const command = engine === "native-v1"
          ? ["--entrypoint=/usr/local/bin/machine-tls-proxy", image, gateway, String(port), String(connectionLimit), String(lifetimeSeconds)]
          : ["--entrypoint=node", image, "--max-old-space-size=32", "-e", code];
        run(["create", "--name", name, "--network", network, "--ip", originHost,
          "--user=0:0", "--read-only", "--cap-drop=ALL", "--cap-add=NET_BIND_SERVICE", "--security-opt=no-new-privileges",
          "--memory=128m", "--pids-limit=32", "--cpus=.5", ...command]);
        run(["start", name]);
        stun.start();
      },
    };
  } catch (error) {
    close(); throw error;
  }
}
