import path from 'node:path';

const num = (v: string | undefined, d: number): number => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : d;
};

const MB = 1_000_000;

/** CORS_ORIGIN: one origin or a comma-separated list (e.g. production + preview URLs). Trailing slashes are ignored. */
const origins = (v: string | undefined): string[] =>
  (v ?? '').split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean);

/** TRUST_PROXY: hop count (1 = one reverse proxy), or 'true'/'false', or an Express subnet name/list. Unset = 0. */
const trustProxy = (v: string | undefined): number | boolean | string => {
  const s = (v ?? '').trim();
  if (!s || s === '0' || s.toLowerCase() === 'false') return 0;
  if (/^\d+$/.test(s)) return Number(s);
  if (s.toLowerCase() === 'true') return true;
  return s;
};

export const config = {
  port: num(process.env.PORT, 3001),
  dataDir: path.resolve(process.env.DATA_DIR ?? path.join(process.cwd(), 'data')),
  clientDist: path.resolve(process.env.CLIENT_DIST ?? path.join(process.cwd(), '..', 'client', 'dist')),
  corsOrigins: origins(process.env.CORS_ORIGIN),
  trustProxy: trustProxy(process.env.TRUST_PROXY),

  // Upload / resource limits (all configurable)
  maxFileBytes: num(process.env.MAX_FILE_MB, 50) * MB,
  maxFiles: num(process.env.MAX_FILES, 20),
  maxTotalBytes: num(process.env.MAX_TOTAL_MB, 200) * MB,
  maxPages: num(process.env.MAX_PAGES, 500),
  maxSessions: num(process.env.MAX_SESSIONS, 200),
  maxImagePixels: num(process.env.MAX_IMAGE_MEGAPIXELS, 100) * 1_000_000,

  // Retention: sessions (and every file in them) are deleted this long after last activity
  sessionTtlMs: num(process.env.SESSION_TTL_MIN, 30) * 60_000,
  sweepIntervalMs: num(process.env.SWEEP_INTERVAL_SEC, 60) * 1000,

  // Process limits
  conversionTimeoutMs: num(process.env.CONVERSION_TIMEOUT_SEC, 90) * 1000,
  compressTimeoutMs: num(process.env.COMPRESS_TIMEOUT_SEC, 180) * 1000,
  maxConcurrentConversions: num(process.env.MAX_CONCURRENT_CONVERSIONS, 2),
  maxConcurrentExports: num(process.env.MAX_CONCURRENT_EXPORTS, 2),

  // Rate limiting (per IP, per window)
  rateLimitWindowMs: num(process.env.RATE_LIMIT_WINDOW_MIN, 15) * 60_000,
  rateLimitMax: num(process.env.RATE_LIMIT_MAX, 3000),
  rateLimitHeavyMax: num(process.env.RATE_LIMIT_HEAVY_MAX, 300),

  // External binaries
  sofficeBin: process.env.SOFFICE_BIN ?? '', // empty = auto-detect
  gsBin: process.env.GS_BIN ?? '',
  qpdfBin: process.env.QPDF_BIN ?? '',
} as const;

/** Sizes are decimal everywhere (1 KB = 1000 bytes, 1 MB = 1,000,000 bytes), so a file that meets
 *  the target also meets it on portals that count in binary units. */
export const KB = 1000;
export { MB };
