import path from 'node:path';
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';

/** Display-safe filename: no path parts, no control chars, bounded length. Never used to build disk paths. */
export function safeDisplayName(raw: string, fallback = 'file'): string {
  let name = path.basename(String(raw ?? '').replace(/\\/g, '/'));
  name = name.normalize('NFC').replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '_').trim();
  if (!name || name === '.' || name === '..') name = fallback;
  if (name.length > 120) {
    const ext = path.extname(name).slice(0, 10);
    name = name.slice(0, 120 - ext.length) + ext;
  }
  return name;
}

/** Output filename stem chosen by the user, reduced to a safe subset. */
export function safeStem(raw: unknown, fallback = 'merged_document'): string {
  let s = typeof raw === 'string' ? raw : '';
  s = s.replace(/\.pdf$/i, '').normalize('NFC').replace(/[^\p{L}\p{N} ._()-]/gu, '_').trim().replace(/^\.+/, '');
  if (!s) s = fallback;
  return s.slice(0, 80);
}

export function contentDisposition(type: 'attachment' | 'inline', filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${type}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

export async function rmrf(p: string): Promise<void> {
  await fs.rm(p, { recursive: true, force: true, maxRetries: 2 });
}

export class Semaphore {
  private waiters: Array<() => void> = [];
  private active = 0;
  constructor(private readonly limit: number) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) await new Promise<void>((res) => this.waiters.push(res));
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.waiters.shift()?.();
    }
  }
}

export interface RunResult { code: number | null; stdout: string; stderr: string; timedOut: boolean; spawnFailed: boolean }

const isWin = process.platform === 'win32';

/** Minimal environment for child processes. Windows programs need a few system variables to start at all. */
export function childEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, LANG: 'C.UTF-8', ...extra };
  if (isWin) for (const k of ['SystemRoot', 'windir', 'ComSpec', 'PATHEXT', 'TEMP', 'TMP']) if (process.env[k]) env[k] = process.env[k];
  return env;
}

function killTree(pid: number | undefined): void {
  if (!pid) return;
  try {
    if (isWin) spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    else process.kill(-pid, 'SIGKILL');
  } catch { /* already gone */ }
}

/** Runs a binary without a shell, with a hard timeout; kills the whole process tree on timeout. */
export function runProcess(
  bin: string,
  args: string[],
  opts: { timeoutMs: number; cwd?: string; env?: NodeJS.ProcessEnv },
): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, {
      cwd: opts.cwd,
      env: opts.env ?? childEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: !isWin, // own process group on POSIX so the whole tree can be killed
      windowsHide: true,
      shell: false,
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let spawnFailed = false;
    const cap = (s: string, chunk: Buffer) => (s.length < 20_000 ? s + chunk.toString() : s);
    child.stdout.on('data', (c: Buffer) => (stdout = cap(stdout, c)));
    child.stderr.on('data', (c: Buffer) => (stderr = cap(stderr, c)));
    const timer = setTimeout(() => { timedOut = true; killTree(child.pid); }, opts.timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      spawnFailed = true;
      resolve({ code: null, stdout, stderr: stderr + String(err), timedOut, spawnFailed });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (!isWin) killTree(child.pid);
      resolve({ code, stdout, stderr, timedOut, spawnFailed });
    });
  });
}

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}
