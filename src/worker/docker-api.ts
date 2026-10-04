import http from "node:http";

/**
 * Minimal Docker Engine API client over the unix socket (SEC-004 / AT-SEC-007).
 * Only the handful of calls the worker needs are implemented, so the worker
 * never shells out and never passes user input through a shell.
 */
export interface DockerApiOptions {
  socketPath?: string;
  apiVersion?: string;
}

export interface ContainerCreateSpec {
  Image: string;
  Cmd: string[];
  Env: string[];
  WorkingDir?: string;
  User?: string;
  HostConfig: {
    Binds: string[];
    NetworkMode: string;
    AutoRemove: boolean;
    ReadonlyRootfs?: boolean;
    Tmpfs?: Record<string, string>;
    CapDrop?: string[];
    SecurityOpt?: string[];
    PidsLimit?: number;
    Memory?: number;
    NanoCpus?: number;
  };
  Labels: Record<string, string>;
}

export class DockerApi {
  private readonly socketPath: string;
  private readonly apiVersion: string;

  constructor(options: DockerApiOptions = {}) {
    this.socketPath = options.socketPath ?? process.env.PI_DOCKER_SOCKET ?? "/var/run/docker.sock";
    this.apiVersion = options.apiVersion ?? process.env.PI_DOCKER_API_VERSION ?? "v1.43";
  }

  private request<T>(method: string, pathName: string, body?: unknown): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const request = http.request({
        socketPath: this.socketPath,
        path: `/${this.apiVersion}${pathName}`,
        method,
        headers: payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {},
      }, (response) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => { text += chunk; });
        response.on("end", () => {
          const status = response.statusCode ?? 0;
          if (status >= 400) {
            reject(new Error(`Docker API ${method} ${pathName} failed: ${status} ${text.slice(0, 300)}`));
            return;
          }
          if (!text) {
            resolve({} as T);
            return;
          }
          try {
            resolve(JSON.parse(text) as T);
          } catch (error) {
            reject(new Error(`Docker API ${method} ${pathName} returned invalid JSON: ${(error as Error).message}`));
          }
        });
      });
      request.on("error", (error) => reject(new Error(`Docker API ${method} ${pathName} error: ${error.message}`)));
      if (payload) request.write(payload);
      request.end();
    });
  }

  /** `/_ping` answers with plain "OK", not JSON (Docker API convention). */
  async ping() {
    return new Promise<boolean>((resolve, reject) => {
      const request = http.request({ socketPath: this.socketPath, path: `/${this.apiVersion}/_ping`, method: "GET" }, (response) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => { text += chunk; });
        response.on("end", () => {
          if ((response.statusCode ?? 0) < 400 && text.trim().length > 0) resolve(true);
          else reject(new Error(`docker ping failed: ${response.statusCode ?? 0} ${text.slice(0, 80)}`));
        });
      });
      request.on("error", (error) => reject(new Error(`docker ping error: ${error.message}`)));
      request.end();
    });
  }

  async inspectImage(image: string) {
    return this.request<{ Id: string }>("GET", `/images/${encodeURIComponent(image)}/json`);
  }

  async createContainer(name: string, spec: ContainerCreateSpec) {
    const result = await this.request<{ Id: string }>("POST", `/containers/create?name=${encodeURIComponent(name)}`, spec);
    return result.Id;
  }

  async startContainer(id: string) {
    await this.request<Record<string, never>>("POST", `/containers/${id}/start`);
  }

  async waitContainer(id: string) {
    return this.request<{ StatusCode: number }>("POST", `/containers/${id}/wait`);
  }

  async removeContainer(id: string, force = true) {
    await this.request<Record<string, never>>("DELETE", `/containers/${id}?force=${force ? "true" : "false"}&v=true`);
  }

  async killContainer(id: string, signal = "SIGKILL") {
    await this.request<Record<string, never>>("POST", `/containers/${id}/kill?signal=${encodeURIComponent(signal)}`);
  }

  /** Streams stdout/stderr lines until the container exits (or the signal aborts). */
  logsFollow(id: string, onLine: (line: string, stream: "stdout" | "stderr") => void, signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const request = http.request({
        socketPath: this.socketPath,
        path: `/${this.apiVersion}/containers/${id}/logs?follow=1&stdout=1&stderr=1`,
        method: "GET",
      }, (response) => {
        let buffer = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          buffer += chunk;
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            const frame = splitMultiplexFrame(line);
            onLine(frame.text, frame.stream);
          }
        });
        response.on("end", () => {
          if (buffer) {
            const frame = splitMultiplexFrame(buffer);
            onLine(frame.text, frame.stream);
          }
          resolve();
        });
        response.on("error", reject);
      });
      request.on("error", (error) => reject(new Error(`Docker logs failed: ${error.message}`)));
      const onAbort = () => request.destroy(new Error("aborted"));
      signal?.addEventListener("abort", onAbort, { once: true });
      request.on("close", () => signal?.removeEventListener("abort", onAbort));
      request.end();
    });
  }
}

/**
 * Docker's multiplexed log stream prefixes each frame with an 8 byte header on
 * non-TTY containers; strip it so callers see plain lines.
 */
function splitMultiplexFrame(line: string): { stream: "stdout" | "stderr"; text: string } {
  if (line.length > 8 && /^[\x00-\x02][\x00\x01\x02]/.test(line)) {
    return { stream: line.charCodeAt(0) === 2 ? "stderr" : "stdout", text: line.slice(8) };
  }
  return { stream: "stdout", text: line };
}
