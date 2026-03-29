import { $ } from "bun";
import path from "path";
import type { Service } from "../types";

// Windows system processes that listen on ports but aren't user servers
const SYSTEM_COMMANDS = new Set([
  "System",
  "Registry",
  "svchost.exe",
  "lsass.exe",
  "services.exe",
  "wininit.exe",
  "spoolsv.exe",
  "SecurityHealthService.exe",
  "SearchIndexer.exe",
]);

interface ListeningEntry {
  command: string;
  pid: number;
  address: string;
  port: number;
}

interface ProcessInfo {
  name: string;
  commandLine: string;
  executablePath: string;
  workingSetSize: number; // bytes
}

async function getListeningPorts(): Promise<ListeningEntry[]> {
  const result = await $`netstat -ano -p TCP`.text();

  const entries: ListeningEntry[] = [];
  const seen = new Set<string>();

  for (const line of result.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("TCP")) continue;

    const parts = trimmed.split(/\s+/);
    // Format: TCP  <local addr>  <foreign addr>  <state>  <PID>
    if (parts.length < 5 || parts[3] !== "LISTENING") continue;

    const local = parts[1];
    const lastColon = local.lastIndexOf(":");
    const address = local.substring(0, lastColon);
    const port = parseInt(local.substring(lastColon + 1));
    const pid = parseInt(parts[4]);

    if (isNaN(port) || isNaN(pid) || pid === 0) continue;

    const key = `${pid}:${port}`;
    if (seen.has(key)) continue;
    seen.add(key);

    entries.push({ command: "", pid, address, port });
  }

  return entries;
}

async function getProcessInfo(
  pids: number[]
): Promise<Map<number, ProcessInfo>> {
  const map = new Map<number, ProcessInfo>();
  if (pids.length === 0) return map;

  // tasklist sees all processes (including elevated/SYSTEM) — use it as baseline
  try {
    const tlResult = await $`tasklist /FO CSV /NH`.text();
    for (const line of tlResult.split("\n")) {
      const match = line.match(/^"([^"]+)","(\d+)","[^"]*","[^"]*","([^"]+)"/);
      if (!match) continue;
      const pid = parseInt(match[2]);
      if (!pids.includes(pid)) continue;
      const memStr = match[3].replace(/[^\d]/g, ""); // "28,816 K" → "28816"
      map.set(pid, {
        name: match[1],
        commandLine: "",
        executablePath: "",
        workingSetSize: parseInt(memStr) * 1024, // KB → bytes
      });
    }
  } catch {}

  // PowerShell enriches with command line, executable path, and precise memory
  const filter = pids.map((p) => `ProcessId=${p}`).join(" OR ");
  const script = `Get-CimInstance Win32_Process -Filter '${filter}' | Select-Object ProcessId,Name,CommandLine,ExecutablePath,WorkingSetSize | ConvertTo-Json -Compress`;

  try {
    const proc = Bun.spawn(["powershell", "-NoProfile", "-Command", script]);
    const result = await new Response(proc.stdout).text();
    await proc.exited;

    if (!result.trim()) return map;

    const parsed = JSON.parse(result.trim());
    const items: any[] = Array.isArray(parsed) ? parsed : [parsed];

    for (const item of items) {
      if (!item?.ProcessId) continue;
      const existing = map.get(item.ProcessId);
      map.set(item.ProcessId, {
        name: item.Name || existing?.name || "",
        commandLine: item.CommandLine || "",
        executablePath: item.ExecutablePath || "",
        workingSetSize: item.WorkingSetSize || existing?.workingSetSize || 0,
      });
    }
  } catch {}

  return map;
}

function inferCwd(commandLine: string, executablePath: string): string {
  if (commandLine) {
    const patterns = [
      /"([A-Za-z]:\\[^"]+\.(js|ts|mjs|cjs|py|rb|exs|rs))"/i,
      /([A-Za-z]:\\[^\s]+\.(js|ts|mjs|cjs|py|rb|exs|rs))/i,
      /([A-Za-z]:\/[^\s"]+\.(js|ts|mjs|cjs|py|rb|exs|rs))/i,
    ];
    for (const pattern of patterns) {
      const match = commandLine.match(pattern);
      if (match) return path.dirname(match[1] || match[0]);
    }
  }

  if (executablePath) return path.dirname(executablePath);
  return "";
}

async function getProjectName(cwd: string): Promise<string | null> {
  try {
    const pkg = await Bun.file(path.join(cwd, "package.json")).json();
    if (pkg.name) return pkg.name;
  } catch {}

  try {
    const mix = await Bun.file(path.join(cwd, "mix.exs")).text();
    const match = mix.match(/app:\s*:(\w+)/);
    if (match) return match[1];
  } catch {}

  try {
    const cargo = await Bun.file(path.join(cwd, "Cargo.toml")).text();
    const match = cargo.match(/name\s*=\s*"([^"]+)"/);
    if (match) return match[1];
  } catch {}

  return null;
}

async function getDockerServices(): Promise<Service[]> {
  try {
    const ids = (await $`docker ps -q 2>/dev/null`.text()).trim();
    if (!ids) return [];

    const result =
      await $`docker ps --format '{{.Names}}\t{{.Ports}}\t{{.Image}}\t{{.Status}}' 2>/dev/null`.text();

    const idList = ids.split("\n").filter(Boolean);
    const inspectFormat =
      '{{.Name}}\t{{index .Config.Labels "com.docker.compose.project.working_dir"}}\t{{index .Config.Labels "com.docker.compose.service"}}\t{{index .Config.Labels "com.docker.compose.project"}}';
    const inspectResult =
      await $`docker inspect --format ${inspectFormat} ${idList} 2>/dev/null`.text();

    const composeInfo = new Map<
      string,
      { cwd: string; serviceName: string }
    >();
    for (const line of inspectResult.split("\n")) {
      if (!line.trim()) continue;
      const [rawName, workDir, serviceName, projectName] = line.split("\t");
      const name = rawName.replace(/^\//, "");
      if (workDir) {
        const displayName =
          serviceName && serviceName !== "default"
            ? serviceName
            : projectName || name;
        composeInfo.set(name, { cwd: workDir, serviceName: displayName });
      }
    }

    const services: Service[] = [];

    for (const line of result.split("\n")) {
      if (!line.trim()) continue;
      const [name, ports, image, status] = line.split("\t");

      const compose = composeInfo.get(name);
      const cwd = compose?.cwd ?? "";

      const portMatches = (ports || "").matchAll(
        /([\d.]+):(\d+)->(\d+)\/(\w+)/g
      );
      for (const m of portMatches) {
        services.push({
          pid: 0,
          command: "docker",
          args: `${image} (${name})`,
          port: parseInt(m[2]),
          bindAddress: m[1],
          cwd,
          projectName: compose?.serviceName ?? name,
          cpu: 0,
          mem: 0,
          rss: 0,
          source: "docker",
          dockerName: name,
          dockerImage: image,
          dockerStatus: status,
        });
      }

      if (!ports || !ports.includes("->")) {
        services.push({
          pid: 0,
          command: "docker",
          args: `${image} (${name})`,
          port: 0,
          bindAddress: "",
          cwd,
          projectName: compose?.serviceName ?? name,
          cpu: 0,
          mem: 0,
          rss: 0,
          source: "docker",
          dockerName: name,
          dockerImage: image,
          dockerStatus: status,
        });
      }
    }

    for (const s of services) {
      if (s.cwd && !s.projectName) {
        s.projectName = await getProjectName(s.cwd);
      }
    }

    return services;
  } catch {
    return [];
  }
}

export async function killService(service: {
  pid: number;
  source: string;
  dockerName?: string;
}): Promise<string> {
  if (service.source === "docker" && service.dockerName) {
    await $`docker stop ${service.dockerName}`.text();
    return `Stopped container ${service.dockerName}`;
  }
  if (service.pid) {
    await $`taskkill /PID ${String(service.pid)} /F`.text();
    return `Killed PID ${service.pid}`;
  }
  throw new Error("Nothing to kill");
}

export async function restartService(service: {
  pid: number;
  source: string;
  dockerName?: string;
  args: string;
  cwd: string;
}): Promise<string> {
  if (service.source === "docker" && service.dockerName) {
    await $`docker restart ${service.dockerName}`.text();
    return `Restarted container ${service.dockerName}`;
  }
  if (service.pid && service.args && service.cwd) {
    const { args, cwd } = service;
    try {
      await $`taskkill /PID ${String(service.pid)} /F`.quiet();
    } catch {}
    await Bun.sleep(500);
    Bun.spawn(["cmd", "/c", args], {
      cwd,
      stdout: "ignore",
      stderr: "ignore",
    });
    return `Restarted: ${args} in ${cwd}`;
  }
  throw new Error("Not enough info to restart");
}

export async function scan(): Promise<Service[]> {
  const [entries, dockerServices] = await Promise.all([
    getListeningPorts(),
    getDockerServices(),
  ]);

  const dockerPorts = new Set(dockerServices.map((s) => s.port));
  const userEntries = entries.filter((e) => !dockerPorts.has(e.port));

  const pids = [...new Set(userEntries.map((e) => e.pid))];
  const processInfo = await getProcessInfo(pids);

  // Filter known OS-level system processes
  const filteredEntries = userEntries.filter((e) => {
    const info = processInfo.get(e.pid);
    return !info || !SYSTEM_COMMANDS.has(info.name);
  });

  // Infer working directories from command lines
  const cwds = new Map<number, string>();
  for (const entry of filteredEntries) {
    const info = processInfo.get(entry.pid);
    if (info) {
      const cwd = inferCwd(info.commandLine, info.executablePath);
      if (cwd) cwds.set(entry.pid, cwd);
    }
  }

  const projectNameCache = new Map<string, string | null>();
  const uniqueCwds = [...new Set(cwds.values())].filter(Boolean);
  await Promise.all(
    uniqueCwds.map(async (cwd) => {
      projectNameCache.set(cwd, await getProjectName(cwd));
    })
  );

  const services: Service[] = filteredEntries.map((entry) => {
    const info = processInfo.get(entry.pid);
    const cwd = cwds.get(entry.pid) ?? "";
    const name = info?.name.replace(/\.exe$/i, "") ?? "";

    return {
      pid: entry.pid,
      command: name,
      args: info?.commandLine || info?.executablePath || name,
      port: entry.port,
      bindAddress: entry.address,
      cwd,
      projectName: projectNameCache.get(cwd) ?? null,
      cpu: 0,
      mem: 0,
      rss: info ? Math.round(info.workingSetSize / 1024) : 0,
      source: "process" as const,
    };
  });

  return [...services, ...dockerServices].sort((a, b) => a.port - b.port);
}
