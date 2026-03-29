import { $ } from "bun";

export interface Service {
  pid: number;
  command: string;
  args: string;
  port: number;
  bindAddress: string;
  cwd: string;
  projectName: string | null;
  cpu: number;
  mem: number;
  rss: number; // KB
  source: "process" | "docker";
  dockerName?: string;
  dockerImage?: string;
  dockerStatus?: string;
  peerHost?: string;
  peerHostname?: string;
}

// macOS system processes that listen on ports but aren't user servers
const SYSTEM_COMMANDS = new Set([
  "ControlCe", // AirPlay/AirDrop - ports 5000, 7000
  "ARDAgent", // Apple Remote Desktop
  "rapportd", // Nearby device communication
]);

interface ListeningEntry {
  command: string;
  pid: number;
  address: string;
  port: number;
}

async function getListeningPorts(): Promise<ListeningEntry[]> {
  const result =
    await $`lsof -iTCP -sTCP:LISTEN -P -n 2>/dev/null`.text();

  const entries: ListeningEntry[] = [];
  const seen = new Set<string>();

  for (const line of result.split("\n")) {
    if (line.startsWith("COMMAND") || !line.trim()) continue;
    const parts = line.split(/\s+/);
    const command = parts[0];
    const pid = parseInt(parts[1]);
    const name = parts[8]; // e.g. *:3001 or 127.0.0.1:5990 or [::1]:5173

    if (!name || !name.includes(":")) continue;

    const lastColon = name.lastIndexOf(":");
    const address = name.substring(0, lastColon);
    const port = parseInt(name.substring(lastColon + 1));

    if (isNaN(port)) continue;

    // Dedupe by pid+port
    const key = `${pid}:${port}`;
    if (seen.has(key)) continue;
    seen.add(key);

    entries.push({ command, pid, address, port });
  }

  return entries;
}

async function getProcessDetails(
  pids: number[]
): Promise<Map<number, { args: string; cpu: number; mem: number; rss: number }>> {
  const map = new Map();
  if (pids.length === 0) return map;

  const result =
    await $`ps -p ${pids.join(",")} -o pid=,pcpu=,pmem=,rss=,args=`.text();

  for (const line of result.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // Format: PID %CPU %MEM RSS ARGS...
    const match = trimmed.match(/^(\d+)\s+([\d.]+)\s+([\d.]+)\s+(\d+)\s+(.+)$/);
    if (match) {
      map.set(parseInt(match[1]), {
        cpu: parseFloat(match[2]),
        mem: parseFloat(match[3]),
        rss: parseInt(match[4]),
        args: match[5],
      });
    }
  }
  return map;
}

async function getCwds(
  pids: number[]
): Promise<Map<number, string>> {
  const map = new Map();
  if (pids.length === 0) return map;

  // Batch all PIDs into one lsof call
  const result =
    await $`lsof -p ${pids.join(",")} -d cwd -Fn 2>/dev/null`.text();

  let currentPid: number | null = null;
  for (const line of result.split("\n")) {
    if (line.startsWith("p")) {
      currentPid = parseInt(line.substring(1));
    } else if (line.startsWith("n/") && currentPid !== null) {
      map.set(currentPid, line.substring(1));
      currentPid = null; // only take first 'n' line per pid
    }
  }
  return map;
}

async function getProjectName(cwd: string): Promise<string | null> {
  // Try package.json first (Node/Bun projects)
  try {
    const pkg = await Bun.file(`${cwd}/package.json`).json();
    if (pkg.name) return pkg.name;
  } catch {}

  // Try mix.exs (Elixir projects)
  try {
    const mix = await Bun.file(`${cwd}/mix.exs`).text();
    const match = mix.match(/app:\s*:(\w+)/);
    if (match) return match[1];
  } catch {}

  // Try Cargo.toml (Rust projects)
  try {
    const cargo = await Bun.file(`${cwd}/Cargo.toml`).text();
    const match = cargo.match(/name\s*=\s*"([^"]+)"/);
    if (match) return match[1];
  } catch {}

  // Fall back to directory name
  return null;
}

async function getDockerServices(): Promise<Service[]> {
  try {
    // Get container IDs
    const ids = (await $`docker ps -q 2>/dev/null`.text()).trim();
    if (!ids) return [];

    // Get basic info + compose labels in one pass
    const result =
      await $`docker ps --format '{{.Names}}\t{{.Ports}}\t{{.Image}}\t{{.Status}}' 2>/dev/null`.text();

    const idList = ids.split("\n").filter(Boolean);
    const inspectFormat = '{{.Name}}\t{{index .Config.Labels "com.docker.compose.project.working_dir"}}\t{{index .Config.Labels "com.docker.compose.service"}}\t{{index .Config.Labels "com.docker.compose.project"}}';
    const inspectResult =
      await $`docker inspect --format ${inspectFormat} ${idList} 2>/dev/null`.text();

    // Build lookup: container name -> { cwd, serviceName }
    const composeInfo = new Map<string, { cwd: string; serviceName: string }>();
    for (const line of inspectResult.split("\n")) {
      if (!line.trim()) continue;
      const [rawName, workDir, serviceName, projectName] = line.split("\t");
      const name = rawName.replace(/^\//, ""); // docker inspect prefixes with /
      if (workDir) {
        // Use compose service name, but fall back to project name if service is generic ("default")
        const displayName = (serviceName && serviceName !== "default") ? serviceName : (projectName || name);
        composeInfo.set(name, { cwd: workDir, serviceName: displayName });
      }
    }

    const services: Service[] = [];
    const cwdsToResolve = new Set<string>();

    for (const line of result.split("\n")) {
      if (!line.trim()) continue;
      const [name, ports, image, status] = line.split("\t");

      const compose = composeInfo.get(name);
      const cwd = compose?.cwd ?? "";
      if (cwd) cwdsToResolve.add(cwd);

      // Parse port mappings like "0.0.0.0:3002->3000/tcp"
      const portMatches = (ports || "").matchAll(
        /([\d.]+):(\d+)->(\d+)\/(\w+)/g
      );
      for (const m of portMatches) {
        services.push({
          pid: 0,
          command: "docker",
          args: `${image} (${name})`,
          port: parseInt(m[2]), // host port
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

      // Containers with no port mappings still get listed
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

    // Resolve project names from compose working dirs
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

export async function killService(service: { pid: number; source: string; dockerName?: string }): Promise<string> {
  if (service.source === "docker" && service.dockerName) {
    await $`docker stop ${service.dockerName}`.text();
    return `Stopped container ${service.dockerName}`;
  }
  if (service.pid) {
    await $`kill ${service.pid}`.text();
    return `Killed PID ${service.pid}`;
  }
  throw new Error("Nothing to kill");
}

export async function restartService(service: { pid: number; source: string; dockerName?: string; args: string; cwd: string }): Promise<string> {
  if (service.source === "docker" && service.dockerName) {
    await $`docker restart ${service.dockerName}`.text();
    return `Restarted container ${service.dockerName}`;
  }
  if (service.pid && service.args && service.cwd) {
    const args = service.args;
    const cwd = service.cwd;
    await $`kill ${service.pid}`.quiet();
    // Wait briefly for process to die
    await Bun.sleep(500);
    // Respawn in background
    Bun.spawn(["sh", "-c", args], { cwd, stdout: "ignore", stderr: "ignore" });
    return `Restarted: ${args} in ${cwd}`;
  }
  throw new Error("Not enough info to restart");
}

export async function scan(): Promise<Service[]> {
  const [entries, dockerServices] = await Promise.all([
    getListeningPorts(),
    getDockerServices(),
  ]);

  // Filter system services and collect docker PIDs to exclude
  const dockerPorts = new Set(dockerServices.map((s) => s.port));
  const userEntries = entries.filter(
    (e) => !SYSTEM_COMMANDS.has(e.command) && !dockerPorts.has(e.port)
  );

  const pids = [...new Set(userEntries.map((e) => e.pid))];

  const [processDetails, cwds] = await Promise.all([
    getProcessDetails(pids),
    getCwds(pids),
  ]);

  // Resolve project names (cache by cwd)
  const projectNameCache = new Map<string, string | null>();
  const uniqueCwds = [...new Set(cwds.values())].filter(
    (c) => c && c !== "/"
  );
  await Promise.all(
    uniqueCwds.map(async (cwd) => {
      projectNameCache.set(cwd, await getProjectName(cwd));
    })
  );

  const services: Service[] = userEntries.map((entry) => {
    const details = processDetails.get(entry.pid);
    const cwd = cwds.get(entry.pid) ?? "";

    return {
      pid: entry.pid,
      command: entry.command,
      args: details?.args ?? "",
      port: entry.port,
      bindAddress: entry.address,
      cwd,
      projectName: projectNameCache.get(cwd) ?? null,
      cpu: details?.cpu ?? 0,
      mem: details?.mem ?? 0,
      rss: details?.rss ?? 0,
      source: "process" as const,
    };
  });

  return [...services, ...dockerServices].sort((a, b) => a.port - b.port);
}
