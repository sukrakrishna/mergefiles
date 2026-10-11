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

export class ApiError extends Error {
  status: number
  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

/** Optional backend origin for split deployments (e.g. https://api.example.com). Empty = same origin. */
const API_BASE = String(import.meta.env.VITE_API_URL ?? '').trim().replace(/\/+$/, '')

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

/** Uploads one file with XMLHttpRequest so real byte progress is available (fetch cannot report upload progress). */
function uploadRequest(id: string, file: File, opts: { onProgress?: (fraction: number) => void; signal?: AbortSignal; timeoutMs?: number }): Promise<UploadResponse> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', apiUrl(`/api/sessions/${id}/files`))
    xhr.responseType = 'text'
    xhr.timeout = opts.timeoutMs ?? 10 * 60_000
    xhr.upload.onprogress = (e) => { if (e.lengthComputable && e.total > 0) opts.onProgress?.(Math.min(1, e.loaded / e.total)) }
    xhr.onload = () => {
      let data: unknown = null
      try { data = JSON.parse(xhr.responseText) } catch { /* not JSON */ }
      if (xhr.status >= 200 && xhr.status < 300 && data) resolve(data as UploadResponse)
      else reject(new ApiError((data as { error?: string } | null)?.error ?? `Upload failed (${xhr.status}).`, xhr.status))
    }
    xhr.onerror = () => reject(new ApiError('Cannot reach the server. Check your connection and try again.', 0))
    xhr.ontimeout = () => reject(new ApiError('The upload took too long and was stopped.', 0))
    xhr.onabort = () => reject(new ApiError('Upload cancelled.', -1))
    opts.signal?.addEventListener('abort', () => xhr.abort(), { once: true })
    const fd = new FormData()
    fd.append('files', file, file.name)
    xhr.send(fd)
  })
}

export const api = {
  health: () => request<{ ok: boolean; capabilities: Capabilities }>('GET', '/health'),
  createSession: () => request<SessionInfo>('POST', '/sessions'),
  getSession: (id: string) => request<SessionInfo>('GET', `/sessions/${id}`),
  deleteSession: (id: string) => request<void>('DELETE', `/sessions/${id}`),
  upload: uploadRequest,
  removeFile: (id: string, fileId: string) => request<void>('DELETE', `/sessions/${id}/files/${fileId}`),
  merge: (id: string, order: string[]) => request<MergeResult>('POST', `/sessions/${id}/merge`, { order }),
  startExport: (id: string, body: ExportBody) => request<{ jobId: string }>('POST', `/sessions/${id}/export`, body),
  getJob: (id: string) => request<JobInfo>('GET', `/sessions/${id}/job`),
}
