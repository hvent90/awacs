import { AwacsClient } from "../sdk";
import { buildView, getStats, formatRss, shortenArgs } from "../view";
import type { Row } from "../view";
import type { Service } from "../../types";

const awacs = new AwacsClient({ baseUrl: "" });
var collapsedPaths: Record<string, boolean> = {};
var allServices: Service[] = [];

function portLink(s: Service) {
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

function escapeHtml(s: string) {
  var d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

function killTargets(services: Service[]) {
  var names = services.map(s => s.source === "docker" ? s.dockerName : "PID " + s.pid).join(", ");
  var where = services[0].peerHostname ? ' on "' + services[0].peerHostname + '" (' + services[0].peerHost + ')' : "";
  if (!confirm("Kill " + names + where + "?")) return;
  awacs.kill(services.map(s => ({ pid: s.pid, source: s.source, dockerName: s.dockerName, peerHost: s.peerHost })));
}

function restartTargets(services: Service[]) {
  var names = services.map(s => s.source === "docker" ? s.dockerName : "PID " + s.pid).join(", ");
  var where = services[0].peerHostname ? ' on "' + services[0].peerHostname + '" (' + services[0].peerHost + ')' : "";
  if (!confirm("Restart " + names + where + "?")) return;
  awacs.restart(services.map(s => ({ pid: s.pid, source: s.source, dockerName: s.dockerName, args: s.args, cwd: s.cwd, peerHost: s.peerHost })));
}

// Expose action handlers for onclick attributes
(window as any)._kill = function(indices: number[]) {
  killTargets(indices.map(i => allServices[i]).filter(Boolean));
};
(window as any)._restart = function(indices: number[]) {
  restartTargets(indices.map(i => allServices[i]).filter(Boolean));
};

function renderRow(row: Row): string {
  if (row.type === "host") {
    var badgeClass = row.isLocal ? "local" : "";
    var badgeText = row.isLocal ? "local" : "remote";
    var headerClass = row.isLocal ? "local" : "remote";
    var label = row.isLocal ? "This machine" : escapeHtml(row.label);
    var ip = row.ip ? ' <span class="host-ip">&middot; ' + escapeHtml(row.ip) + '</span>' : "";
    return '<div class="host-group"><div class="host-header ' + headerClass + '">' +
      '<span class="peer-badge ' + badgeClass + '">' + badgeText + '</span>' +
      label + ip + ' <span class="count">(' + row.count + ')</span></div></div>';
  }

  if (row.type === "folder") {
    var isCollapsed = collapsedPaths[row.path] || false;
    var arrowClass = "arrow" + (isCollapsed ? " collapsed" : "");
    return '<div class="folder" style="padding-left:' + (row.depth * 20) + 'px">' +
      '<div class="folder-name" data-path="' + escapeHtml(row.path) + '">' +
      '<span class="' + arrowClass + '">&#9660;</span>' +
      escapeHtml(row.label) +
      '<span class="count">(' + row.count + ')</span>' +
      '</div></div>';
  }

  if (row.type === "project") {
    var isCollapsed = collapsedPaths[row.path] || false;
    var arrowClass = "arrow" + (isCollapsed ? " collapsed" : "");
    return '<div class="project" style="padding-left:' + (row.depth * 20) + 'px">' +
      '<div class="project-name" data-path="' + escapeHtml(row.path) + '">' +
      '<span class="' + arrowClass + '">&#9660;</span>' +
      escapeHtml(row.label) +
      '<span class="count">(' + row.count + ')</span>' +
      '<span class="project-actions">' +
      '<button class="btn btn-restart" onclick="event.stopPropagation(); _restart([' + row.indices.join(',') + '])">restart all</button>' +
      '<button class="btn btn-kill" onclick="event.stopPropagation(); _kill([' + row.indices.join(',') + '])">kill all</button>' +
      '</span></div></div>';
  }

  // service
  var s = row.service;
  var isDocker = s.source === "docker";
  var badgeClass = isDocker ? "badge-docker" : "badge-process";
  var badgeText = isDocker ? "docker" : escapeHtml(s.command);
  var argsText = isDocker ? escapeHtml(s.dockerImage || "") : escapeHtml(shortenArgs(s.args));
  var resText = isDocker ? escapeHtml(s.dockerStatus || "") : s.cpu.toFixed(1) + "% &middot; " + formatRss(s.rss);
  var pidText = s.pid ? s.pid : "";

  return '<div class="service" style="padding-left:' + (row.depth * 20) + 'px">' +
    '<span class="port">' + (s.port ? portLink(s) : '—') + '</span>' +
    '<span class="badge ' + badgeClass + '">' + badgeText + '</span>' +
    '<span class="args" title="' + escapeHtml(s.args) + '">' + argsText + '</span>' +
    '<span class="resource">' + resText + '</span>' +
    '<span class="pid">' + pidText + '</span>' +
    '<span class="actions">' +
      '<button class="btn btn-restart" onclick="_restart([' + row.index + '])">restart</button>' +
      '<button class="btn btn-kill" onclick="_kill([' + row.index + '])">kill</button>' +
    '</span></div>';
}

function render(services: Service[]) {
  allServices = services;
  var statsEl = document.getElementById("stats")!;
  var treeEl = document.getElementById("tree")!;
  var info = document.getElementById("refresh-info")!;

  var stats = getStats(services);
  statsEl.innerHTML =
    "Services: <span>" + stats.total + "</span>" +
    "&nbsp;&nbsp;Processes: <span>" + stats.processes + "</span>" +
    "&nbsp;&nbsp;Containers: <span>" + stats.containers + "</span>" +
    (stats.peers > 0 ? "&nbsp;&nbsp;Peers: <span>" + stats.peers + "</span>" : "");

  var rows = buildView(services, collapsedPaths);
  treeEl.innerHTML = rows.map(renderRow).join("");

  // Attach collapse/expand handlers
  var clickables = treeEl.querySelectorAll(".folder-name, .project-name");
  for (var i = 0; i < clickables.length; i++) {
    clickables[i].addEventListener("click", function(e: Event) {
      var target = e.currentTarget as HTMLElement;
      var path = target.getAttribute("data-path")!;
      collapsedPaths[path] = !collapsedPaths[path];
      render(allServices);
    });
  }

  info.textContent = "Last updated: " + new Date().toLocaleTimeString();
}

// Initial load, then switch to SSE for live updates
awacs.getServices().then(render);
awacs.subscribe(render);

// Hot reload in dev
const reloadSource = new EventSource("/api/reload");
reloadSource.onmessage = () => location.reload();
