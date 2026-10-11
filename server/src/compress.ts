import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import { bins } from './tools.js';
import { PDFDocument } from 'pdf-lib';
import { runProcess } from './util.js';

export type Mode = 'high' | 'balanced' | 'smallest';

interface Rung { dpi: number; qfactor: number; quality: string }

/**
 * One shared ladder of image settings, ordered from mildest to strongest. Each mode owns a slice of it:
 * "High quality" never goes below 150 dpi, "Balanced" stays at or above 100 dpi, and "Smallest size"
 * may go all the way down. Within its slice we search for the MILDEST rung that meets the target, so image
 * quality is never reduced more than necessary. If even the strongest rung of the slice is too big, we say so
 * and suggest a stronger mode instead of silently degrading further.
 */
const LADDER: Rung[] = [
  { dpi: 300, qfactor: 0.15, quality: 'maximum' },
  { dpi: 250, qfactor: 0.2, quality: 'very high' },
  { dpi: 220, qfactor: 0.3, quality: 'very high' },
  { dpi: 200, qfactor: 0.35, quality: 'high' },
  { dpi: 175, qfactor: 0.4, quality: 'high' },
  { dpi: 150, qfactor: 0.5, quality: 'high' },
  { dpi: 130, qfactor: 0.6, quality: 'good' },
  { dpi: 120, qfactor: 0.76, quality: 'good' },
  { dpi: 110, qfactor: 0.76, quality: 'good' },
  { dpi: 100, qfactor: 0.9, quality: 'medium' },
  { dpi: 90, qfactor: 0.9, quality: 'medium' },
  { dpi: 72, qfactor: 1.1, quality: 'low' },
  { dpi: 60, qfactor: 1.3, quality: 'low' },
  { dpi: 48, qfactor: 1.6, quality: 'very low' },
];

/** Inclusive [mildest, strongest] index range of LADDER for each mode. */
export const MODE_RANGE: Record<Mode, [number, number]> = {
  high: [0, 5],
  balanced: [3, 9],
  smallest: [5, 13],
};

export interface Attempt { label: string; size: number }

export interface CompressOutcome {
  bytes: Uint8Array;
  attempts: Attempt[];
  performed: boolean; // whether any image recompression was applied to the returned file
  settings: string | null;
  targetMet: boolean | null; // null when no target was requested
  lossless: boolean; // whether only lossless optimization was used
  rasterized: boolean; // pages were turned into images (text no longer selectable / searchable)
}

async function qpdfOptimize(inPath: string, outPath: string): Promise<boolean> {
  const res = await runProcess(
    bins.qpdf,
    ['--object-streams=generate', '--compress-streams=y', '--recompress-flate', '--compression-level=9', '--remove-unreferenced-resources=yes', inPath, outPath],
    { timeoutMs: config.compressTimeoutMs },
  );
  // qpdf exits 3 when it succeeded with warnings.
  return (res.code === 0 || res.code === 3) && !res.timedOut;
}

async function ghostscript(inPath: string, outPath: string, rung: Rung): Promise<boolean> {
  const dict = `<< /QFactor ${rung.qfactor} /Blend 1 /HSamples [2 1 1 2] /VSamples [2 1 1 2] >>`;
  const res = await runProcess(
    bins.gs,
    [
      '-q', '-dSAFER', '-dBATCH', '-dNOPAUSE', '-dNOPROMPT',
      '-sDEVICE=pdfwrite', '-dCompatibilityLevel=1.5',
      '-dDownsampleColorImages=true', '-dDownsampleGrayImages=true', '-dDownsampleMonoImages=true',
      '-dColorImageDownsampleType=/Bicubic', '-dGrayImageDownsampleType=/Bicubic', '-dMonoImageDownsampleType=/Subsample',
      `-dColorImageResolution=${rung.dpi}`, `-dGrayImageResolution=${rung.dpi}`, '-dMonoImageResolution=300',
      '-dColorImageDownsampleThreshold=1.0', '-dGrayImageDownsampleThreshold=1.0',
      '-dAutoFilterColorImages=false', '-dAutoFilterGrayImages=false',
      '-dColorImageFilter=/DCTEncode', '-dGrayImageFilter=/DCTEncode',
      '-dDetectDuplicateImages=true', '-dCompressFonts=true', '-dSubsetFonts=true',
      `-sOutputFile=${outPath}`,
      '-c', `<< /ColorACSImageDict ${dict} /GrayACSImageDict ${dict} >> setdistillerparams`,
      '-f', inPath,
    ],
    { timeoutMs: config.compressTimeoutMs },
  );
  return res.code === 0 && !res.timedOut;
}

/**
 * Last resort for "Smallest Size" only: some PDFs (vector drawings, maps, CAD plans, heavy fonts) have little or no
 * image data, so image recompression cannot shrink them. We then render every page to a JPEG and rebuild the PDF from
 * those pictures. This always works for size, but text stops being selectable/searchable, so the result says so.
 */
interface RasterRung { dpi: number; q: number }
const RASTER_LADDER: RasterRung[] = [
  { dpi: 150, q: 70 }, { dpi: 130, q: 62 }, { dpi: 110, q: 55 }, { dpi: 90, q: 50 },
  { dpi: 72, q: 45 }, { dpi: 60, q: 40 }, { dpi: 54, q: 38 }, { dpi: 48, q: 35 },
];
const describeRaster = (r: RasterRung) => `pages converted to ${r.dpi} dpi images, JPEG quality ${r.q}`;

async function rasterize(inPath: string, workDir: string, rung: RasterRung, tag: string): Promise<Uint8Array | null> {
  const dir = path.join(workDir, `raster-${tag}`);
  await fs.mkdir(dir, { recursive: true });
  try {
    const res = await runProcess(
      bins.gs,
      [
        '-q', '-dSAFER', '-dBATCH', '-dNOPAUSE', '-dNOPROMPT', '-dUseCropBox',
        '-sDEVICE=jpeg', `-r${rung.dpi}`, `-dJPEGQ=${rung.q}`, '-dTextAlphaBits=4', '-dGraphicsAlphaBits=4',
        `-sOutputFile=${path.join(dir, 'p-%05d.jpg')}`, inPath,
      ],
      { timeoutMs: config.compressTimeoutMs },
    );
    if (res.code !== 0 || res.timedOut) return null;
    const src = await PDFDocument.load(await fs.readFile(inPath), { updateMetadata: false });
    const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.jpg')).sort();
    if (files.length !== src.getPageCount()) return null;
    const out = await PDFDocument.create({ updateMetadata: false });
    for (let i = 0; i < files.length; i++) {
      const page = src.getPage(i);
      const { width, height } = page.getCropBox();
      const sideways = page.getRotation().angle % 180 === 90;
      const [w, h] = sideways ? [height, width] : [width, height];
      const img = await out.embedJpg(await fs.readFile(path.join(dir, files[i])));
      out.addPage([w, h]).drawImage(img, { x: 0, y: 0, width: w, height: h });
    }
    out.setProducer('MergeAnyFile');
    out.setCreator('MergeAnyFile');
    return await out.save({ useObjectStreams: true });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

const describe = (r: Rung) => `images downsampled to ${r.dpi} dpi, ${r.quality} JPEG quality`;

export async function compressPdf(
  input: Uint8Array,
  workDir: string,
  target: { bytes: number; mode: Mode } | null,
  onStage: (stage: string) => void,
): Promise<CompressOutcome> {
  const inPath = path.join(workDir, 'layout.pdf');
  await fs.writeFile(inPath, input);
  const attempts: Attempt[] = [{ label: 'Before compression', size: input.byteLength }];

  // 1. Lossless structural optimization (never touches image quality).
  onStage('Optimizing PDF structure');
  let best: Uint8Array = input;
  const optPath = path.join(workDir, 'optimized.pdf');
  if (await qpdfOptimize(inPath, optPath)) {
    const opt = await fs.readFile(optPath);
    attempts.push({ label: 'Lossless optimization', size: opt.byteLength });
    if (opt.byteLength < best.byteLength) best = opt;
  }

  if (!target) return { bytes: best, attempts, performed: false, settings: null, targetMet: null, lossless: true, rasterized: false };

  // 2. Already small enough: leave image quality alone.
  if (best.byteLength <= target.bytes) {
    return { bytes: best, attempts, performed: false, settings: null, targetMet: true, lossless: true, rasterized: false };
  }

  // 3. Find the mildest image setting in this mode's range that meets the target. We first try the strongest
  //    setting (if that cannot meet the target nothing in the range can), then bisect towards the mildest one.
  const [lo0, hi0] = MODE_RANGE[target.mode];
  const bestInPath = path.join(workDir, 'best-lossless.pdf');
  await fs.writeFile(bestInPath, best);
  let attemptNo = 0;
  const tryRung = async (idx: number): Promise<Uint8Array | null> => {
    const rung = LADDER[idx];
    attemptNo++;
    onStage(`Compressing images (attempt ${attemptNo}: ${describe(rung)})`);
    const outPath = path.join(workDir, `gs-${idx}.pdf`);
    const ok = await ghostscript(bestInPath, outPath, rung);
    if (!ok) {
      attempts.push({ label: `Attempt ${attemptNo}: ${describe(rung)} (failed)`, size: 0 });
      return null;
    }
    const bytes = await fs.readFile(outPath);
    await fs.rm(outPath, { force: true });
    attempts.push({ label: `Attempt ${attemptNo}: ${describe(rung)}`, size: bytes.byteLength });
    return bytes;
  };

  let smallest: { bytes: Uint8Array; rung: Rung } | null = null;
  const strongest = await tryRung(hi0);
  if (strongest) smallest = { bytes: strongest, rung: LADDER[hi0] };

  if (strongest && strongest.byteLength <= target.bytes) {
    let chosen = { bytes: strongest, rung: LADDER[hi0] };
    let lo = lo0;
    let hi = hi0 - 1; // hi0 is already known to work
    while (lo <= hi) {
      const mid = Math.floor((lo + hi) / 2);
      const bytes = await tryRung(mid);
      if (bytes && bytes.byteLength <= target.bytes) { chosen = { bytes, rung: LADDER[mid] }; hi = mid - 1; }
      else lo = mid + 1;
    }
    smallest = chosen;
  }

  // Best result so far from image recompression (or the lossless file if recompression did not help).
  let cand: { bytes: Uint8Array; settings: string | null; performed: boolean; lossless: boolean } =
    smallest && smallest.bytes.byteLength < best.byteLength
      ? { bytes: smallest.bytes, settings: describe(smallest.rung), performed: true, lossless: false }
      : { bytes: best, settings: null, performed: false, lossless: true };

  // 4. Smallest Size only: if the target is still not met, turn pages into images (see RASTER_LADDER).
  if (target.mode === 'smallest' && cand.bytes.byteLength > target.bytes) {
    let rn = 0;
    const tryRaster = async (idx: number): Promise<Uint8Array | null> => {
      const rung = RASTER_LADDER[idx];
      rn++;
      onStage(`Image recompression was not enough: converting pages to images (attempt ${rn}: ${rung.dpi} dpi)`);
      const bytes = await rasterize(bestInPath, workDir, rung, String(idx));
      attempts.push({ label: `Last resort ${rn}: ${describeRaster(rung)}${bytes ? '' : ' (failed)'}`, size: bytes?.byteLength ?? 0 });
      return bytes;
    };
    const last = RASTER_LADDER.length - 1;
    const strongestRaster = await tryRaster(last);
    if (strongestRaster && strongestRaster.byteLength < cand.bytes.byteLength) {
      let chosen = { bytes: strongestRaster, idx: last };
      if (strongestRaster.byteLength <= target.bytes) {
        let lo = 0;
        let hi = last - 1;
        while (lo <= hi) {
          const mid = Math.floor((lo + hi) / 2);
          const bytes = await tryRaster(mid);
          if (bytes && bytes.byteLength <= target.bytes) { chosen = { bytes, idx: mid }; hi = mid - 1; }
          else lo = mid + 1;
        }
      }
      // Optional lossless polish of the rebuilt file.
      const rawPath = path.join(workDir, 'raster-final.pdf');
      const polPath = path.join(workDir, 'raster-final-opt.pdf');
      await fs.writeFile(rawPath, chosen.bytes);
      let finalBytes: Uint8Array = chosen.bytes;
      if (await qpdfOptimize(rawPath, polPath)) {
        const pol = await fs.readFile(polPath);
        if (pol.byteLength < finalBytes.byteLength) finalBytes = pol;
      }
      return {
        bytes: finalBytes,
        attempts,
        performed: true,
        settings: describeRaster(RASTER_LADDER[chosen.idx]),
        targetMet: finalBytes.byteLength <= target.bytes,
        lossless: false,
        rasterized: true,
      };
    }
  }

  return { bytes: cand.bytes, attempts, performed: cand.performed, settings: cand.settings, targetMet: cand.bytes.byteLength <= target.bytes, lossless: cand.lossless, rasterized: false };
}
