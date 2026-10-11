import path from 'node:path';
import fs from 'node:fs/promises';
import { nanoid } from 'nanoid';
import sharp, { type OutputInfo } from 'sharp';
import { PDFDocument } from 'pdf-lib';
import { pathToFileURL } from 'node:url';
import { config } from './config.js';
import { bins, capabilities } from './tools.js';
import { HttpError, childEnv, rmrf, runProcess, Semaphore } from './util.js';
import type { Kind } from './validate.js';

const conversionSlots = new Semaphore(config.maxConcurrentConversions);

const A4 = { w: 595.276, h: 841.89 };
const IMAGE_MARGIN = 18;
const MAX_IMAGE_SIDE = 3508; // ~A4 at 300 dpi

export interface Converted { pdfPath: string; pageCount: number }

/** Opens a PDF defensively and returns its page count. Rejects encrypted / corrupt files. */
export async function inspectPdf(pdfPath: string): Promise<number> {
  const bytes = await fs.readFile(pdfPath);
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(bytes, { ignoreEncryption: false, updateMetadata: false, throwOnInvalidObject: false });
  } catch (e) {
    const msg = e instanceof Error ? e.message : '';
    if (/encrypt/i.test(msg)) throw new HttpError(422, 'This PDF is password-protected. Remove the password and upload it again.');
    throw new HttpError(422, 'This PDF is damaged or not a valid PDF file.');
  }
  let n: number;
  try {
    n = doc.getPageCount();
  } catch {
    throw new HttpError(422, 'This PDF is damaged or not a valid PDF file.');
  }
  if (n === 0) throw new HttpError(422, 'This PDF has no pages.');
  if (n > config.maxPages) throw new HttpError(422, `This file has ${n} pages; the limit is ${config.maxPages}.`);
  return n;
}

async function imageToPdf(srcPath: string, outPath: string): Promise<void> {
  let result: { data: Buffer; info: OutputInfo };
  try {
    result = await sharp(srcPath, { limitInputPixels: config.maxImagePixels, failOn: 'error' })
      .rotate() // honour EXIF orientation
      .flatten({ background: '#ffffff' })
      .resize({ width: MAX_IMAGE_SIDE, height: MAX_IMAGE_SIDE, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 88 })
      .toBuffer({ resolveWithObject: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : '';
    if (/pixel limit/i.test(msg)) throw new HttpError(422, 'This image is too large to process.');
    throw new HttpError(422, 'This image is damaged or cannot be read.');
  }
  const { data, info } = result;
  const doc = await PDFDocument.create({ updateMetadata: false });
  const img = await doc.embedJpg(data);
  const landscape = info.width > info.height;
  const pw = landscape ? A4.h : A4.w;
  const ph = landscape ? A4.w : A4.h;
  const page = doc.addPage([pw, ph]);
  const scale = Math.min((pw - 2 * IMAGE_MARGIN) / info.width, (ph - 2 * IMAGE_MARGIN) / info.height);
  const w = info.width * scale;
  const h = info.height * scale;
  page.drawImage(img, { x: (pw - w) / 2, y: (ph - h) / 2, width: w, height: h });
  await fs.writeFile(outPath, await doc.save());
}

/** A throw-away LibreOffice home (user profile + font cache) produced once at start-up. Each conversion gets its own
 *  private copy, so jobs stay isolated and nothing here is ever used live. Null until the warm-up has finished. */
let warmHome: string | null = null;

const LO_FLAGS = ['--headless', '--norestore', '--nolockcheck', '--nodefault', '--nologo', '--nofirststartwizard'];

/** Runs one tiny throw-away conversion so LibreOffice generates its profile, then keeps that folder as a template.
 *  Runs in the background; until it finishes conversions use a fresh profile exactly as before. */
export async function warmOfficeProfile(): Promise<void> {
  if (!capabilities.office) return;
  const t0 = Date.now();
  const home = path.join(config.dataDir, 'lo-template');
  const profile = path.join(home, 'profile');
  const work = path.join(config.dataDir, `lo-warmup-${nanoid(6)}`);
  try {
    await rmrf(home);
    await fs.mkdir(home, { recursive: true });
    await fs.mkdir(work, { recursive: true });
    const src = path.join(work, 'warmup.txt');
    await fs.writeFile(src, 'warm-up');
    const res = await runProcess(
      bins.soffice,
      [`-env:UserInstallation=${pathToFileURL(profile).href}`, ...LO_FLAGS, '--convert-to', 'pdf', '--outdir', work, src],
      { timeoutMs: config.conversionTimeoutMs, cwd: work, env: childEnv({ HOME: home, USERPROFILE: home }) },
    );
    const produced = await fs.stat(path.join(work, 'warmup.pdf')).then(() => true, () => false);
    const hasProfile = await fs.stat(path.join(profile, 'user')).then(() => true, () => false);
    if (res.spawnFailed || res.timedOut || !produced || !hasProfile) {
      await rmrf(home);
      console.log(`[info] LibreOffice warm-up failed after ${Date.now() - t0} ms; conversions will use a fresh profile each time`);
      return;
    }
    warmHome = home;
    console.log(`[info] LibreOffice profile warm-up took ${Date.now() - t0} ms`);
  } catch (e) {
    console.log(`[info] LibreOffice warm-up error: ${e instanceof Error ? e.message : String(e)}`);
    await rmrf(home).catch(() => undefined);
  } finally {
    await rmrf(work).catch(() => undefined);
  }
}

async function officeToPdf(srcPath: string, outPath: string, workDir: string): Promise<void> {
  if (!capabilities.office) {
    throw new HttpError(422, 'Word, Excel and PowerPoint files cannot be converted because LibreOffice is not installed on this server. Convert the file to PDF first, or ask the administrator to install LibreOffice.');
  }
  const jobDir = path.join(workDir, `lo-${nanoid(10)}`);
  const profile = path.join(jobDir, 'profile');
  const outDir = path.join(jobDir, 'out');
  await fs.mkdir(jobDir, { recursive: true });
  if (warmHome) {
    // Private copy of the pre-generated profile; falls back to an empty profile if the copy fails.
    await fs.cp(warmHome, jobDir, { recursive: true }).catch(() => undefined);
  }
  await fs.mkdir(outDir, { recursive: true });
  try {
    const res = await runProcess(
      bins.soffice,
      [
        `-env:UserInstallation=${pathToFileURL(profile).href}`,
        ...LO_FLAGS,
        '--convert-to', 'pdf',
        '--outdir', outDir,
        srcPath,
      ],
      { timeoutMs: config.conversionTimeoutMs, cwd: jobDir, env: childEnv({ HOME: jobDir, USERPROFILE: jobDir }) },
    );
    if (res.spawnFailed) throw new HttpError(422, 'LibreOffice could not be started on this server, so this document could not be converted. Check the server log.');
    if (res.timedOut) throw new HttpError(422, 'Converting this document took too long and was stopped. It may be too large or complex.');
    const produced = (await fs.readdir(outDir)).find((f) => f.toLowerCase().endsWith('.pdf'));
    if (!produced) throw new HttpError(422, 'This document could not be converted. It may be corrupted or password-protected.');
    await fs.rename(path.join(outDir, produced), outPath);
  } finally {
    await rmrf(jobDir);
  }
}

export function convertToPdf(srcPath: string, kind: Kind, sessionDir: string, fileId: string): Promise<Converted> {
  return conversionSlots.run(async () => {
    const t0 = Date.now();
    const sizeKb = await fs.stat(srcPath).then((s) => Math.round(s.size / 1000), () => 0);
    let outcome = 'ok';
    try {
      if (kind === 'pdf') return { pdfPath: srcPath, pageCount: await inspectPdf(srcPath) };
      const outPath = path.join(sessionDir, 'converted', `${fileId}.pdf`);
      if (kind === 'image') await imageToPdf(srcPath, outPath);
      else await officeToPdf(srcPath, outPath, path.join(sessionDir, 'work'));
      try {
        return { pdfPath: outPath, pageCount: await inspectPdf(outPath) };
      } catch (e) {
        await rmrf(outPath);
        throw e;
      }
    } catch (e) {
      outcome = 'failed';
      throw e;
    } finally {
      // Kind, size and time only: never file names or contents.
      console.log(`[info] convert kind=${kind} size_kb=${sizeKb} ms=${Date.now() - t0} result=${outcome}`);
    }
  });
}
