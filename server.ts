import { scan, killService, restartService } from "./scanner";

const PORT = 7777;

// --- SSE + PID watcher ---
let cachedServices: Awaited<ReturnType<typeof scan>> = [];
let trackedPids = new Set<number>();
const sseClients = new Set<ReadableStreamDefaultController>();

function broadcast(services: typeof cachedServices) {
  const data = JSON.stringify(services);
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
    broadcast(cachedServices);
  } catch (e) {
    console.error("Scan error:", e);
  }
  return cachedServices;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // doesn't kill — just checks existence
    return true;
  } catch {
    return false;
  }
}

// Fast liveness check every 1s — if any tracked PID died, trigger full rescan
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

// Periodic full rescan every 10s to pick up NEW processes
setInterval(async () => {
  try { await fullRescan(); } catch (e) { console.error("Rescan error:", e); }
}, 10000);

// Initial scan
fullRescan();

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
    // Use the current browser hostname so links work from LAN too
    var host = location.hostname;
    var bind = s.bindAddress;
    // If bound to localhost/127.0.0.1/::1, only link if viewing from localhost
    var isLocal = bind === "127.0.0.1" || bind === "[::1]" || bind === "localhost";
    if (isLocal && host !== "localhost" && host !== "127.0.0.1") {
      return ":" + s.port + ' <span style="color:#444">(local only)</span>';
    }
    var url = "http://" + host + ":" + s.port;
    return '<a href="' + url + '" target="_blank" style="color:#4fc3f7;text-decoration:none">:' + s.port + '</a>';
  }

  function killByIndex(idx) {
    var s = allServices[idx];
    if (!s) return;
    if (!confirm("Kill " + (s.source === "docker" ? s.dockerName : "PID " + s.pid) + "?")) return;
    apiAction("/api/kill", [{ pid: s.pid, source: s.source, dockerName: s.dockerName }]);
  }

  function restartByIndex(idx) {
    var s = allServices[idx];
    if (!s) return;
    apiAction("/api/restart", [{ pid: s.pid, source: s.source, dockerName: s.dockerName, args: s.args, cwd: s.cwd }]);
  }

  function killProject(indices) {
    var svcs = indices.map(function(i) { return allServices[i]; }).filter(Boolean);
    if (!svcs.length) return;
    var names = svcs.map(function(s) { return s.source === "docker" ? s.dockerName : "PID " + s.pid; }).join(", ");
    if (!confirm("Kill all: " + names + "?")) return;
    apiAction("/api/kill", svcs.map(function(s) { return { pid: s.pid, source: s.source, dockerName: s.dockerName }; }));
  }

  function restartProject(indices) {
    var svcs = indices.map(function(i) { return allServices[i]; }).filter(Boolean);
    if (!svcs.length) return;
    apiAction("/api/restart", svcs.map(function(s) { return { pid: s.pid, source: s.source, dockerName: s.dockerName, args: s.args, cwd: s.cwd }; }));
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

  function buildTree(services) {
    // Group services by path
    // For processes: use cwd, replace home dir with ~
    // For docker: use "Docker" as root
    var tree = {};

    for (var i = 0; i < services.length; i++) {
      var s = services[i];
      var path;
      path = s.cwd || "unknown";
      path = path.replace(/^\\/Users\\/[^/]+/, "~");
      // Strip /private prefix (macOS tmp dirs)
      path = path.replace(/^\\/private/, "");

      var parts = path.split("/").filter(function(p) { return p; });
      var node = tree;
      for (var j = 0; j < parts.length; j++) {
        var part = parts[j];
        if (!node[part]) node[part] = { _children: {}, _projects: {} };
        if (j === parts.length - 1) {
          // Group by project name under this folder, storing indices into allServices
          var proj = s.projectName || s.cwd.split("/").pop() || "unknown";
          if (!node[part]._projects[proj]) node[part]._projects[proj] = [];
          node[part]._projects[proj].push(i);
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
    for (var i = 0; i < services.length; i++) {
      if (services[i].source === "docker") dockerCount++;
      else processCount++;
    }

    stats.innerHTML =
      "Services: <span>" + services.length + "</span>" +
      "&nbsp;&nbsp;Processes: <span>" + processCount + "</span>" +
      "&nbsp;&nbsp;Containers: <span>" + dockerCount + "</span>";

    var rawTree = buildTree(services);
    var compacted = compactPath(
      // Wrap rawTree keys into node format for compactPath
      (function() {
        var wrapped = {};
        var keys = Object.keys(rawTree);
        for (var i = 0; i < keys.length; i++) {
          wrapped[keys[i]] = rawTree[keys[i]];
        }
        return wrapped;
      })()
    );

    var html = "";
    var topKeys = Object.keys(compacted).sort();
    for (var i = 0; i < topKeys.length; i++) {
      html += renderFolder(topKeys[i], compacted[topKeys[i]], "");
    }

    treeEl.innerHTML = html;

    // Attach click handlers to folder and project names
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
      return Response.json(cachedServices);
    }

    if (url.pathname === "/api/events") {
      const stream = new ReadableStream({
        start(controller) {
          sseClients.add(controller);
          // Send current state immediately
          controller.enqueue(`data: ${JSON.stringify(cachedServices)}\n\n`);
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

    if (url.pathname === "/api/kill" && req.method === "POST") {
      try {
        const body = await req.json();
        const targets = body.services || [body];
        const results: string[] = [];
        for (const svc of targets) {
          results.push(await killService(svc));
        }
        // PID watcher will detect the death and rescan, but also force one now
        setTimeout(() => fullRescan(), 500);
        return Response.json({ ok: true, results });
      } catch (e: any) {
        return Response.json({ ok: false, error: e.message }, { status: 500 });
      }
    }

    if (url.pathname === "/api/restart" && req.method === "POST") {
      try {
        const body = await req.json();
        const targets = body.services || [body];
        const results: string[] = [];
        for (const svc of targets) {
          results.push(await restartService(svc));
        }
        setTimeout(() => fullRescan(), 1500); // give process time to respawn
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
