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
