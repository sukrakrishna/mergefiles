import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';

/** Resolved absolute paths of the external programs (or the bare name when not found). */
export const bins = { soffice: 'soffice', gs: 'gs', qpdf: 'qpdf' };
export interface Capabilities { office: boolean; imageCompression: boolean; losslessOptimize: boolean }
export const capabilities: Capabilities = { office: false, imageCompression: false, losslessOptimize: false };

const isWin = process.platform === 'win32';
const isMac = process.platform === 'darwin';

async function isFile(p: string): Promise<boolean> {
  try { return (await fs.stat(p)).isFile(); } catch { return false; }
}

async function onPath(name: string): Promise<string | null> {
  const exts = isWin ? ['', ...(process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').map((e) => e.toLowerCase())] : [''];
  for (const dir of (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const full = path.join(dir.replace(/^"|"$/g, ''), name + ext);
      if (await isFile(full)) return full;
    }
  }
  return null;
}

async function dirs(parent: string, prefix: RegExp): Promise<string[]> {
  try {
    return (await fs.readdir(parent)).filter((d) => prefix.test(d)).sort().reverse().map((d) => path.join(parent, d));
  } catch { return []; }
}

async function windowsCandidates(tool: 'soffice' | 'gs' | 'qpdf'): Promise<string[]> {
  const roots = [process.env.ProgramFiles ?? 'C:\\Program Files', process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', process.env.ProgramW6432 ?? ''].filter(Boolean);
  const out: string[] = [];
  for (const root of roots) {
    if (tool === 'soffice') out.push(path.join(root, 'LibreOffice', 'program', 'soffice.exe'));
    if (tool === 'gs') for (const d of await dirs(path.join(root, 'gs'), /^gs\d/i)) out.push(path.join(d, 'bin', 'gswin64c.exe'), path.join(d, 'bin', 'gswin32c.exe'));
    if (tool === 'qpdf') for (const d of await dirs(root, /^qpdf/i)) out.push(path.join(d, 'bin', 'qpdf.exe'));
  }
  return out;
}

async function locate(tool: 'soffice' | 'gs' | 'qpdf', override: string): Promise<string | null> {
  if (override) {
    if (path.isAbsolute(override)) return (await isFile(override)) ? override : null;
    return onPath(override);
  }
  const names = { soffice: ['soffice', 'libreoffice'], gs: ['gs', 'gswin64c', 'gswin32c'], qpdf: ['qpdf'] }[tool];
  for (const n of names) { const p = await onPath(n); if (p) return p; }
  const extra: string[] = [];
  if (isWin) extra.push(...(await windowsCandidates(tool)));
  if (isMac && tool === 'soffice') extra.push('/Applications/LibreOffice.app/Contents/MacOS/soffice');
  if (isMac && (tool === 'gs' || tool === 'qpdf')) extra.push(`/opt/homebrew/bin/${tool}`, `/usr/local/bin/${tool}`);
  for (const p of extra) if (await isFile(p)) return p;
  return null;
}

const HELP: Record<string, string> = {
  soffice: 'Install LibreOffice (https://www.libreoffice.org/download) or set SOFFICE_BIN to the full path of soffice. Word, Excel and PowerPoint files cannot be converted without it.',
  gs: 'Install Ghostscript (https://ghostscript.com/releases) or set GS_BIN to the full path (gswin64c.exe on Windows). Without it, only lossless size optimisation is available.',
  qpdf: 'Install qpdf (https://github.com/qpdf/qpdf/releases) or set QPDF_BIN. Optional: used for lossless size optimisation.',
};

/** Finds the external tools once at startup and logs what is available. */
export async function detectTools(): Promise<void> {
  const [so, gs, qp] = await Promise.all([locate('soffice', config.sofficeBin), locate('gs', config.gsBin), locate('qpdf', config.qpdfBin)]);
  if (so) bins.soffice = so;
  if (gs) bins.gs = gs;
  if (qp) bins.qpdf = qp;
  capabilities.office = !!so;
  capabilities.imageCompression = !!gs;
  capabilities.losslessOptimize = !!qp;
  console.log('External tools:');
  for (const [name, found] of [['soffice', so], ['gs', gs], ['qpdf', qp]] as const) {
    console.log(`  ${found ? 'OK     ' : 'MISSING'} ${name.padEnd(8)} ${found ?? ''}`);
    if (!found) console.warn(`           -> ${HELP[name]}`);
  }
}
