// Shared view model — the "map" phase that both web and TUI clients consume
import type { Service } from "../types";

export interface TreeNode {
  _children: Record<string, TreeNode>;
  _projects: Record<string, number[]>;
}

export type Row =
  | { type: "host"; label: string; ip: string; isLocal: boolean; count: number }
  | { type: "folder"; label: string; count: number; depth: number; path: string }
  | { type: "project"; label: string; count: number; depth: number; path: string; indices: number[] }
  | { type: "service"; service: Service; index: number; depth: number };

export interface ViewStats {
  total: number;
  processes: number;
  containers: number;
  peers: number;
}

// --- Tree building ---
function buildTree(services: Service[], indexMap: number[]): Record<string, TreeNode> {
  const tree: Record<string, TreeNode> = {};
  for (let i = 0; i < services.length; i++) {
    const s = services[i];
    const realIndex = indexMap[i];
    let path = (s.cwd || "unknown").replace(/\\/g, "/");
    path = path.replace(/^[A-Z]:\/Users\/[^/]+/i, "~");
    path = path.replace(/^\/Users\/[^/]+/, "~");
    path = path.replace(/^\/private/, "");

    const parts = path.split("/").filter(Boolean);
    if (parts.length === 0) parts.push("/");
    let node = tree;
    for (let j = 0; j < parts.length; j++) {
      const part = parts[j];
      if (!node[part]) node[part] = { _children: {}, _projects: {} };
      if (j === parts.length - 1) {
        const proj = s.projectName || s.cwd?.replace(/\\/g, "/").split("/").pop() || "unknown";
        if (!node[part]._projects[proj]) node[part]._projects[proj] = [];
        node[part]._projects[proj].push(realIndex);
      }
      node = node[part]._children;
    }
  }
  return tree;
}

function hasProjects(node: TreeNode): boolean {
  return Object.keys(node._projects).length > 0;
}

export function countServices(node: TreeNode): number {
  let count = 0;
  for (const k of Object.keys(node._projects)) count += node._projects[k].length;
  for (const k of Object.keys(node._children)) count += countServices(node._children[k]);
  return count;
}

function compactPath(children: Record<string, TreeNode>): Record<string, TreeNode> {
  const result: Record<string, TreeNode> = {};
  for (const key of Object.keys(children)) {
    let node = children[key];
    let label = key;
    while (true) {
      const childKeys = Object.keys(node._children);
      if (!hasProjects(node) && childKeys.length === 1) {
        label = label + "/" + childKeys[0];
        node = node._children[childKeys[0]];
      } else break;
    }
    node._children = compactPath(node._children);
    result[label] = node;
  }
  return result;
}

// --- Flatten tree into ordered rows ---
function flattenFolder(
  name: string, node: TreeNode, depth: number, pathPrefix: string,
  services: Service[], collapsed: Record<string, boolean>,
): Row[] {
  const fullPath = pathPrefix ? pathPrefix + "/" + name : name;
  const out: Row[] = [];
  const count = countServices(node);
  out.push({ type: "folder", label: name, count, depth, path: fullPath });

  if (collapsed[fullPath]) return out;

  for (const proj of Object.keys(node._projects).sort()) {
    const indices = node._projects[proj];
    const projPath = fullPath + "/_proj_" + proj;
    out.push({ type: "project", label: proj, count: indices.length, depth: depth + 1, path: projPath, indices });
    if (!collapsed[projPath]) {
      for (const idx of indices) {
        out.push({ type: "service", service: services[idx], index: idx, depth: depth + 2 });
      }
    }
  }

  for (const child of Object.keys(node._children).sort()) {
    out.push(...flattenFolder(child, node._children[child], depth + 1, fullPath, services, collapsed));
  }
  return out;
}

// --- Main entry point ---
export function buildView(services: Service[], collapsed: Record<string, boolean>): Row[] {
  const groups: Record<string, number[]> = {};
  const hostnames: Record<string, string> = {};
  for (let i = 0; i < services.length; i++) {
    const s = services[i];
    const gKey = s.peerHost || "__local__";
    if (!groups[gKey]) groups[gKey] = [];
    groups[gKey].push(i);
    if (s.peerHost && s.peerHostname) hostnames[s.peerHost] = s.peerHostname;
  }

  const groupKeys = Object.keys(groups).sort((a, b) => {
    if (a === "__local__") return -1;
    if (b === "__local__") return 1;
    return (hostnames[a] || a).localeCompare(hostnames[b] || b);
  });

  const multiHost = groupKeys.length > 1 || !groupKeys.includes("__local__");
  const out: Row[] = [];

  for (const gKey of groupKeys) {
    const indices = groups[gKey];
    const groupServices = indices.map(i => services[i]);

    if (multiHost) {
      out.push({
        type: "host",
        label: gKey === "__local__" ? "This machine" : (hostnames[gKey] || gKey),
        ip: gKey === "__local__" ? "" : gKey,
        isLocal: gKey === "__local__",
        count: indices.length,
      });
    }

    const rawTree = buildTree(groupServices, indices);
    const compacted = compactPath(rawTree);
    const depth = multiHost ? 1 : 0;
    for (const key of Object.keys(compacted).sort()) {
      out.push(...flattenFolder(key, compacted[key], depth, gKey, services, collapsed));
    }
  }
  return out;
}

export function getStats(services: Service[]): ViewStats {
  let processes = 0, containers = 0;
  const peerHosts: Record<string, boolean> = {};
  for (const s of services) {
    if (s.source === "docker") containers++;
    else processes++;
    if (s.peerHost) peerHosts[s.peerHost] = true;
  }
  return { total: services.length, processes, containers, peers: Object.keys(peerHosts).length };
}

// --- Formatting ---
export function formatRss(kb: number): string {
  if (kb > 1048576) return (kb / 1048576).toFixed(1) + " GB";
  if (kb > 1024) return Math.round(kb / 1024) + " MB";
  return kb + " KB";
}

export function shortenArgs(args: string): string {
  return args
    .replace(/\/Users\/[^/\s]+/g, "~")
    .replace(/[A-Z]:\\Users\\[^\\]+/gi, "~")
    .replace(/\/opt\/homebrew\/Cellar\/[^/]+\/[^/]+\/bin\//g, "");
}
