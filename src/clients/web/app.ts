import { AwacsClient } from "../sdk";

const awacs = new AwacsClient({ baseUrl: "" });
var collapsedPaths: Record<string, boolean> = {};
var allServices: any[] = [];

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
  awacs.kill([{ pid: s.pid, source: s.source, dockerName: s.dockerName, peerHost: s.peerHost }]);
}

function restartByIndex(idx) {
  var s = allServices[idx];
  if (!s) return;
  var label = s.source === "docker" ? s.dockerName : "PID " + s.pid;
  var where = s.peerHostname ? ' on "' + s.peerHostname + '" (' + s.peerHost + ')' : "";
  if (!confirm("Restart " + label + where + "?")) return;
  awacs.restart([{ pid: s.pid, source: s.source, dockerName: s.dockerName, args: s.args, cwd: s.cwd, peerHost: s.peerHost }]);
}

function killProject(indices) {
  var svcs = indices.map(function(i) { return allServices[i]; }).filter(Boolean);
  if (!svcs.length) return;
  var names = svcs.map(function(s) { return s.source === "docker" ? s.dockerName : "PID " + s.pid; }).join(", ");
  var where = svcs[0].peerHostname ? ' on "' + svcs[0].peerHostname + '" (' + svcs[0].peerHost + ')' : "";
  if (!confirm("Kill all" + where + ": " + names + "?")) return;
  awacs.kill(svcs.map(function(s) { return { pid: s.pid, source: s.source, dockerName: s.dockerName, peerHost: s.peerHost }; }));
}

function restartProject(indices) {
  var svcs = indices.map(function(i) { return allServices[i]; }).filter(Boolean);
  if (!svcs.length) return;
  var where = svcs[0].peerHostname ? ' on "' + svcs[0].peerHostname + '" (' + svcs[0].peerHost + ')' : "";
  if (!confirm("Restart all" + where + "?")) return;
  awacs.restart(svcs.map(function(s) { return { pid: s.pid, source: s.source, dockerName: s.dockerName, args: s.args, cwd: s.cwd, peerHost: s.peerHost }; }));
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
    .replace(/\/Users\/[^/]+/g, "~")
    .replace(/\/opt\/homebrew\/Cellar\/[^/]+\/[^/]+\/bin\//g, "");
}

function buildTree(services, indexMap) {
  var tree = {};

  for (var i = 0; i < services.length; i++) {
    var s = services[i];
    var realIndex = indexMap ? indexMap[i] : i;
    var path = s.cwd || "unknown";
    path = path.replace(/^\/Users\/[^/]+/, "~");
    path = path.replace(/^\/private/, "");

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

// Expose to onclick handlers in HTML
(window as any).killByIndex = killByIndex;
(window as any).restartByIndex = restartByIndex;
(window as any).killProject = killProject;
(window as any).restartProject = restartProject;

// Initial load, then switch to SSE for live updates
awacs.getServices().then(render);
awacs.subscribe(render);

// Hot reload in dev
const reloadSource = new EventSource("/api/reload");
reloadSource.onmessage = () => location.reload();
