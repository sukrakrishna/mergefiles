import path from 'node:path';
import fs from 'node:fs/promises';
import { nanoid } from 'nanoid';
import { config } from './config.js';
import { HttpError, rmrf } from './util.js';
import type { Kind } from './validate.js';

export type FileStatus = 'queued' | 'converting' | 'ready' | 'error';

export interface FileRec {
  id: string;
  name: string;
  ext: string;
  kind: Kind;
  size: number;
  status: FileStatus;
  error?: string;
  pageCount?: number;
  srcPath: string;
  pdfPath?: string;
}

export interface MergedPage { index: number; fileId: string; fileName: string; pageInFile: number }

export interface MergedInfo {
  path: string;
  size: number;
  originalSize: number;
  pageCount: number;
  pages: MergedPage[];
  version: number;
}

export interface JobState {
  id: string;
  status: 'running' | 'done' | 'error';
  stage: string;
  log: string[];
  result?: ExportResult;
  error?: string;
}

export interface ExportResult {
  filename: string;
  finalSize: number;
  originalSize: number;
  layoutSize: number;
  reductionPercent: number | null;
  pageCount: number;
  paperLabel: string;
  orientationLabel: string;
  target: { bytes: number; mode: string } | null;
  targetMet: boolean | null;
  compression: {
    performed: boolean;
    lossless: boolean;
    rasterized: boolean;
    settings: string | null;
    attempts: Array<{ label: string; size: number }>;
  };
  message: string;
  suggestions: string[];
  suggestedTargetBytes: number | null;
}

export interface Session {
  id: string;
  dir: string;
  createdAt: number;
  lastActive: number;
  files: Map<string, FileRec>;
  merged?: MergedInfo;
  job?: JobState;
  output?: { path: string; filename: string };
  destroyed?: boolean;
}

const SESSION_ID_RE = /^[A-Za-z0-9_-]{21}$/;
const sessions = new Map<string, Session>();
const sessionsRoot = () => path.join(config.dataDir, 'sessions');

export async function initStorage(): Promise<void> {
  // Anything left over from a previous run is orphaned (sessions live in memory), so wipe it.
  await rmrf(sessionsRoot());
  await fs.mkdir(sessionsRoot(), { recursive: true });
}

export async function createSession(): Promise<Session> {
  if (sessions.size >= config.maxSessions) throw new HttpError(503, 'The service is busy right now. Please try again in a few minutes.');
  const id = nanoid(21);
  const dir = path.join(sessionsRoot(), id);
  await fs.mkdir(path.join(dir, 'uploads'), { recursive: true });
  await fs.mkdir(path.join(dir, 'converted'), { recursive: true });
  await fs.mkdir(path.join(dir, 'work'), { recursive: true });
  const now = Date.now();
  const s: Session = { id, dir, createdAt: now, lastActive: now, files: new Map() };
  sessions.set(id, s);
  return s;
}

export function getSession(id: string): Session {
  if (!SESSION_ID_RE.test(id)) throw new HttpError(404, 'Session not found');
  const s = sessions.get(id);
  if (!s) throw new HttpError(404, 'This session has expired or does not exist. Please start again.');
  s.lastActive = Date.now();
  return s;
}

export async function destroySession(id: string): Promise<void> {
  const s = sessions.get(id);
  if (!s) return;
  s.destroyed = true;
  sessions.delete(id);
  await rmrf(s.dir);
}

export async function sweepExpired(): Promise<number> {
  const now = Date.now();
  let removed = 0;
  for (const s of [...sessions.values()]) {
    if (s.job?.status === 'running') continue;
    if (now - s.lastActive > config.sessionTtlMs) {
      await destroySession(s.id);
      removed++;
    }
  }
  return removed;
}

export function startSweeper(): NodeJS.Timeout {
  const t = setInterval(() => { sweepExpired().catch((e) => console.error('sweep failed', e)); }, config.sweepIntervalMs);
  t.unref();
  return t;
}

export const sessionCount = () => sessions.size;
