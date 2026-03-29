import { scan, killService, restartService } from "./scanner";
import type { Service } from "./scanner";
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

const HTML = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>AWACS</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: ui-monospace, "SF Mono", Menlo, monospace; background: #0a0a0a; color: #e0e0e0; padding: 24px; }
  h1 { font-size: 14px; font-weight: 600; letter-spacing: 2px; text-transform: uppercase; color: #888; margin-bottom: 4px; }
  .subtitle { font-size: 11px; color: #555; margin-bottom: 24px; }
  .stats { display: flex; gap: 24px; margin-bottom: 24px; font-size: 12px; color: #888; }
  .stats span { color: #e0e0e0; font-weight: 600; }

  .tree { font-size: 12px; line-height: 1; }

  .folder { cursor: pointer; user-select: none; }
  .project { border-radius: 4px; }
  .project:hover { background: #111; }
  .folder-name { color: #ffb74d; padding: 6px 8px; display: flex; align-items: center; gap: 6px; }
  .folder-name .arrow { color: #555; font-size: 10px; display: inline-block; width: 12px; transition: transform 0.1s; }
  .folder-name .arrow.collapsed { transform: rotate(-90deg); }
  .folder-name .count { color: #555; font-size: 10px; margin-left: 4px; }
  .project-name { color: #4fc3f7; padding: 5px 8px; display: flex; align-items: center; gap: 6px; font-size: 11px; font-weight: 600; }
  .project-name .arrow { color: #555; font-size: 10px; display: inline-block; width: 12px; transition: transform 0.1s; }
  .project-name .arrow.collapsed { transform: rotate(-90deg); }
  .project-name .count { color: #555; font-size: 10px; font-weight: 400; margin-left: 4px; }
  .project-children { padding-left: 20px; }
  .project-children.hidden { display: none; }
  .folder-children { padding-left: 20px; }
  .folder-children.hidden { display: none; }

  .service { display: flex; align-items: baseline; gap: 12px; padding: 4px 8px 4px 8px; border-bottom: 1px solid #111; border-radius: 2px; }
  .service:hover { background: #1a1a1a; }
  .port { color: #4fc3f7; font-weight: 600; min-width: 50px; }
  .badge { display: inline-block; padding: 1px 6px; border-radius: 3px; font-size: 10px; font-weight: 500; min-width: 55px; text-align: center; }
  .badge-docker { background: #2d1b4e; color: #bb86fc; }
  .badge-process { background: #1b2e1b; color: #81c784; }
  .args { color: #888; font-size: 11px; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .resource { color: #555; font-size: 11px; min-width: 55px; text-align: right; }
  .pid { color: #444; font-size: 11px; min-width: 50px; text-align: right; }

  .actions { display: flex; gap: 4px; margin-left: auto; visibility: hidden; }
  .service:hover .actions { visibility: visible; }
  .btn { background: none; border: 1px solid #333; color: #888; font-family: inherit; font-size: 10px; padding: 2px 8px; border-radius: 3px; cursor: pointer; }
  .btn:hover { border-color: #555; color: #ccc; }
  .btn-kill { border-color: #442222; color: #cc6666; }
  .btn-kill:hover { border-color: #cc6666; color: #ff8888; background: #1a0000; }
  .btn-restart { border-color: #224422; color: #66cc66; }
  .btn-restart:hover { border-color: #66cc66; color: #88ff88; background: #001a00; }
  .project-actions { display: inline-flex; gap: 4px; margin-left: auto; visibility: hidden; }
  .project:hover > .project-name > .project-actions { visibility: visible; }

  .host-group { margin-bottom: 24px; }
  .host-header { font-size: 12px; font-weight: 600; padding: 8px; border-bottom: 1px solid #222; margin-bottom: 4px; display: flex; align-items: center; gap: 8px; }
  .host-header .host-ip { color: #555; font-weight: 400; }
  .host-header.local { color: #4fc3f7; }
  .host-header.remote { color: #ffb74d; }
  .peer-badge { font-size: 9px; padding: 1px 6px; border-radius: 3px; background: #1b2e1b; color: #81c784; text-transform: uppercase; letter-spacing: 1px; }
  .peer-badge.local { background: #1b2e3e; color: #4fc3f7; }

  .refresh-info { font-size: 11px; color: #333; margin-top: 16px; }
</style>
</head>
<body>
  <h1>AWACS</h1>
  <div class="stats" id="stats"></div>
  <div class="tree" id="tree"></div>
  <div class="refresh-info" id="refresh-info"></div>

<script>
  var collapsedPaths = {};
  var allServices = [];

  function apiAction(endpoint, services) {
    fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ services: services })
    });
  }

  function portLink(s) {
    var host = s.peerHost || location.hostname;
    var bind = s.bindAddress;
    var isLocal = bind === "127.0.0.1" || bind === "[::1]" || bind === "localhost";
    if (isLocal) {
      if (s.peerHost) {
        return ":" + s.port + ' <span style="color:#444">(remote localhost)</span>';
      }
      if (host !== "localhost" && host !== "127.0.0.1") {
        return ":" + s.port + ' <span style="color:#444">(local only)</span>';
      }
    }
    var url = "http://" + host + ":" + s.port;
    return '<a href="' + url + '" target="_blank" style="color:#4fc3f7;text-decoration:none">:' + s.port + '</a>';
  }

  function killByIndex(idx) {
    var s = allServices[idx];
    if (!s) return;
    var label = s.source === "docker" ? s.dockerName : "PID " + s.pid;
    var where = s.peerHostname ? ' on "' + s.peerHostname + '" (' + s.peerHost + ')' : "";
    if (!confirm("Kill " + label + where + "?")) return;
    apiAction("/api/kill", [{ pid: s.pid, source: s.source, dockerName: s.dockerName, peerHost: s.peerHost }]);
  }

  function restartByIndex(idx) {
    var s = allServices[idx];
    if (!s) return;
    var label = s.source === "docker" ? s.dockerName : "PID " + s.pid;
    var where = s.peerHostname ? ' on "' + s.peerHostname + '" (' + s.peerHost + ')' : "";
    if (!confirm("Restart " + label + where + "?")) return;
    apiAction("/api/restart", [{ pid: s.pid, source: s.source, dockerName: s.dockerName, args: s.args, cwd: s.cwd, peerHost: s.peerHost }]);
  }

  function killProject(indices) {
    var svcs = indices.map(function(i) { return allServices[i]; }).filter(Boolean);
    if (!svcs.length) return;
    var names = svcs.map(function(s) { return s.source === "docker" ? s.dockerName : "PID " + s.pid; }).join(", ");
    var where = svcs[0].peerHostname ? ' on "' + svcs[0].peerHostname + '" (' + svcs[0].peerHost + ')' : "";
    if (!confirm("Kill all" + where + ": " + names + "?")) return;
    apiAction("/api/kill", svcs.map(function(s) { return { pid: s.pid, source: s.source, dockerName: s.dockerName, peerHost: s.peerHost }; }));
  }

  function restartProject(indices) {
    var svcs = indices.map(function(i) { return allServices[i]; }).filter(Boolean);
    if (!svcs.length) return;
    var where = svcs[0].peerHostname ? ' on "' + svcs[0].peerHostname + '" (' + svcs[0].peerHost + ')' : "";
    if (!confirm("Restart all" + where + "?")) return;
    apiAction("/api/restart", svcs.map(function(s) { return { pid: s.pid, source: s.source, dockerName: s.dockerName, args: s.args, cwd: s.cwd, peerHost: s.peerHost }; }));
  }

  function escapeHtml(s) {
    var d = document.createElement("div");
    d.textContent = s;
    return d.innerHTML;
  }

  function formatRss(kb) {
    if (kb > 1048576) return (kb / 1048576).toFixed(1) + " GB";
    if (kb > 1024) return (kb / 1024).toFixed(0) + " MB";
    return kb + " KB";
  }

  function shortenArgs(args) {
    return args
      .replace(/\\/Users\\/[^/]+/g, "~")
      .replace(/\\/opt\\/homebrew\\/Cellar\\/[^/]+\\/[^/]+\\/bin\\//g, "");
  }

  function buildTree(services, indexMap) {
    var tree = {};

    for (var i = 0; i < services.length; i++) {
      var s = services[i];
      var realIndex = indexMap ? indexMap[i] : i;
      var path = s.cwd || "unknown";
      path = path.replace(/^\\/Users\\/[^/]+/, "~");
      path = path.replace(/^\\/private/, "");

      var parts = path.split("/").filter(function(p) { return p; });
      var node = tree;
      for (var j = 0; j < parts.length; j++) {
        var part = parts[j];
        if (!node[part]) node[part] = { _children: {}, _projects: {} };
        if (j === parts.length - 1) {
          var proj = s.projectName || s.cwd.split("/").pop() || "unknown";
          if (!node[part]._projects[proj]) node[part]._projects[proj] = [];
          node[part]._projects[proj].push(realIndex);
        }
        node = node[part]._children;
      }
    }

    return tree;
  }

  function collectIndices(node) {
    var indices = [];
    var projects = node._projects || {};
    var projKeys = Object.keys(projects);
    for (var i = 0; i < projKeys.length; i++) {
      indices = indices.concat(projects[projKeys[i]]);
    }
    var children = node._children || {};
    var keys = Object.keys(children);
    for (var i = 0; i < keys.length; i++) {
      indices = indices.concat(collectIndices(children[keys[i]]));
    }
    return indices;
  }

  function countServices(node) {
    var count = 0;
    var projects = node._projects || {};
    var projKeys = Object.keys(projects);
    for (var i = 0; i < projKeys.length; i++) {
      count += projects[projKeys[i]].length;
    }
    var children = node._children || {};
    var keys = Object.keys(children);
    for (var i = 0; i < keys.length; i++) {
      count += countServices(children[keys[i]]);
    }
    return count;
  }

  function hasProjects(node) {
    return Object.keys(node._projects || {}).length > 0;
  }

  // Collapse single-child intermediate folders: a/b/c with no projects at a or b becomes "a/b/c"
  function compactPath(children) {
    var keys = Object.keys(children);
    var result = {};
    for (var i = 0; i < keys.length; i++) {
      var key = keys[i];
      var node = children[keys[i]];
      var label = key;
      // Keep collapsing while: only one child folder, and current node has no projects
      while (true) {
        var childKeys = Object.keys(node._children);
        if (!hasProjects(node) && childKeys.length === 1) {
          label = label + "/" + childKeys[0];
          node = node._children[childKeys[0]];
        } else {
          break;
        }
      }
      // Recurse into remaining children
      node._children = compactPath(node._children);
      result[label] = node;
    }
    return result;
  }

  function renderService(s, idx) {
    var isDocker = s.source === "docker";
    var badgeClass = isDocker ? "badge-docker" : "badge-process";
    var badgeText = isDocker ? "docker" : escapeHtml(s.command);
    var argsText = isDocker
      ? escapeHtml(s.dockerImage || "")
      : escapeHtml(shortenArgs(s.args));
    var resText = isDocker
      ? escapeHtml(s.dockerStatus || "")
      : s.cpu.toFixed(1) + "% &middot; " + formatRss(s.rss);
    var pidText = s.pid ? s.pid : "";

    return '<div class="service">' +
      '<span class="port">' + (s.port ? portLink(s) : '—') + '</span>' +
      '<span class="badge ' + badgeClass + '">' + badgeText + '</span>' +
      '<span class="args" title="' + escapeHtml(s.args) + '">' + argsText + '</span>' +
      '<span class="resource">' + resText + '</span>' +
      '<span class="pid">' + pidText + '</span>' +
      '<span class="actions">' +
        '<button class="btn btn-restart" onclick="restartByIndex(' + idx + ')">restart</button>' +
        '<button class="btn btn-kill" onclick="killByIndex(' + idx + ')">kill</button>' +
      '</span>' +
      '</div>';
  }

  function renderFolder(name, node, pathSoFar) {
    var fullPath = pathSoFar ? pathSoFar + "/" + name : name;
    var isCollapsed = collapsedPaths[fullPath] || false;
    var count = countServices(node);
    var arrowClass = "arrow" + (isCollapsed ? " collapsed" : "");
    var childrenClass = "folder-children" + (isCollapsed ? " hidden" : "");

    var html = '<div class="folder">';
    html += '<div class="folder-name" data-path="' + escapeHtml(fullPath) + '">';
    html += '<span class="' + arrowClass + '">&#9660;</span>';
    html += escapeHtml(name);
    html += '<span class="count">(' + count + ')</span>';
    html += '</div>';
    html += '<div class="' + childrenClass + '">';

    // Render projects at this level, each containing their services
    var projKeys = Object.keys(node._projects || {}).sort();
    for (var i = 0; i < projKeys.length; i++) {
      var projName = projKeys[i];
      var projIndices = node._projects[projName];
      var projPath = fullPath + "/_proj_" + projName;
      var projCollapsed = collapsedPaths[projPath] || false;
      var projArrowClass = "arrow" + (projCollapsed ? " collapsed" : "");
      var projChildrenClass = "project-children" + (projCollapsed ? " hidden" : "");

      html += '<div class="project">';
      html += '<div class="project-name" data-path="' + escapeHtml(projPath) + '">';
      html += '<span class="' + projArrowClass + '">&#9660;</span>';
      html += escapeHtml(projName);
      html += '<span class="count">(' + projIndices.length + ')</span>';
      html += '<span class="project-actions">';
      html += '<button class="btn btn-restart" onclick="event.stopPropagation(); restartProject([' + projIndices.join(',') + '])">restart all</button>';
      html += '<button class="btn btn-kill" onclick="event.stopPropagation(); killProject([' + projIndices.join(',') + '])">kill all</button>';
      html += '</span>';
      html += '</div>';
      html += '<div class="' + projChildrenClass + '">';
      for (var k = 0; k < projIndices.length; k++) {
        html += renderService(allServices[projIndices[k]], projIndices[k]);
      }
      html += '</div></div>';
    }

    // Render child folders
    var childKeys = Object.keys(node._children).sort();
    for (var j = 0; j < childKeys.length; j++) {
      html += renderFolder(childKeys[j], node._children[childKeys[j]], fullPath);
    }

    html += '</div></div>';
    return html;
  }

  function render(services) {
    allServices = services;
    var stats = document.getElementById("stats");
    var treeEl = document.getElementById("tree");
    var info = document.getElementById("refresh-info");

    var processCount = 0;
    var dockerCount = 0;
    var peerHosts = {};
    for (var i = 0; i < services.length; i++) {
      if (services[i].source === "docker") dockerCount++;
      else processCount++;
      if (services[i].peerHost) peerHosts[services[i].peerHost] = true;
    }
    var peerCount = Object.keys(peerHosts).length;

    stats.innerHTML =
      "Services: <span>" + services.length + "</span>" +
      "&nbsp;&nbsp;Processes: <span>" + processCount + "</span>" +
      "&nbsp;&nbsp;Containers: <span>" + dockerCount + "</span>" +
      (peerCount > 0 ? "&nbsp;&nbsp;Peers: <span>" + peerCount + "</span>" : "");

    // Group services by host
    var groups = {};
    var hostnames = {};
    for (var i = 0; i < services.length; i++) {
      var s = services[i];
      var gKey = s.peerHost || "__local__";
      if (!groups[gKey]) groups[gKey] = [];
      groups[gKey].push(i);
      if (s.peerHost && s.peerHostname) hostnames[s.peerHost] = s.peerHostname;
    }

    var html = "";
    var groupKeys = Object.keys(groups).sort(function(a, b) {
      if (a === "__local__") return -1;
      if (b === "__local__") return 1;
      return (hostnames[a] || a).localeCompare(hostnames[b] || b);
    });

    for (var g = 0; g < groupKeys.length; g++) {
      var gKey = groupKeys[g];
      var isLocal = gKey === "__local__";
      var indices = groups[gKey];
      var groupServices = indices.map(function(i) { return allServices[i]; });

      html += '<div class="host-group">';
      if (groupKeys.length > 1 || !isLocal) {
        html += '<div class="host-header ' + (isLocal ? 'local' : 'remote') + '">';
        html += '<span class="peer-badge ' + (isLocal ? 'local' : '') + '">' + (isLocal ? 'local' : 'remote') + '</span>';
        if (isLocal) {
          html += 'This machine';
        } else {
          html += escapeHtml(hostnames[gKey] || gKey) + ' <span class="host-ip">&middot; ' + escapeHtml(gKey) + '</span>';
        }
        html += ' <span class="count">(' + indices.length + ')</span>';
        html += '</div>';
      }

      var rawTree = buildTree(groupServices, indices);
      var compacted = compactPath(rawTree);

      var topKeys = Object.keys(compacted).sort();
      for (var i = 0; i < topKeys.length; i++) {
        html += renderFolder(topKeys[i], compacted[topKeys[i]], gKey);
      }
      html += '</div>';
    }

    treeEl.innerHTML = html;

    var clickables = treeEl.querySelectorAll(".folder-name, .project-name");
    for (var i = 0; i < clickables.length; i++) {
      clickables[i].addEventListener("click", function(e) {
        var target = e.currentTarget;
        var path = target.getAttribute("data-path");
        collapsedPaths[path] = !collapsedPaths[path];
        var children = target.nextElementSibling;
        if (children) children.classList.toggle("hidden");
        var arrow = target.querySelector(".arrow");
        if (arrow) arrow.classList.toggle("collapsed");
      });
    }

    info.textContent = "Last updated: " + new Date().toLocaleTimeString();
  }

  // Initial load, then switch to SSE for live updates
  fetch("/api/services")
    .then(function (r) { return r.json(); })
    .then(render);

  var evtSource = new EventSource("/api/events");
  evtSource.onmessage = function(e) {
    try { render(JSON.parse(e.data)); } catch(err) {}
  };
</script>
</body>
</html>`;

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

    return new Response(HTML, {
      headers: { "Content-Type": "text/html" },
    });
  },
});

console.log(`AWACS running → http://localhost:${PORT}`);
if (peers.size > 0) {
  console.log(`Manual peers: ${[...peers.values()].map((p) => `${p.host}:${p.port}`).join(", ")}`);
}
