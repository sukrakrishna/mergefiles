import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import compression from 'compression';
import rateLimit from 'express-rate-limit';
import { config } from './config.js';
import { capabilities, detectTools } from './tools.js';
import { initStorage, startSweeper, sessionCount } from './sessions.js';
import { buildRouter, errorHandler } from './routes.js';
import { warmOfficeProfile } from './convert.js';

const rssMb = () => Math.round(process.memoryUsage().rss / 1048576);
let shuttingDown = false;

process.on('uncaughtException', (err) => {
  console.error(`[fatal] uncaughtException (rss ${rssMb()} MB)`, err);
  process.exit(1); // state is unknown: let the platform restart a clean process
});
process.on('unhandledRejection', (reason) => {
  console.error(`[error] unhandledRejection (rss ${rssMb()} MB)`, reason instanceof Error ? reason.stack ?? reason : reason);
});

async function main() {
  console.log(`[info] startup rss ${rssMb()} MB, node ${process.version}`);
  await initStorage();
  startSweeper();

  const app = express();
  app.disable('x-powered-by');
  // During a redeploy ask clients to open a fresh connection instead of reusing one to the dying instance.
  app.use((_req, res, next) => { if (shuttingDown) res.setHeader('Connection', 'close'); next(); });
  app.set('trust proxy', config.trustProxy);
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'wasm-unsafe-eval'"],
        workerSrc: ["'self'", 'blob:'],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
        imgSrc: ["'self'", 'data:', 'blob:'],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
      },
    },
  }));
  if (config.corsOrigins.length) {
    // Exact-match allow-list. Handles preflight (OPTIONS) automatically; no cookies/credentials are used.
    app.use(cors({
      origin: (origin, cb) => cb(null, !origin || config.corsOrigins.includes(origin)),
      methods: ['GET', 'HEAD', 'POST', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type'],
      exposedHeaders: ['Content-Disposition', 'RateLimit', 'RateLimit-Policy', 'Retry-After'],
      maxAge: 600,
    }));
  }
  app.use(rateLimit({ windowMs: config.rateLimitWindowMs, limit: config.rateLimitMax, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many requests. Please slow down.' } }));
  // gzip/brotli for text responses only (HTML, JS, CSS, JSON, SVG). PDFs and other binaries are never recompressed.
  app.use(compression({
    filter: (_req, res) => /^(text\/|application\/(json|javascript)|image\/svg\+xml)/i.test(String(res.getHeader('Content-Type') ?? '')),
  }));
  // One log line per upload request: size, status, duration, error, and memory, so restarts/OOM are visible in the logs.
  app.use('/api/sessions/:id/files', (req, res, next) => {
    if (req.method !== 'POST') return next();
    const t0 = Date.now();
    const len = req.headers['content-length'] ?? '?';
    let logged = false;
    const line = (outcome: string) => {
      if (logged) return;
      logged = true;
      const err = res.locals.errorMessage ? ` error="${String(res.locals.errorMessage).slice(0, 200)}"` : '';
      console.log(`[upload] POST /api/sessions/:id/files ${outcome} content_length=${len} ms=${Date.now() - t0} ip=${req.ip} rss_mb=${rssMb()}${err}`);
    };
    res.on('finish', () => { line(`status=${res.statusCode}`); req.resume(); }); // resume: discard any unread body so proxies can finish sending
    res.on('close', () => { if (!res.writableFinished) line(`status=aborted bytes_received=${req.socket.bytesRead}`); });
    next();
  });
  app.use(express.json({ limit: '1mb' }));

  app.get('/api/health', (_req, res) => res.json({ ok: true, sessions: sessionCount(), capabilities }));
  app.use('/api', buildRouter());
  app.use('/api', (_req, res) => { res.status(404).json({ error: 'Not found' }); });

  if (fs.existsSync(path.join(config.clientDist, 'index.html'))) {
    const indexHtml = path.join(config.clientDist, 'index.html');
    app.use(express.static(config.clientDist, {
      index: false,
      maxAge: '1h',
      setHeaders: (res, file) => {
        // Vite fingerprints everything under /assets, so it can be cached forever; the HTML shell must always be revalidated.
        if (file.includes(`${path.sep}assets${path.sep}`)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        else if (file.endsWith('index.html')) res.setHeader('Cache-Control', 'no-cache');
      },
    }));
    app.get(/^(?!\/api\/).*/, (_req, res) => { res.setHeader('Cache-Control', 'no-cache'); res.sendFile(indexHtml); });
  }
  app.use(errorHandler);

  await detectTools();
  const cpus = os.availableParallelism();
  const limit = process.constrainedMemory();
  const mem = limit > 0 && limit < os.totalmem() ? `${Math.round(limit / 1048576)} MB (container limit)` : `${Math.round(os.totalmem() / 1048576)} MB (host total)`;
  console.log(`Resources: ${cpus} CPU${cpus === 1 ? '' : 's'}, memory ${mem}`);
  const server = app.listen(config.port, () => {
    console.log(`MergeAnyFile server listening on :${config.port}`);
    void warmOfficeProfile(); // background; conversions work (cold) while it runs
  });
  // Behind Render's load balancer the proxy reuses connections for longer than Node's 5 s default keep-alive, which causes
  // random connection resets/502s. Keep idle sockets open longer than the proxy does, and never cut off slow uploads.
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;
  server.requestTimeout = 0;

  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[info] ${signal}: no new connections; waiting up to 25 s for in-flight requests (rss ${rssMb()} MB)`);
    server.close(() => { console.log('[info] all connections closed, exiting'); process.exit(0); });
    server.closeIdleConnections();
    setTimeout(() => { console.log('[warn] shutdown grace period over, exiting'); process.exit(0); }, 25_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((e) => { console.error(e); process.exit(1); });
