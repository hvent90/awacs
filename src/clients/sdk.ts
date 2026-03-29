import type { Service } from "../types";

export interface AwacsClientOptions {
  host?: string;
  port?: number;
  baseUrl?: string;
}

export interface KillTarget {
  pid: number;
  source: string;
  dockerName?: string;
  peerHost?: string;
}

export interface RestartTarget {
  pid: number;
  source: string;
  dockerName?: string;
  args?: string;
  cwd?: string;
  peerHost?: string;
}

export interface ActionResult {
  ok: boolean;
  results?: string[];
  error?: string;
}

export class AwacsClient {
  private baseUrl: string;

  constructor(opts?: AwacsClientOptions) {
    if (opts?.baseUrl !== undefined) {
      this.baseUrl = opts.baseUrl;
    } else {
      const host = opts?.host ?? "localhost";
      const port = opts?.port ?? 7777;
      this.baseUrl = `http://${host}:${port}`;
    }
  }

  async getServices(opts?: { local?: boolean }): Promise<Service[]> {
    const url = opts?.local
      ? `${this.baseUrl}/api/services?local=1`
      : `${this.baseUrl}/api/services`;
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return resp.json();
  }

  subscribe(cb: (services: Service[]) => void): () => void {
    const eventSource = new EventSource(`${this.baseUrl}/api/events`);
    eventSource.onmessage = (e) => {
      try {
        cb(JSON.parse(e.data));
      } catch {}
    };
    return () => eventSource.close();
  }

  async kill(targets: KillTarget[]): Promise<ActionResult> {
    const resp = await fetch(`${this.baseUrl}/api/kill`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ services: targets }),
    });
    return resp.json();
  }

  async restart(targets: RestartTarget[]): Promise<ActionResult> {
    const resp = await fetch(`${this.baseUrl}/api/restart`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ services: targets }),
    });
    return resp.json();
  }
}
