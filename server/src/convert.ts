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

async function officeToPdf(srcPath: string, outPath: string, workDir: string): Promise<void> {
  if (!capabilities.office) {
    throw new HttpError(422, 'Word, Excel and PowerPoint files cannot be converted because LibreOffice is not installed on this server. Convert the file to PDF first, or ask the administrator to install LibreOffice.');
  }
  const jobDir = path.join(workDir, `lo-${nanoid(10)}`);
  const profile = path.join(jobDir, 'profile');
  const outDir = path.join(jobDir, 'out');
  await fs.mkdir(outDir, { recursive: true });
  try {
    const res = await runProcess(
      bins.soffice,
      [
        `-env:UserInstallation=${pathToFileURL(profile).href}`,
        '--headless', '--norestore', '--nolockcheck', '--nodefault', '--nologo', '--nofirststartwizard',
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
  });
}
