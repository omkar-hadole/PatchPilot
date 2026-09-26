import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface SandboxExecutionResult {
  command: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

export interface SandboxWorkspace {
  readonly id: string;
  readonly dir: string;
  exec(command: string, timeoutMs?: number): Promise<SandboxExecutionResult>;
  cleanup(): Promise<void>;
}

export interface SandboxProvider {
  createWorkspace(sessionId: string): Promise<SandboxWorkspace>;
}

export interface LocalSandboxConfig {
  rootDir?: string;
  defaultTimeoutMs?: number;
  maxOutputBytes?: number;
}

/**
 * Runs commands in a per-session temp directory on the host process, not a
 * containerized environment. This is a functional stand-in for PatchPilot's
 * Daytona-provisioned sandbox; swap this provider for a container/VM-backed
 * one (Daytona, Firecracker, Docker) before running against untrusted issues
 * in production, since it does not isolate network or filesystem access
 * outside the workspace directory.
 */
export class LocalSandboxProvider implements SandboxProvider {
  private readonly rootDir: string;
  private readonly defaultTimeoutMs: number;
  private readonly maxOutputBytes: number;

  constructor(config: LocalSandboxConfig = {}) {
    this.rootDir = config.rootDir ?? tmpdir();
    this.defaultTimeoutMs = config.defaultTimeoutMs ?? 60_000;
    this.maxOutputBytes = config.maxOutputBytes ?? 256 * 1024;
  }

  async createWorkspace(sessionId: string): Promise<SandboxWorkspace> {
    const dir = await mkdtemp(join(this.rootDir, `patchpilot-${sanitizeId(sessionId)}-`));
    const defaultTimeoutMs = this.defaultTimeoutMs;
    const maxOutputBytes = this.maxOutputBytes;

    return {
      id: sessionId,
      dir,
      async exec(command: string, timeoutMs = defaultTimeoutMs): Promise<SandboxExecutionResult> {
        return execInWorkspace(dir, command, timeoutMs, maxOutputBytes);
      },
      async cleanup() {
        await rm(dir, { recursive: true, force: true });
      }
    };
  }
}

function execInWorkspace(
  cwd: string,
  command: string,
  timeoutMs: number,
  maxOutputBytes: number
): Promise<SandboxExecutionResult> {
  return new Promise((resolvePromise) => {
    const startedAt = Date.now();
    const isUnix = process.platform !== "win32";
    const child = spawn("bash", ["-c", command], {
      cwd,
      env: { ...process.env, PATH: `${process.env.PATH ?? ""}` },
      detached: isUnix
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const finish = (result: SandboxExecutionResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(fallbackTimer);
      resolvePromise(result);
    };

    let fallbackTimer: NodeJS.Timeout | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (isUnix && child.pid) {
          process.kill(-child.pid, "SIGKILL");
        } else {
          child.kill("SIGKILL");
        }
      } catch {
        child.kill("SIGKILL");
      }
      fallbackTimer = setTimeout(() => {
        finish({
          command,
          exitCode: null,
          stdout: stdout.slice(0, maxOutputBytes),
          stderr: `${stderr}\nExecution timed out after ${timeoutMs}ms`.slice(0, maxOutputBytes),
          timedOut: true,
          durationMs: Date.now() - startedAt
        });
      }, 1000);
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length < maxOutputBytes) stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < maxOutputBytes) stderr += chunk.toString("utf8");
    });

    child.on("close", (exitCode) => {
      finish({
        command,
        exitCode,
        stdout: stdout.slice(0, maxOutputBytes),
        stderr: stderr.slice(0, maxOutputBytes),
        timedOut,
        durationMs: Date.now() - startedAt
      });
    });

    child.on("error", (error) => {
      finish({
        command,
        exitCode: null,
        stdout,
        stderr: `${stderr}\n${error.message}`,
        timedOut,
        durationMs: Date.now() - startedAt
      });
    });
  });
}

function sanitizeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 40);
}
