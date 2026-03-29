import { scan, killService, restartService } from "./scanner";
import type { Service } from "./types";
import dgram from "dgram";
import os from "os";
import { parseArgs } from "util";

const PORT = 7777;
const DISCOVERY_PORT = 7778;
const HEARTBEAT_INTERVAL = 5000;
const PEER_TIMEOUT = 15000;
const PEER_POLL_INTERVAL = 10000;

// --- CLI ---
const { values: cliArgs } = parseArgs({
  args: Bun.argv.slice(2),
  options: { peers: { type: "string" } },
  strict: false,
});

// --- Peer types & state ---
interface Peer {
  host: string;
  port: number;
  hostname: string;
  services: Service[];
  lastSeen: number;
  manual: boolean;
}

const peers = new Map<string, Peer>();

// Initialize manual peers
if (cliArgs.peers) {
  for (const entry of (cliArgs.peers as string).split(",")) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const lastColon = trimmed.lastIndexOf(":");
    const hasPort = lastColon > 0 && !isNaN(parseInt(trimmed.substring(lastColon + 1)));
    const host = hasPort ? trimmed.substring(0, lastColon) : trimmed;
    const port = hasPort ? parseInt(trimmed.substring(lastColon + 1)) : PORT;
    const key = `${host}:${port}`;
    peers.set(key, { host, port, hostname: host, services: [], lastSeen: 0, manual: true });
  }
}

// --- Local identity ---
function getLocalAddresses(): Set<string> {
  const addrs = new Set<string>(["127.0.0.1", "::1", "localhost"]);
  const nets = os.networkInterfaces();
  for (const name in nets) {
    for (const net of nets[name]!) {
      addrs.add(net.address);
    }
  }
  return addrs;
}

const localAddresses = getLocalAddresses();
const localHostname = os.hostname();

// --- SSE + PID watcher ---
let cachedServices: Awaited<ReturnType<typeof scan>> = [];
let trackedPids = new Set<number>();
const sseClients = new Set<ReadableStreamDefaultController>();

function getAllServices(): Service[] {
  const all: Service[] = [...cachedServices];
  for (const [, peer] of peers) {
    all.push(...peer.services);
  }
  return all;
}

function broadcastAll() {
  const data = JSON.stringify(getAllServices());
  for (const controller of sseClients) {
    try {
      controller.enqueue(`data: ${data}\n\n`);
    } catch {
      sseClients.delete(controller);
    }
  }
}

async function fullRescan() {
  try {
    cachedServices = await scan();
    trackedPids = new Set(
      cachedServices.filter((s) => s.pid > 0).map((s) => s.pid)
    );
    broadcastAll();
  } catch (e) {
    console.error("Scan error:", e);
  }
  return cachedServices;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Fast liveness check every 1s
setInterval(async () => {
  try {
    if (trackedPids.size === 0) return;
    for (const pid of trackedPids) {
      if (!pidAlive(pid)) {
        await fullRescan();
        return;
      }
    }
  } catch (e) {
    console.error("PID watcher error:", e);
  }
}, 1000);

// Periodic full rescan every 10s
setInterval(async () => {
  try { await fullRescan(); } catch (e) { console.error("Rescan error:", e); }
}, 10000);

// Initial scan
fullRescan();

// --- UDP Discovery ---
const udpSocket = dgram.createSocket({ type: "udp4", reuseAddr: true });

udpSocket.on("message", (msg, rinfo) => {
  try {
    const data = JSON.parse(msg.toString());
    const senderHost = rinfo.address;
    const senderPort = data.port ?? PORT;

    // Ignore own broadcasts
    if (localAddresses.has(senderHost) && senderPort === PORT) return;

    const key = `${senderHost}:${senderPort}`;
    const existing = peers.get(key);
    if (existing) {
      existing.lastSeen = Date.now();
      existing.hostname = data.hostname || senderHost;
    } else {
      peers.set(key, {
        host: senderHost,
        port: senderPort,
        hostname: data.hostname || senderHost,
        services: [],
        lastSeen: Date.now(),
        manual: false,
      });
    }
  } catch {}
});

udpSocket.bind(DISCOVERY_PORT, () => {
  udpSocket.setBroadcast(true);
  console.log(`AWACS discovery on UDP :${DISCOVERY_PORT}`);
});

// Heartbeat every 5s
setInterval(() => {
  const buf = Buffer.from(JSON.stringify({ port: PORT, hostname: localHostname }));
  try {
    udpSocket.send(buf, 0, buf.length, DISCOVERY_PORT, "255.255.255.255");
  } catch (e) {
    console.error("Heartbeat error:", e);
  }
}, HEARTBEAT_INTERVAL);

// Prune stale discovered peers every 5s
setInterval(() => {
  const now = Date.now();
  for (const [key, peer] of peers) {
    if (!peer.manual && now - peer.lastSeen > PEER_TIMEOUT) {
      peers.delete(key);
      broadcastAll();
    }
  }
}, HEARTBEAT_INTERVAL);

// --- Peer polling ---
async function pollPeerServices() {
  for (const [, peer] of peers) {
    try {
      const resp = await fetch(`http://${peer.host}:${peer.port}/api/services?local=1`, {
        signal: AbortSignal.timeout(5000),
      });
      if (resp.ok) {
        const remoteSvcs: Service[] = await resp.json();
        peer.services = remoteSvcs.map((s) => ({
          ...s,
          peerHost: peer.host,
          peerHostname: peer.hostname,
        }));
        if (peer.manual) peer.lastSeen = Date.now();
      }
    } catch {
      if (peer.manual) peer.services = [];
    }
  }
  broadcastAll();
}

setInterval(pollPeerServices, PEER_POLL_INTERVAL);
setTimeout(pollPeerServices, 3000);

const webDir = import.meta.dir + "/clients/web";

// --- Web client bundler + hot reload ---
let bundledJs: string | null = null;

async function bundleWebClient() {
  const result = await Bun.build({
    entrypoints: [`${webDir}/app.ts`],
    target: "browser",
    minify: false,
  });
  if (result.success) {
    bundledJs = await result.outputs[0].text();
  } else {
    console.error("Bundle error:", result.logs);
  }
}

await bundleWebClient();

const reloadClients = new Set<ReadableStreamDefaultController>();
import { watch } from "fs";

watch(webDir, { recursive: true }, async (_event, filename) => {
  if (filename?.endsWith(".ts")) {
    await bundleWebClient();
  }
  for (const controller of reloadClients) {
    try {
      controller.enqueue(`data: reload\n\n`);
    } catch {
      reloadClients.delete(controller);
    }
  }
});

// Also watch sdk.ts since web client imports it
watch(import.meta.dir + "/clients/sdk.ts", async () => {
  await bundleWebClient();
  for (const controller of reloadClients) {
    try {
      controller.enqueue(`data: reload\n\n`);
    } catch {
      reloadClients.delete(controller);
    }
  }
});

const server = Bun.serve({
  hostname: "0.0.0.0",
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/api/services") {
      const localOnly = url.searchParams.has("local");
      return Response.json(localOnly ? cachedServices : getAllServices());
    }

    if (url.pathname === "/api/events") {
      const stream = new ReadableStream({
        start(controller) {
          sseClients.add(controller);
          controller.enqueue(`data: ${JSON.stringify(getAllServices())}\n\n`);
        },
        cancel(controller) {
          sseClients.delete(controller);
        },
      });
      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
      });
    }

    if ((url.pathname === "/api/kill" || url.pathname === "/api/restart") && req.method === "POST") {
      const isKill = url.pathname === "/api/kill";
      try {
        const body = await req.json();
        const targets = body.services || [body];
        const results: string[] = [];

        // Separate local vs remote targets
        const localTargets: any[] = [];
        const remoteGroups = new Map<string, any[]>();

        for (const svc of targets) {
          if (svc.peerHost) {
            const peer = [...peers.values()].find((p) => p.host === svc.peerHost);
            const peerPort = peer?.port ?? PORT;
            const key = `${svc.peerHost}:${peerPort}`;
            if (!remoteGroups.has(key)) remoteGroups.set(key, []);
            remoteGroups.get(key)!.push(svc);
          } else {
            localTargets.push(svc);
          }
        }

        // Execute local actions
        for (const svc of localTargets) {
          results.push(await (isKill ? killService(svc) : restartService(svc)));
        }

        // Proxy remote actions
        for (const [key, svcs] of remoteGroups) {
          const lastColon = key.lastIndexOf(":");
          const host = key.substring(0, lastColon);
          const port = key.substring(lastColon + 1);
          try {
            const resp = await fetch(`http://${host}:${port}${url.pathname}`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ services: svcs.map(({ peerHost, peerHostname, ...rest }: any) => rest) }),
              signal: AbortSignal.timeout(5000),
            });
            const data: any = await resp.json();
            results.push(...(data.results || [`Forwarded to ${host}`]));
          } catch (e: any) {
            results.push(`Failed to reach ${host}: ${e.message}`);
          }
        }

        setTimeout(() => fullRescan(), isKill ? 500 : 1500);
        return Response.json({ ok: true, results });
      } catch (e: any) {
        return Response.json({ ok: false, error: e.message }, { status: 500 });
      }
    }

    if (url.pathname === "/api/reload") {
      const stream = new ReadableStream({
        start(controller) {
          reloadClients.add(controller);
        },
        cancel(controller) {
          reloadClients.delete(controller);
        },
      });
      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
      });
    }

    // Serve bundled JS
    if (url.pathname === "/app.js") {
      return new Response(bundledJs ?? "", {
        headers: { "Content-Type": "application/javascript" },
      });
    }

    // Serve static web files (html, css)
    const filePath = url.pathname === "/" ? "/index.html" : url.pathname;
    const file = Bun.file(webDir + filePath);
    if (await file.exists()) {
      return new Response(file);
    }
    return new Response("Not found", { status: 404 });
  },
});

console.log(`AWACS running → http://localhost:${PORT}`);
if (peers.size > 0) {
  console.log(`Manual peers: ${[...peers.values()].map((p) => `${p.host}:${p.port}`).join(", ")}`);
}
