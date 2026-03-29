// awacs TUI — interactive terminal dashboard
// Run: bun src/clients/cli/tui.ts [--host url] [--local]

import { AwacsClient } from "../sdk";
import { buildView, getStats, formatRss, shortenArgs } from "../view";
import type { Row } from "../view";
import type { Service } from "../../types";

// --- Args ---
const args = process.argv.slice(2);
let host = "http://localhost:7777";
let localOnly = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--host" && args[i + 1]) host = args[++i];
  if (args[i] === "--local") localOnly = true;
}

const awacs = new AwacsClient({ baseUrl: host });

// --- ANSI helpers ---
const ESC = "\x1b";
const CSI = `${ESC}[`;
const c = {
  reset: `${CSI}0m`,
  bold: `${CSI}1m`,
  dim: `${CSI}2m`,
  // Foreground
  red: `${CSI}31m`,
  green: `${CSI}32m`,
  yellow: `${CSI}33m`,
  cyan: `${CSI}36m`,
  white: `${CSI}37m`,
  // 256 color
  orange: `${CSI}38;5;214m`,
  purple: `${CSI}38;5;141m`,
  dimWhite: `${CSI}38;5;245m`,
  veryDim: `${CSI}38;5;239m`,
  // Background
  bgDim: `${CSI}48;5;235m`,
  bgSelect: `${CSI}48;5;236m`,
  bgDocker: `${CSI}48;5;53m`,
  bgProcess: `${CSI}48;5;22m`,
};

const altScreenOn = `${CSI}?1049h`;
const altScreenOff = `${CSI}?1049l`;
const hideCursor = `${CSI}?25l`;
const showCursor = `${CSI}?25h`;
const clearToEOL = `${CSI}K`;
const syncStart = `${CSI}?2026h`;
const syncEnd = `${CSI}?2026l`;
const moveTo = (row: number, col: number) => `${CSI}${row};${col}H`;

// --- State ---
let allServices: Service[] = [];
let rows: Row[] = [];
let cursor = 0;
let scrollOffset = 0;
let collapsed: Record<string, boolean> = {};
let cols = process.stdout.columns || 120;
let contentRows = (process.stdout.rows || 40) - 4;
let confirmAction: { type: "kill" | "restart"; label: string; row: Row } | null = null;
let lastUpdated = "";
let statusMessage = "";
let statusTimeout: ReturnType<typeof setTimeout> | null = null;

// --- Formatting helpers ---
function pad(s: string, n: number): string {
  if (s.length >= n) return s.slice(0, n);
  return s + " ".repeat(n - s.length);
}

function rpad(s: string, n: number): string {
  if (s.length >= n) return s.slice(0, n);
  return " ".repeat(n - s.length) + s;
}

// --- Render ---
function render() {
  rows = buildView(allServices, collapsed);
  if (cursor >= rows.length) cursor = Math.max(0, rows.length - 1);

  const buf: string[] = [];
  buf.push(syncStart + hideCursor);

  // --- Header ---
  const stats = getStats(allServices);
  buf.push(moveTo(1, 1));
  buf.push(`${c.bold}${c.white} AWACS${c.reset}`);
  const statParts = [
    `${c.dimWhite}${stats.total}${c.veryDim} services`,
    `${c.dimWhite}${stats.processes}${c.veryDim} processes`,
    `${c.dimWhite}${stats.containers}${c.veryDim} containers`,
    ...(stats.peers > 0 ? [`${c.dimWhite}${stats.peers}${c.veryDim} ${stats.peers === 1 ? "peer" : "peers"}`] : []),
    `${c.veryDim}${lastUpdated}`,
  ].join(`${c.veryDim} · `);
  buf.push(`  ${statParts}${c.reset}`);
  if (localOnly) buf.push(`  ${c.yellow}[local only]${c.reset}`);
  buf.push(clearToEOL);

  buf.push(moveTo(2, 1));
  buf.push(`${c.veryDim}${"─".repeat(cols)}${c.reset}`);

  // --- Content ---
  if (cursor < scrollOffset) scrollOffset = cursor;
  if (cursor >= scrollOffset + contentRows) scrollOffset = cursor - contentRows + 1;

  const visible = rows.slice(scrollOffset, scrollOffset + contentRows);

  for (let vi = 0; vi < visible.length; vi++) {
    const row = visible[vi];
    const rowIdx = scrollOffset + vi;
    const selected = rowIdx === cursor;
    const screenRow = vi + 3;
    buf.push(moveTo(screenRow, 1));

    const sel = selected ? c.bgSelect : "";
    const selReset = selected ? c.reset : "";

    if (row.type === "host") {
      const badge = row.isLocal
        ? `${c.bgDim}${c.cyan} local ${c.reset}`
        : `${c.bgDim}${c.orange} remote ${c.reset}`;
      const ip = row.ip ? ` ${c.veryDim}· ${row.ip}${c.reset}` : "";
      buf.push(`${sel} ${badge} ${c.bold}${row.isLocal ? c.cyan : c.orange}${row.label}${c.reset}${ip} ${c.veryDim}(${row.count})${selReset}${clearToEOL}`);
    } else if (row.type === "folder") {
      const indent = " ".repeat(row.depth * 2 + 1);
      const arrow = collapsed[row.path] ? "▸" : "▾";
      buf.push(`${sel}${indent}${c.veryDim}${arrow} ${c.orange}${row.label}${c.reset} ${c.veryDim}(${row.count})${selReset}${clearToEOL}`);
    } else if (row.type === "project") {
      const indent = " ".repeat(row.depth * 2 + 1);
      const arrow = collapsed[row.path] ? "▸" : "▾";
      buf.push(`${sel}${indent}${c.veryDim}${arrow} ${c.bold}${c.cyan}${row.label}${c.reset} ${c.veryDim}(${row.count})${selReset}${clearToEOL}`);
    } else if (row.type === "service") {
      const s = row.service;
      const indent = " ".repeat(row.depth * 2 + 1);
      const isDocker = s.source === "docker";
      const port = s.port ? `${c.cyan}:${s.port}${c.reset}` : `${c.veryDim} — ${c.reset}`;
      const badge = isDocker
        ? `${c.bgDocker}${c.purple} docker ${c.reset}`
        : `${c.bgProcess}${c.green} ${pad(s.command, 6)}${c.reset}`;
      const argsText = isDocker
        ? (s.dockerImage || s.dockerName || "")
        : shortenArgs(s.args);
      const maxArgs = cols - row.depth * 2 - 52;
      const argsTrunc = argsText.length > maxArgs ? argsText.slice(0, maxArgs - 1) + "…" : argsText;
      const res = isDocker
        ? `${c.dimWhite}${s.dockerStatus || ""}${c.reset}`
        : `${c.dimWhite}${rpad(s.cpu.toFixed(1) + "%", 6)} ${rpad(formatRss(s.rss), 8)}${c.reset}`;
      const pid = s.pid ? `${c.veryDim}${s.pid}${c.reset}` : "";

      buf.push(`${sel}${indent}${pad(port, 7)} ${badge} ${c.dim}${pad(argsTrunc, Math.max(10, maxArgs))}${c.reset} ${res} ${rpad(pid, 7)}${selReset}${clearToEOL}`);
    }
  }

  // Blank remaining content rows
  for (let vi = visible.length; vi < contentRows; vi++) {
    buf.push(moveTo(vi + 3, 1) + clearToEOL);
  }

  // --- Scrollbar ---
  if (rows.length > contentRows) {
    const barHeight = Math.max(1, Math.round(contentRows * contentRows / rows.length));
    const barStart = Math.round(scrollOffset / rows.length * contentRows);
    for (let i = 0; i < contentRows; i++) {
      buf.push(moveTo(i + 3, cols));
      if (i >= barStart && i < barStart + barHeight) {
        buf.push(`${c.veryDim}┃${c.reset}`);
      } else {
        buf.push(`${c.veryDim}│${c.reset}`);
      }
    }
  }

  // --- Footer ---
  const footerRow = (process.stdout.rows || 40);
  buf.push(moveTo(footerRow - 1, 1));
  buf.push(`${c.veryDim}${"─".repeat(cols)}${c.reset}`);

  buf.push(moveTo(footerRow, 1));
  if (confirmAction) {
    const color = confirmAction.type === "kill" ? c.red : c.green;
    buf.push(`${color}${confirmAction.type} ${confirmAction.label}? ${c.bold}y${c.reset}${color}/${c.bold}n${c.reset}${clearToEOL}`);
  } else if (statusMessage) {
    buf.push(statusMessage + clearToEOL);
  } else {
    buf.push([
      `${c.dimWhite}↑↓${c.veryDim} navigate`,
      `${c.dimWhite}⏎/←→${c.veryDim} expand/collapse`,
      `${c.dimWhite}k${c.veryDim} kill`,
      `${c.dimWhite}r${c.veryDim} restart`,
      `${c.dimWhite}l${c.veryDim} ${localOnly ? "all" : "local"}`,
      `${c.dimWhite}q${c.veryDim} quit`,
    ].join("  ") + c.reset + clearToEOL);
  }

  buf.push(syncEnd);
  process.stdout.write(buf.join(""));
}

function showStatus(msg: string) {
  statusMessage = msg;
  if (statusTimeout) clearTimeout(statusTimeout);
  statusTimeout = setTimeout(() => { statusMessage = ""; render(); }, 3000);
  render();
}

// --- Actions ---
function toggleCollapse() {
  const row = rows[cursor];
  if (row?.type === "folder" || row?.type === "project") {
    collapsed[row.path] = !collapsed[row.path];
    render();
  }
}

function getServiceLabel(s: Service): string {
  if (s.source === "docker") return s.dockerName || s.dockerImage || "container";
  return `PID ${s.pid}`;
}

async function performKill(row: Row) {
  if (row.type === "service") {
    const s = row.service;
    try {
      await awacs.kill([{ pid: s.pid, source: s.source, dockerName: s.dockerName, peerHost: s.peerHost }]);
      showStatus(`${c.green}Killed ${getServiceLabel(s)}${c.reset}`);
    } catch { showStatus(`${c.red}Failed to kill${c.reset}`); }
  } else if (row.type === "project") {
    const targets = row.indices.map(i => {
      const s = allServices[i];
      return { pid: s.pid, source: s.source, dockerName: s.dockerName, peerHost: s.peerHost };
    });
    try {
      await awacs.kill(targets);
      showStatus(`${c.green}Killed ${targets.length} services${c.reset}`);
    } catch { showStatus(`${c.red}Failed to kill project${c.reset}`); }
  }
}

async function performRestart(row: Row) {
  if (row.type === "service") {
    const s = row.service;
    try {
      await awacs.restart([{ pid: s.pid, source: s.source, dockerName: s.dockerName, args: s.args, cwd: s.cwd, peerHost: s.peerHost }]);
      showStatus(`${c.green}Restarted ${getServiceLabel(s)}${c.reset}`);
    } catch { showStatus(`${c.red}Failed to restart${c.reset}`); }
  } else if (row.type === "project") {
    const targets = row.indices.map(i => {
      const s = allServices[i];
      return { pid: s.pid, source: s.source, dockerName: s.dockerName, args: s.args, cwd: s.cwd, peerHost: s.peerHost };
    });
    try {
      await awacs.restart(targets);
      showStatus(`${c.green}Restarted ${targets.length} services${c.reset}`);
    } catch { showStatus(`${c.red}Failed to restart project${c.reset}`); }
  }
}

function requestAction(type: "kill" | "restart") {
  const row = rows[cursor];
  if (!row) return;
  if (row.type === "service") {
    confirmAction = { type, label: getServiceLabel(row.service), row };
    render();
  } else if (row.type === "project") {
    confirmAction = { type, label: `${row.count} services in ${row.label}`, row };
    render();
  }
}

// --- Input handling ---
function handleInput(data: Buffer) {
  const str = data.toString();

  if (confirmAction) {
    if (str === "y" || str === "Y") {
      const action = confirmAction;
      confirmAction = null;
      if (action.type === "kill") performKill(action.row);
      else performRestart(action.row);
    } else {
      confirmAction = null;
      render();
    }
    return;
  }

  if (str === "\x1b[A" || str === "k") {
    if (cursor > 0) { cursor--; render(); }
  } else if (str === "\x1b[B" || str === "j") {
    if (cursor < rows.length - 1) { cursor++; render(); }
  } else if (str === "\x1b[5~") {
    cursor = Math.max(0, cursor - contentRows);
    render();
  } else if (str === "\x1b[6~") {
    cursor = Math.min(rows.length - 1, cursor + contentRows);
    render();
  } else if (str === "g") {
    cursor = 0; render();
  } else if (str === "G") {
    cursor = rows.length - 1; render();
  } else if (str === "\r" || str === " " || str === "\x1b[C" || str === "\x1b[D") {
    toggleCollapse();
  } else if (str === "K") {
    requestAction("kill");
  } else if (str === "R") {
    requestAction("restart");
  } else if (str === "l") {
    localOnly = !localOnly;
    refresh();
  } else if (str === "q" || str === "\x03") {
    cleanup();
  }
}

// --- Lifecycle ---
function cleanup() {
  process.stdout.write(altScreenOff + showCursor);
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  process.exit(0);
}

function stampUpdated() {
  lastUpdated = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

async function refresh() {
  try {
    allServices = await awacs.getServices({ local: localOnly || undefined });
    stampUpdated();
    render();
  } catch {
    allServices = [];
    render();
    showStatus(`${c.red}Cannot reach ${host}${c.reset}`);
  }
}

async function main() {
  process.stdout.write(altScreenOn + hideCursor);
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on("data", handleInput);
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
  process.on("resize", () => {
    cols = process.stdout.columns || 120;
    contentRows = (process.stdout.rows || 40) - 4;
    render();
  });
  process.stdout.on("resize", () => {
    cols = process.stdout.columns || 120;
    contentRows = (process.stdout.rows || 40) - 4;
    render();
  });

  await refresh();
  subscribeSSE();
}

async function subscribeSSE() {
  try {
    const resp = await fetch(`${host}/api/events`);
    if (!resp.ok || !resp.body) return;
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() || "";
      for (const line of lines) {
        if (line.startsWith("data: ")) {
          try {
            const services = JSON.parse(line.slice(6));
            allServices = localOnly ? services.filter((s: Service) => !s.peerHost) : services;
            stampUpdated();
            render();
          } catch {}
        }
      }
    }
  } catch {}
  setTimeout(subscribeSSE, 2000);
}

main();
