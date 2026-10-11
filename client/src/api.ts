export interface FileInfo {
  id: string; name: string; ext: string; kind: string; size: number
  status: 'queued' | 'converting' | 'ready' | 'error'
  error: string | null; pageCount: number | null
}
export interface Limits { maxFileBytes: number; maxFiles: number; maxTotalBytes: number; maxPages: number; retentionMinutes: number; extensions: string[] }
export interface Capabilities { office: boolean; imageCompression: boolean; losslessOptimize: boolean }
export interface SessionInfo { id: string; files: FileInfo[]; limits: Limits }
export interface MergedPageRef { index: number; fileId: string; fileName: string; pageInFile: number }
export interface MergeResult { version: number; pageCount: number; size: number; originalSize: number; pages: MergedPageRef[]; url: string }
export interface ExportResult {
  filename: string; finalSize: number; originalSize: number; layoutSize: number; reductionPercent: number | null
  pageCount: number; paperLabel: string; orientationLabel: string
  target: { bytes: number; mode: string } | null; targetMet: boolean | null
  compression: { performed: boolean; lossless: boolean; rasterized: boolean; settings: string | null; attempts: { label: string; size: number }[] }
  message: string; suggestions: string[]; suggestedTargetBytes: number | null; previewUrl: string; downloadUrl: string
}
export interface JobInfo { id: string; status: 'running' | 'done' | 'error'; stage: string; log: string[]; error: string | null; result: ExportResult | null }
export interface ExportBody {
  pages: { src: number; rotation: number; orientation: string }[]
  paper: string; fitToPage: boolean; filename: string
  target: { bytes: number; mode: string } | null
}

export type FailKind =
  | 'offline' | 'unreadable' | 'timeout' | 'too-large' | 'rate-limited' | 'server-busy'
  | 'network' | 'rejected' | 'expired' | 'cancelled' | 'other'

export class ApiError extends Error {
  status: number
  kind: FailKind
  retryable: boolean
  constructor(message: string, status: number, kind: FailKind = 'other', retryable = false) {
    super(message)
    this.status = status
    this.kind = kind
    this.retryable = retryable
  }
}

/** Optional backend origin for split deployments (e.g. https://api.example.com). Empty = same origin. */
const RAW_BASE = String(import.meta.env.VITE_API_URL ?? '').trim().replace(/\/+$/, '')
/** A localhost base baked into a build that is served from a real host would make every call fail, so it is ignored there. */
const API_BASE = /^https?:\/\/(localhost|127\.|\[::1\])/i.test(RAW_BASE) && !/^(localhost|127\.|\[?::1)/.test(location.hostname) ? '' : RAW_BASE

/** Prefixes server-relative URLs ('/api/...') that the server returned (merged.pdf, output.pdf, download). Idempotent. */
export function apiUrl(url: string): string {
  return url.startsWith('/api/') ? API_BASE + url : url
}

async function request<T>(method: string, url: string, body?: unknown, form?: FormData): Promise<T> {
  let res: Response
  try {
    res = await fetch(apiUrl('/api' + url), {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: form ?? (body ? JSON.stringify(body) : undefined),
    })
  } catch {
    throw new ApiError('Cannot reach the server. Check your connection and try again.', 0)
  }
  if (res.status === 204) return undefined as T
  let data: unknown = null
  try { data = await res.json() } catch { /* empty */ }
  if (!res.ok) {
    const msg = (data as { error?: string } | null)?.error ?? `Request failed (${res.status}).`
    throw new ApiError(msg, res.status)
  }
  return data as T
}

export interface UploadResponse { files: FileInfo[]; rejected: { name: string; reason: string }[] }

export interface UploadOptions {
  onProgress?: (fraction: number) => void
  signal?: AbortSignal
  timeoutMs?: number
  maxFileMb?: number
  /** Called before each automatic retry (attempt is 1-based, of `maxRetries`). */
  onRetry?: (attempt: number, maxRetries: number, reason: ApiError) => void
}

const RETRY_DELAYS_MS = [1000, 3000, 7000]

/** Reads the picked file fully into memory. On Android, files from Drive/Photos/cloud providers are streamed lazily and
 *  can fail mid-upload with a generic network error; a memory copy removes that failure mode. */
export async function readIntoMemory(file: File): Promise<File> {
  try {
    const buf = await file.arrayBuffer()
    return new File([buf], file.name, { type: file.type, lastModified: file.lastModified })
  } catch (e) {
    console.error('[upload] could not read the picked file', { size: file.size, type: file.type, error: String(e) })
    throw new ApiError("Your phone couldn't read this file. Save it to your device storage and try again.", 0, 'unreadable')
  }
}

function connectionInfo(): Record<string, unknown> {
  const c = (navigator as Navigator & { connection?: { effectiveType?: string; saveData?: boolean; downlink?: number } }).connection
  return { online: navigator.onLine, effectiveType: c?.effectiveType, saveData: c?.saveData, downlink: c?.downlink }
}

/** One upload attempt of one file. Every failure is classified so the UI can say what actually went wrong. */
function uploadOnce(id: string, file: File, opts: UploadOptions, attempt: number): Promise<UploadResponse> {
  return new Promise((resolve, reject) => {
    const t0 = performance.now()
    if (navigator.onLine === false) { reject(new ApiError("You're offline.", 0, 'offline')); return }
    const xhr = new XMLHttpRequest()
    const fail = (err: ApiError) => {
      console.error('[upload] failed', {
        kind: err.kind, status: err.status, xhrStatus: xhr.status, readyState: xhr.readyState, fileSize: file.size, fileType: file.type,
        elapsedMs: Math.round(performance.now() - t0), attempt, ...connectionInfo(),
      })
      reject(err)
    }
    xhr.open('POST', apiUrl(`/api/sessions/${id}/files`)) // relative: same origin as the page
    xhr.responseType = 'text'
    xhr.timeout = opts.timeoutMs ?? 10 * 60_000
    xhr.upload.onprogress = (e) => { if (e.lengthComputable && e.total > 0) opts.onProgress?.(Math.min(1, e.loaded / e.total)) }
    xhr.onload = () => {
      let data: { error?: string } | null = null
      try { data = JSON.parse(xhr.responseText) } catch { /* not JSON (proxy error page) */ }
      const st = xhr.status
      if (st >= 200 && st < 300 && data) { resolve(data as unknown as UploadResponse); return }
      const server = data?.error
      if (st === 413) fail(new ApiError(opts.maxFileMb ? `File is too large (limit ${opts.maxFileMb} MB).` : (server ?? 'File is too large.'), st, 'too-large'))
      else if (st === 429) fail(new ApiError('Too many requests, wait a minute.', st, 'rate-limited', true))
      else if (st === 502 || st === 503 || st === 504) fail(new ApiError('Server is busy or restarting. Please try again in a minute.', st, 'server-busy', true))
      else if (st === 404) fail(new ApiError(server ?? 'Not found.', st, 'expired'))
      else fail(new ApiError(server ?? `Upload failed (${st}).`, st, st >= 500 ? 'other' : 'rejected'))
    }
    xhr.onerror = () => fail(navigator.onLine === false
      ? new ApiError("You're offline.", 0, 'offline')
      : new ApiError('Connection dropped during upload.', 0, 'network', true))
    xhr.ontimeout = () => fail(new ApiError('Upload timed out. Try again on a stronger connection.', 0, 'timeout'))
    xhr.onabort = () => reject(new ApiError('Upload cancelled.', -1, 'cancelled'))
    opts.signal?.addEventListener('abort', () => xhr.abort(), { once: true })
    const fd = new FormData()
    fd.append('files', file, file.name)
    xhr.send(fd)
  })
}

const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  const t = setTimeout(resolve, ms)
  signal?.addEventListener('abort', () => { clearTimeout(t); reject(new ApiError('Upload cancelled.', -1, 'cancelled')) }, { once: true })
})

/** Uploads one file; retries up to 3 times with 1 s / 3 s / 7 s backoff on network errors, 429 and 502/503/504.
 *  Validation errors (4xx) are never retried. */
async function uploadWithRetry(id: string, file: File, opts: UploadOptions = {}): Promise<UploadResponse> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await uploadOnce(id, file, opts, attempt + 1)
    } catch (e) {
      if (!(e instanceof ApiError) || !e.retryable || attempt >= RETRY_DELAYS_MS.length) throw e
      opts.onRetry?.(attempt + 1, RETRY_DELAYS_MS.length, e)
      await sleep(RETRY_DELAYS_MS[attempt], opts.signal)
    }
  }
}

/** Polls /api/health until the server answers (hosting platforms put idle instances to sleep). */
async function waitForServer(timeoutMs = 40_000, signal?: AbortSignal): Promise<boolean> {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(apiUrl('/api/health') + `?t=${Date.now()}`, { cache: 'no-store', signal })
      if (r.ok) return true
    } catch { /* still down */ }
    await sleep(2000, signal)
  }
  return false
}

export const api = {
  health: () => request<{ ok: boolean; capabilities: Capabilities }>('GET', '/health'),
  createSession: () => request<SessionInfo>('POST', '/sessions'),
  getSession: (id: string) => request<SessionInfo>('GET', `/sessions/${id}`),
  deleteSession: (id: string) => request<void>('DELETE', `/sessions/${id}`),
  upload: uploadWithRetry,
  waitForServer,
  removeFile: (id: string, fileId: string) => request<void>('DELETE', `/sessions/${id}/files/${fileId}`),
  merge: (id: string, order: string[]) => request<MergeResult>('POST', `/sessions/${id}/merge`, { order }),
  startExport: (id: string, body: ExportBody) => request<{ jobId: string }>('POST', `/sessions/${id}/export`, body),
  getJob: (id: string) => request<JobInfo>('GET', `/sessions/${id}/job`),
}
