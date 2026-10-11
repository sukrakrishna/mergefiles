import path from 'node:path';
import fs from 'node:fs';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { config } from './config.js';
import { capabilities, detectTools } from './tools.js';
import { initStorage, startSweeper, sessionCount } from './sessions.js';
import { buildRouter, errorHandler } from './routes.js';

async function main() {
  await initStorage();
  startSweeper();

  const app = express();
  app.disable('x-powered-by');
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
  app.use(express.json({ limit: '1mb' }));

  app.get('/api/health', (_req, res) => res.json({ ok: true, sessions: sessionCount(), capabilities }));
  app.use('/api', buildRouter());
  app.use('/api', (_req, res) => { res.status(404).json({ error: 'Not found' }); });

  if (fs.existsSync(path.join(config.clientDist, 'index.html'))) {
    app.use(express.static(config.clientDist, { index: false, maxAge: '1h' }));
    app.get(/^(?!\/api\/).*/, (_req, res) => res.sendFile(path.join(config.clientDist, 'index.html')));
  }
  app.use(errorHandler);

  await detectTools();
  app.listen(config.port, () => console.log(`MergeAnyFile server listening on :${config.port}`));
}

main().catch((e) => { console.error(e); process.exit(1); });
