import path from 'node:path';
import fs from 'node:fs/promises';
import { Router, type Request, type Response, type NextFunction } from 'express';
import multer from 'multer';
import rateLimit from 'express-rate-limit';
import { nanoid } from 'nanoid';
import { config } from './config.js';
import { createSession, destroySession, getSession, type FileRec, type Session } from './sessions.js';
import { extensionOf, SUPPORTED_EXTENSIONS, validateUpload } from './validate.js';
import { convertToPdf } from './convert.js';
import { mergeSessionFiles } from './merge.js';
import { parseExportRequest, startExport } from './exporter.js';
import { HttpError, contentDisposition, rmrf, safeDisplayName } from './util.js';

const heavyLimiter = rateLimit({
  windowMs: config.rateLimitWindowMs,
  limit: config.rateLimitHeavyMax,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please wait a few minutes and try again.' },
});

type SessionRequest = Request & { session_: Session };
const wrap = (fn: (req: SessionRequest, res: Response) => Promise<void> | void) =>
  (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req as SessionRequest, res)).catch(next);
  };

const withSession = (req: Request, _res: Response, next: NextFunction) => {
  try {
    (req as SessionRequest).session_ = getSession(String(req.params.id));
    next();
  } catch (e) { next(e); }
};

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, _file, cb) => cb(null, path.join((req as SessionRequest).session_.dir, 'uploads')),
    // Random, extension-less names on disk: the user-supplied name is never used as a path.
    filename: (_req, _file, cb) => cb(null, `u${nanoid(16)}`),
  }),
  limits: { fileSize: config.maxFileBytes, files: config.maxFiles, fields: 5, parts: config.maxFiles + 5 },
});

const publicFile = (f: FileRec) => ({
  id: f.id, name: f.name, ext: f.ext, kind: f.kind, size: f.size, status: f.status, error: f.error ?? null, pageCount: f.pageCount ?? null,
});

const publicSession = (s: Session) => ({
  id: s.id,
  files: [...s.files.values()].map(publicFile),
  limits: {
    maxFileBytes: config.maxFileBytes, maxFiles: config.maxFiles, maxTotalBytes: config.maxTotalBytes, maxPages: config.maxPages,
    retentionMinutes: Math.round(config.sessionTtlMs / 60000), extensions: SUPPORTED_EXTENSIONS,
  },
});

function startConversion(session: Session, rec: FileRec): void {
  rec.status = 'converting';
  convertToPdf(rec.srcPath, rec.kind, session.dir, rec.id)
    .then(async (res) => {
      if (session.destroyed || !session.files.has(rec.id)) { // removed while converting
        if (res.pdfPath !== rec.srcPath) await rmrf(res.pdfPath);
        return;
      }
      rec.pdfPath = res.pdfPath;
      rec.pageCount = res.pageCount;
      rec.status = 'ready';
    })
    .catch((e) => {
      if (session.destroyed || !session.files.has(rec.id)) return; // removed or session deleted mid-conversion: nothing to report
      rec.status = 'error';
      rec.error = e instanceof HttpError ? e.message : 'This file could not be converted.';
      if (!(e instanceof HttpError)) console.error('conversion failed', e);
    });
}

export function buildRouter(): Router {
  const r = Router();

  r.post('/sessions', heavyLimiter, wrap(async (_req, res) => {
    const s = await createSession();
    res.status(201).json(publicSession(s));
  }));

  r.get('/sessions/:id', withSession, wrap((req, res) => {
    res.json(publicSession(req.session_));
  }));

  r.delete('/sessions/:id', withSession, wrap(async (req, res) => {
    await destroySession(req.session_.id);
    res.status(204).end();
  }));

  r.post('/sessions/:id/files', withSession, heavyLimiter, upload.array('files', config.maxFiles), wrap(async (req, res) => {
    const session = req.session_;
    const uploaded = (req.files as Express.Multer.File[] | undefined) ?? [];
    const accepted: FileRec[] = [];
    const rejected: Array<{ name: string; reason: string }> = [];

    let total = [...session.files.values()].reduce((n, f) => n + f.size, 0);
    for (const f of uploaded) {
      const name = safeDisplayName(Buffer.from(f.originalname, 'latin1').toString('utf8'));
      let reason: string | null = null;
      let kind: FileRec['kind'] | null = null;
      let ext = extensionOf(name);

      if (session.files.size + accepted.length >= config.maxFiles) reason = `You can add up to ${config.maxFiles} files.`;
      else if (total + f.size > config.maxTotalBytes) reason = `The total upload limit of ${Math.round(config.maxTotalBytes / 1e6)} MB would be exceeded.`;
      else {
        const v = await validateUpload(name, f.path, f.size);
        if (!v.ok) reason = v.reason;
        else { kind = v.kind; ext = v.ext; }
      }
      if (reason || !kind) {
        await rmrf(f.path);
        rejected.push({ name, reason: reason ?? 'Rejected.' });
        continue;
      }
      total += f.size;
      const rec: FileRec = { id: nanoid(10), name, ext, kind, size: f.size, status: 'queued', srcPath: f.path };
      session.files.set(rec.id, rec);
      accepted.push(rec);
    }
    accepted.forEach((rec) => startConversion(session, rec));
    res.status(202).json({ files: accepted.map(publicFile), rejected });
  }));

  r.delete('/sessions/:id/files/:fileId', withSession, wrap(async (req, res) => {
    const session = req.session_;
    const rec = session.files.get(String(req.params.fileId));
    if (!rec) throw new HttpError(404, 'File not found');
    session.files.delete(rec.id);
    await rmrf(rec.srcPath);
    if (rec.pdfPath && rec.pdfPath !== rec.srcPath) await rmrf(rec.pdfPath);
    res.status(204).end();
  }));

  r.post('/sessions/:id/merge', withSession, heavyLimiter, wrap(async (req, res) => {
    const order = (req.body as { order?: unknown })?.order;
    if (!Array.isArray(order) || !order.every((x) => typeof x === 'string')) throw new HttpError(400, 'Invalid file order.');
    const m = await mergeSessionFiles(req.session_, order);
    res.json({ version: m.version, pageCount: m.pageCount, size: m.size, originalSize: m.originalSize, pages: m.pages, url: `/api/sessions/${req.session_.id}/merged.pdf?v=${m.version}` });
  }));

  r.get('/sessions/:id/merged.pdf', withSession, wrap(async (req, res) => {
    const m = req.session_.merged;
    if (!m) throw new HttpError(404, 'Nothing merged yet.');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="preview.pdf"');
    res.setHeader('Cache-Control', 'private, no-store');
    res.sendFile(m.path);
  }));

  r.post('/sessions/:id/export', withSession, heavyLimiter, wrap((req, res) => {
    const merged = req.session_.merged;
    if (!merged) throw new HttpError(409, 'Merge your files first.');
    const parsed = parseExportRequest(req.body, merged.pageCount);
    const job = startExport(req.session_, parsed);
    res.status(202).json({ jobId: job.id });
  }));

  r.get('/sessions/:id/job', withSession, wrap((req, res) => {
    const job = req.session_.job;
    if (!job) throw new HttpError(404, 'No export has been started.');
    const base = `/api/sessions/${req.session_.id}`;
    res.json({
      id: job.id, status: job.status, stage: job.stage, log: job.log, error: job.error ?? null,
      result: job.result ? { ...job.result, previewUrl: `${base}/output.pdf?j=${job.id}`, downloadUrl: `${base}/download?j=${job.id}` } : null,
    });
  }));

  r.get('/sessions/:id/output.pdf', withSession, wrap((req, res) => {
    const out = req.session_.output;
    if (!out) throw new HttpError(404, 'No output available.');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', contentDisposition('inline', out.filename));
    res.setHeader('Cache-Control', 'private, no-store');
    res.sendFile(out.path);
  }));

  r.get('/sessions/:id/download', withSession, wrap((req, res) => {
    const out = req.session_.output;
    if (!out) throw new HttpError(404, 'No output available.');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', contentDisposition('attachment', out.filename));
    res.setHeader('Cache-Control', 'private, no-store');
    res.sendFile(out.path);
  }));

  return r;
}

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof HttpError) { res.status(err.status).json({ error: err.message }); return; }
  if (err instanceof multer.MulterError) {
    const msg =
      err.code === 'LIMIT_FILE_SIZE' ? `A file is larger than the ${Math.round(config.maxFileBytes / 1e6)} MB limit.` :
      err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_PART_COUNT' ? `You can upload up to ${config.maxFiles} files at a time.` :
      'The upload could not be processed.';
    res.status(413).json({ error: msg });
    return;
  }
  if ((err as { type?: string })?.type === 'entity.parse.failed') { res.status(400).json({ error: 'Invalid request.' }); return; }
  console.error(err);
  res.status(500).json({ error: 'Something went wrong. Please try again.' });
}

void fs;
