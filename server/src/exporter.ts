import fs from 'node:fs/promises';
import path from 'node:path';
import { nanoid } from 'nanoid';
import { config } from './config.js';
import { capabilities } from './tools.js';
import { HttpError, rmrf, safeStem, Semaphore } from './util.js';
import { buildLayout, type Paper, type PageSpec, type Orient, type Rotation } from './layout.js';
import { compressPdf, type Mode } from './compress.js';
import type { ExportResult, JobState, Session } from './sessions.js';

const exportSlots = new Semaphore(config.maxConcurrentExports);

export interface ExportRequest {
  pages: PageSpec[];
  paper: Paper;
  fitToPage: boolean;
  filename: string;
  target: { bytes: number; mode: Mode } | null;
}

const ROTATIONS = new Set([0, 90, 180, 270]);
const ORIENTS = new Set(['auto', 'portrait', 'landscape']);
const PAPERS = new Set(['original', 'a4', 'a3']);
const MODES = new Set(['high', 'balanced', 'smallest']);
const MIN_TARGET_BYTES = 5_000;
const MAX_TARGET_BYTES = 1_000_000_000;

/** Validates the untrusted request body against the merged document. */
export function parseExportRequest(body: unknown, pageCount: number): ExportRequest {
  const b = (body ?? {}) as Record<string, unknown>;
  if (!Array.isArray(b.pages) || b.pages.length === 0) throw new HttpError(400, 'There are no pages to export. Keep at least one page.');
  if (b.pages.length > config.maxPages) throw new HttpError(400, `Too many pages (limit ${config.maxPages}).`);
  const pages: PageSpec[] = b.pages.map((raw) => {
    const p = (raw ?? {}) as Record<string, unknown>;
    if (!Number.isInteger(p.src) || (p.src as number) < 0 || (p.src as number) >= pageCount) throw new HttpError(400, 'Invalid page reference.');
    if (!ROTATIONS.has(p.rotation as number)) throw new HttpError(400, 'Invalid rotation.');
    if (!ORIENTS.has(p.orientation as string)) throw new HttpError(400, 'Invalid orientation.');
    return { src: p.src as number, rotation: p.rotation as Rotation, orientation: p.orientation as Orient };
  });
  if (!PAPERS.has(b.paper as string)) throw new HttpError(400, 'Invalid paper size.');

  let target: ExportRequest['target'] = null;
  if (b.target != null) {
    const t = b.target as Record<string, unknown>;
    const bytes = Number(t.bytes);
    if (!Number.isFinite(bytes) || bytes < MIN_TARGET_BYTES || bytes > MAX_TARGET_BYTES) {
      throw new HttpError(400, 'Enter a target size between 5 KB and 1000 MB.');
    }
    if (!MODES.has(t.mode as string)) throw new HttpError(400, 'Invalid compression mode.');
    target = { bytes: Math.floor(bytes), mode: t.mode as Mode };
  }
  return {
    pages,
    paper: b.paper as Paper,
    fitToPage: b.fitToPage !== false,
    filename: `${safeStem(b.filename)}.pdf`,
    target,
  };
}

const fmt = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)} MB` : `${(n / 1000).toFixed(1)} KB`);

function startJob(session: Session): JobState {
  const job: JobState = { id: nanoid(12), status: 'running', stage: 'Queued', log: [] };
  session.job = job;
  return job;
}

/** Starts an export in the background. Progress is real: `stage` always names the step currently executing. */
export function startExport(session: Session, req: ExportRequest): JobState {
  if (!session.merged) throw new HttpError(409, 'Merge your files first.');
  if (session.job?.status === 'running') throw new HttpError(409, 'An export is already running for this session.');
  const merged = session.merged;
  const job = startJob(session);
  const setStage = (s: string) => { job.stage = s; job.log.push(s); };

  void exportSlots
    .run(async () => {
      const work = path.join(session.dir, 'work', `export-${job.id}`);
      await fs.mkdir(work, { recursive: true });
      try {
        setStage('Building pages (rotation, paper size, orientation)');
        const built = await buildLayout(merged.path, { pages: req.pages, paper: req.paper, fitToPage: req.fitToPage, title: req.filename.replace(/\.pdf$/, '') });
        const outcome = await compressPdf(built.bytes, work, req.target, setStage);

        setStage('Saving final PDF');
        const outPath = path.join(session.dir, `output-${job.id}.pdf`);
        await fs.writeFile(outPath, outcome.bytes);
        if (session.output) await fs.rm(session.output.path, { force: true });
        session.output = { path: outPath, filename: req.filename };

        const finalSize = outcome.bytes.byteLength;
        const uniq = new Set(built.orientations);
        const orientationLabel = uniq.size > 1 ? 'Mixed (per page)' : uniq.has('landscape') ? 'Landscape' : 'Portrait';
        const sizeKeys = new Set(built.sizes.map(([w, h]) => `${Math.round(w)}x${Math.round(h)}`));
        const paperLabel = req.paper === 'a4' ? 'A4' : req.paper === 'a3' ? 'A3' : sizeKeys.size > 1 ? 'Original (sizes vary by page)' : 'Original';

        const suggestions: string[] = [];
        let suggestedTargetBytes: number | null = null;
        let message: string;
        if (!req.target) {
          message = `Your PDF is ready (${fmt(finalSize)}).`;
        } else if (outcome.targetMet) {
          message = outcome.rasterized
            ? `Target met: the final file is ${fmt(finalSize)}, within your ${fmt(req.target.bytes)} limit. This file had too little image data to shrink any other way, so its pages were converted to images: text is no longer selectable or searchable.`
            : outcome.performed
            ? `Target met: the final file is ${fmt(finalSize)}, within your ${fmt(req.target.bytes)} limit.`
            : `Target met: the file was already within your ${fmt(req.target.bytes)} limit, so image quality was not reduced.`;
        } else {
          message = `The target of ${fmt(req.target.bytes)} could not be reached. The smallest result at this setting is ${fmt(finalSize)}.`;
          const step = finalSize < 1_000_000 ? 10_000 : 50_000;
          suggestedTargetBytes = Math.ceil(finalSize / step) * step;
          if (!capabilities.imageCompression) suggestions.push('Image compression is not available on this server (Ghostscript is not installed), so only lossless optimisation was applied.');
          suggestions.push(`Increase the target to at least ${fmt(suggestedTargetBytes)}.`);
          if (req.target.mode !== 'smallest') suggestions.push(`Try the ${req.target.mode === 'high' ? 'Balanced or Smallest Size' : 'Smallest Size'} mode, which compresses images more aggressively.`);
          else suggestions.push(outcome.rasterized
            ? 'Even with pages converted to images this is the smallest result at readable quality. Remove pages or raise the target.'
            : 'Remove pages or large scanned images; this file is already at the strongest compression this tool applies.');
        }

        const result: ExportResult = {
          filename: req.filename,
          finalSize,
          originalSize: merged.originalSize,
          layoutSize: built.bytes.byteLength,
          reductionPercent: merged.originalSize > 0 && finalSize < merged.originalSize ? Math.round((1 - finalSize / merged.originalSize) * 1000) / 10 : null,
          pageCount: req.pages.length,
          paperLabel,
          orientationLabel,
          target: req.target ? { bytes: req.target.bytes, mode: req.target.mode } : null,
          targetMet: outcome.targetMet,
          compression: { performed: outcome.performed, lossless: outcome.lossless, rasterized: outcome.rasterized, settings: outcome.settings, attempts: outcome.attempts },
          message,
          suggestions,
          suggestedTargetBytes,
        };
        job.result = result;
        job.status = 'done';
        job.stage = 'Done';
      } catch (e) {
        job.status = 'error';
        job.stage = 'Failed';
        job.error = e instanceof HttpError ? e.message : 'Something went wrong while building your PDF. Please try again.';
        if (!(e instanceof HttpError)) console.error('export failed', e);
      } finally {
        await rmrf(work);
      }
    })
    .catch((e) => {
      job.status = 'error';
      job.error = 'Something went wrong while building your PDF.';
      console.error(e);
    });
  return job;
}
