// Per-session execution sandbox.
//
// The durable harness, the SQLite databases and the orchestrator tools stay on the host, trusted. Only the
// untrusted capabilities are contained: `exec` runs in a Docker container that mounts only the declared roots,
// and every path-bearing FileSystem method is rejected unless its path resolves inside a root — symlinks
// included. The container drops all capabilities, reads no secrets, runs with a read-only root filesystem
// (only /tmp is writable) and is resource-capped.
//
// Disabled by default. Enable with DPI_SANDBOX=docker.
import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import type { Context } from "@earendil-works/chord";
import {
  err,
  ok,
  FileError,
  type BinaryReader,
  type DirReader,
  type FileInfo,
  type FileWatcher,
  type Result,
  type TextLineReader,
  type WatchChange,
  type WatchTarget,
} from "@earendil-works/pi-durable/env";

export type SandboxSettings = {
  enabled: boolean;
  image: string;
  network: string;
  cpus: string;
  memory: string;
  pids: number;
  /** Additional host roots mounted read-only, beyond the session working directory. */
  extraRoots: string[];
};

export const SANDBOX_OFF: SandboxSettings = {
  enabled: false,
  image: "",
  network: "none",
  cpus: "0",
  memory: "",
  pids: 0,
  extraRoots: [],
};

/** The wrapper script that turns a shell invocation into `docker exec` in the session's container. */
export const SANDBOX_SHELL = join(import.meta.dirname, "../scripts/sandbox-shell.sh");

/** The device's sandbox policy, read from the environment. Off unless DPI_SANDBOX=docker. */
export function sandboxSettings(env: NodeJS.ProcessEnv = process.env): SandboxSettings {
  return {
    enabled: (env.DPI_SANDBOX ?? "off").toLowerCase() === "docker",
    image: env.DPI_SANDBOX_IMAGE ?? "node:24-slim",
    network: env.DPI_SANDBOX_NETWORK ?? "none",
    cpus: env.DPI_SANDBOX_CPUS ?? "2",
    memory: env.DPI_SANDBOX_MEMORY ?? "2g",
    pids: Number(env.DPI_SANDBOX_PIDS ?? "512"),
    extraRoots: (env.DPI_SANDBOX_ROOTS ?? "")
      .split(":")
      .map((p) => p.trim())
      .filter(Boolean)
      .map((p) => resolve(p === "~" ? homedir() : p.startsWith("~/") ? join(homedir(), p.slice(2)) : p)),
  };
}

/** The environment the sandbox shell reads its container, mounts and limits from. Never carries a secret. */
export function sandboxShellEnv(input: {
  container: string;
  image: string;
  cwd: string;
  roots: string[];
  network: string;
  cpus: string;
  memory: string;
  pids: number;
  base?: NodeJS.ProcessEnv;
}): NodeJS.ProcessEnv {
  const mounts = input.roots.map((root, index) => `${root}:${root}${index === 0 ? "" : ":ro"}`).join("\n");
  return {
    ...(input.base ?? {}),
    DPI_SANDBOX_CONTAINER: input.container,
    DPI_SANDBOX_IMAGE: input.image,
    DPI_SANDBOX_WORKDIR: input.cwd,
    DPI_SANDBOX_MOUNTS: mounts,
    DPI_SANDBOX_NETWORK: input.network,
    DPI_SANDBOX_CPUS: input.cpus,
    DPI_SANDBOX_MEMORY: input.memory,
    DPI_SANDBOX_PIDS: String(input.pids),
  };
}

const runningOnCaseInsensitive = process.platform === "darwin" || process.platform === "win32";
const same = (a: string, b: string) => (runningOnCaseInsensitive ? a.toLowerCase() === b.toLowerCase() : a === b);

/** `~` and relative paths, resolved the way NodeExecutionEnv resolves them. */
function expandPath(cwd: string, path: string): string {
  let normalized = path;
  if (normalized === "~") normalized = homedir();
  else if (normalized.startsWith("~/")) normalized = join(homedir(), normalized.slice(2));
  return isAbsolute(normalized) ? resolve(normalized) : resolve(cwd, normalized);
}

function within(roots: string[], path: string): boolean {
  return roots.some((root) => {
    if (same(path, root)) return true;
    return same(path.slice(0, root.length + 1), root + sep);
  });
}

const canonical = (path: string): string => {
  try {
    return realpathSync(resolve(path));
  } catch {
    return resolve(path);
  }
};

export type SandboxEnvOptions = {
  cwd: string;
  /** Absolute host roots. The first is the writable working root; the rest are read-only. */
  roots: string[];
  shellPath: string;
  container: string;
  shellEnv?: NodeJS.ProcessEnv;
};

/**
 * A `NodeExecutionEnv` whose shell runs in a container and whose filesystem is confined to `roots`.
 *
 * Only the untrusted surface is overridden; read/write/edit and `exec` are checked here, while the durable
 * harness continues to use the host filesystem for its own state.
 */
export class SandboxExecutionEnv extends NodeExecutionEnv {
  private readonly roots: string[];
  private readonly tempRoot: string;
  readonly container: string;

  constructor(options: SandboxEnvOptions) {
    super({ cwd: options.cwd, shellPath: options.shellPath, shellEnv: options.shellEnv });
    if (!options.roots.length) throw Error("SandboxExecutionEnv needs at least one root");
    this.roots = options.roots.map(canonical);
    // Fail closed on overlapping roots. The shell mounts the writable root and then the read-only roots, so an
    // extra root that contains (or sits inside) the working root is mounted after it and silently shadows it:
    // the session can no longer write its own cwd. A startup error with the two paths is strictly better.
    const writable = this.roots[0]!;
    for (const extra of this.roots.slice(1)) {
      if (within([extra], writable) || within([writable], extra))
        throw Error(
          `Sandbox root overlaps the session working directory: ${extra} and ${writable} (use roots that do not contain one another)`,
        );
    }
    this.container = options.container;
    this.tempRoot = join(this.roots[0]!, ".dpi-tmp");
  }

  /** Admit a path only when its real location (following symlinks) is inside a root. */
  private async guard(path: string): Promise<Result<string, FileError>> {
    const abs = expandPath(this.cwd, path);
    if (await this.realAncestorWithin(abs)) return ok(abs);
    return err(new FileError("permission_denied", `Path is outside the sandbox roots: ${abs}`, path));
  }

  private async realAncestorWithin(abs: string): Promise<boolean> {
    let probe = abs;
    for (;;) {
      try {
        return within(this.roots, await realpath(probe));
      } catch {
        const parent = dirname(probe);
        if (parent === probe) return false;
        probe = parent;
      }
    }
  }

  async absolutePath(path: string, _context: Context): Promise<Result<string, FileError>> {
    return this.guard(path);
  }
  async canonicalPath(path: string, context: Context): Promise<Result<string, FileError>> {
    const g = await this.guard(path);
    return g.ok ? super.canonicalPath(g.value, context) : g;
  }
  async readTextFile(path: string, context: Context): Promise<Result<string, FileError>> {
    const g = await this.guard(path);
    return g.ok ? super.readTextFile(g.value, context) : g;
  }
  async openTextLineReader(path: string, context: Context): Promise<Result<TextLineReader, FileError>> {
    const g = await this.guard(path);
    return g.ok ? super.openTextLineReader(g.value, context) : g;
  }
  async readTextLines(
    path: string,
    options: { maxLines?: number } | undefined,
    context: Context,
  ): Promise<Result<string[], FileError>> {
    const g = await this.guard(path);
    return g.ok ? super.readTextLines(g.value, options, context) : g;
  }
  async readBinaryFile(path: string, context: Context): Promise<Result<Uint8Array, FileError>> {
    const g = await this.guard(path);
    return g.ok ? super.readBinaryFile(g.value, context) : g;
  }
  async openBinaryReader(
    path: string,
    options: { noFollow?: boolean } | undefined,
    context: Context,
  ): Promise<Result<BinaryReader, FileError>> {
    const g = await this.guard(path);
    return g.ok ? super.openBinaryReader(g.value, options, context) : g;
  }
  async writeFile(path: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>> {
    const g = await this.guard(path);
    return g.ok ? super.writeFile(g.value, content, context) : g;
  }
  async appendFile(path: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>> {
    const g = await this.guard(path);
    return g.ok ? super.appendFile(g.value, content, context) : g;
  }
  async truncateFile(path: string, size: number, context: Context): Promise<Result<void, FileError>> {
    const g = await this.guard(path);
    return g.ok ? super.truncateFile(g.value, size, context) : g;
  }
  async flushFile(path: string, context: Context): Promise<Result<void, FileError>> {
    const g = await this.guard(path);
    return g.ok ? super.flushFile(g.value, context) : g;
  }
  async renameFile(sourcePath: string, destinationPath: string, context: Context): Promise<Result<void, FileError>> {
    const source = await this.guard(sourcePath);
    if (!source.ok) return source;
    const destination = await this.guard(destinationPath);
    if (!destination.ok) return destination;
    return super.renameFile(source.value, destination.value, context);
  }
  async fileInfo(path: string, context: Context): Promise<Result<FileInfo, FileError>> {
    const g = await this.guard(path);
    return g.ok ? super.fileInfo(g.value, context) : g;
  }
  async listDir(path: string, context: Context): Promise<Result<FileInfo[], FileError>> {
    const g = await this.guard(path);
    return g.ok ? super.listDir(g.value, context) : g;
  }
  async openDirReader(path: string, context: Context): Promise<Result<DirReader, FileError>> {
    const g = await this.guard(path);
    return g.ok ? super.openDirReader(g.value, context) : g;
  }
  async exists(path: string, context: Context): Promise<Result<boolean, FileError>> {
    const g = await this.guard(path);
    return g.ok ? super.exists(g.value, context) : g;
  }
  async createDir(
    path: string,
    options: { recursive?: boolean } | undefined,
    context: Context,
  ): Promise<Result<void, FileError>> {
    const g = await this.guard(path);
    return g.ok ? super.createDir(g.value, options, context) : g;
  }
  async remove(
    path: string,
    options: { recursive?: boolean; force?: boolean } | undefined,
    context: Context,
  ): Promise<Result<void, FileError>> {
    const g = await this.guard(path);
    return g.ok ? super.remove(g.value, options, context) : g;
  }
  async watch(
    targets: readonly WatchTarget[],
    onChange: (change: WatchChange) => void,
    context: Context,
  ): Promise<Result<FileWatcher, FileError>> {
    const guarded: WatchTarget[] = [];
    for (const target of targets) {
      const g = await this.guard(target.path);
      if (!g.ok) return g;
      guarded.push({ ...target, path: g.value });
    }
    return super.watch(guarded, onChange, context);
  }
  async createTempDir(prefix: string | undefined, _context: Context): Promise<Result<string, FileError>> {
    try {
      await mkdir(this.tempRoot, { recursive: true });
      return ok(await mkdtemp(join(this.tempRoot, prefix ?? "tmp-")));
    } catch (e) {
      return err(new FileError("unknown", `Could not create a sandbox temp dir: ${(e as Error).message}`, this.tempRoot));
    }
  }
  async createTempFile(
    options: { prefix?: string; suffix?: string } | undefined,
    context: Context,
  ): Promise<Result<string, FileError>> {
    const dir = await this.createTempDir(options?.prefix, context);
    if (!dir.ok) return dir;
    const file = join(dir.value, `file${options?.suffix ?? ""}`);
    try {
      await writeFile(file, "", { flag: "wx" });
      return ok(file);
    } catch (e) {
      return err(new FileError("unknown", `Could not create a sandbox temp file: ${(e as Error).message}`, file));
    }
  }

  /** Stop the container this environment owns; a later command starts a fresh one. */
  async cleanup(context: Context): Promise<void> {
    await stopSandbox(this.container).catch(() => {});
    return super.cleanup(context);
  }
}

/** Remove a sandbox container, best-effort. Resolves whether or not it existed. */
export function stopSandbox(container: string): Promise<void> {
  return new Promise((done, fail) => {
    execFile(process.env.DPI_SANDBOX_DOCKER ?? "docker", ["rm", "-f", container], { timeout: 60_000 }, (error) =>
      error ? fail(error) : done(),
    );
  });
}
