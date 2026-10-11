import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowUpFromLine, TriangleAlert } from 'lucide-react'
import { ApiError, api, apiUrl, readIntoMemory, type Capabilities, type ExportResult, type FileInfo, type JobInfo, type Limits, type MergeResult } from './api'
import { destroyPdf, loadPdf, pageSizes, type PdfDoc } from './pdf'
import { toBytes } from './format'
import type { Paper } from './layout'
import type { PageItem, UploadItem } from './types'
import { Navbar } from './components/Navbar'
import { Toasts, type Toast } from './components/Toasts'
import { UploadStep } from './components/UploadStep'
import { PageEditor } from './components/PageEditor'
import { FinishStep, type CompressSettings } from './components/FinishStep'
import { ProgressPanel } from './components/ProgressPanel'
import { ResultPanel } from './components/ResultPanel'
import { PoweredBy } from './components/PoweredBy'

type Step = 'upload' | 'edit' | 'finish' | 'processing' | 'result'
const STEP_INDEX: Record<Step, number> = { upload: 0, edit: 1, finish: 2, processing: 2, result: 2 }
const SUPPORTED_EXT = new Set(['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'jpg', 'jpeg', 'png'])

const isOffline = () => navigator.onLine === false

/** Mobile networks reset connections when several uploads run at once, so be gentler there. */
function uploadConcurrency(): number {
  const c = (navigator as Navigator & { connection?: { effectiveType?: string; saveData?: boolean } }).connection
  if (c?.saveData || ['slow-2g', '2g', '3g'].includes(c?.effectiveType ?? '')) return 1
  const mobile = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent) || window.matchMedia?.('(pointer: coarse)').matches
  return mobile ? 2 : 3
}

/** Only a name with a clearly unsupported alphabetic extension (.txt, .zip, .exe) is refused here. Names with no extension,
 *  or just digits after a dot ("Scan 12.03"), are sent to the server, which decides by the file's content. */
function hasUnsupportedExtension(name: string): boolean {
  const ext = /\.([A-Za-z0-9]{1,6})$/.exec(name)?.[1]?.toLowerCase() ?? ''
  return ext !== '' && /[a-z]/.test(ext) && !SUPPORTED_EXT.has(ext)
}
const DEFAULT_COMPRESS: CompressSettings = { enabled: true, value: '2', unit: 'MB', mode: 'balanced', filename: 'merged_document' }

export default function App() {
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [limits, setLimits] = useState<Limits | null>(null)
  const [files, setFiles] = useState<FileInfo[]>([])
  const [step, setStep] = useState<Step>('upload')
  const [uploads, setUploads] = useState<UploadItem[]>([])
  const [batchDone, setBatchDone] = useState({ bytes: 0, files: 0 }) // finished uploads of the current batch (keeps the overall bar monotonic)
  const [merging, setMerging] = useState(false)
  const [merge, setMerge] = useState<MergeResult | null>(null)
  const [doc, setDoc] = useState<PdfDoc | null>(null)
  const [sizes, setSizes] = useState<Array<[number, number]>>([])
  const [pages, setPagesRaw] = useState<PageItem[]>([])
  const [paper, setPaper] = useState<Paper>('original')
  const [fit, setFit] = useState(true)
  const [compress, setCompress] = useState<CompressSettings>(DEFAULT_COMPRESS)
  const [starting, setStarting] = useState(false)
  const [job, setJob] = useState<JobInfo | null>(null)
  const [jobError, setJobError] = useState<string | null>(null)
  const [result, setResult] = useState<ExportResult | null>(null)
  const [toasts, setToasts] = useState<Toast[]>([])
  const toastId = useRef(0)
  const sessionRef = useRef<string | null>(null)
  const limitsRef = useRef<Limits | null>(null)
  const sessionPromise = useRef<Promise<string> | null>(null)
  const seqCounter = useRef(0)
  const seqById = useRef(new Map<string, number>())
  const fileByKey = useRef(new Map<string, File>())
  const waitingKeys = useRef<string[]>([])
  const activeUploads = useRef(0)
  const aborters = useRef(new Map<string, AbortController>())
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    try { const t = localStorage.getItem('maf-theme'); if (t === 'light' || t === 'dark') return t } catch { /* storage unavailable */ }
    return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  })
  useEffect(() => {
    document.documentElement.dataset.theme = theme
    try { localStorage.setItem('maf-theme', theme) } catch { /* ignore */ }
  }, [theme])
  const [dragging, setDragging] = useState(false)
  const [caps, setCaps] = useState<Capabilities | null>(null)
  useEffect(() => { api.health().then((h) => setCaps(h.capabilities)).catch(() => undefined) }, [])

  const toast = useCallback((kind: Toast['kind'], text: string) => {
    const id = ++toastId.current
    setToasts((t) => [...t, { id, kind, text }])
    window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 9000 : 5000)
  }, [])

  const resetAll = useCallback(() => {
    aborters.current.forEach((a) => a.abort())
    aborters.current.clear(); fileByKey.current.clear(); waitingKeys.current = []; seqById.current.clear()
    sessionRef.current = null; sessionPromise.current = null; limitsRef.current = null
    setUploads([])
    setSessionId(null); setFiles([]); setStep('upload'); setMerge(null); setDoc((d) => { destroyPdf(d); return null })
    setSizes([]); setPagesRaw([]); setPaper('original'); setFit(true); setCompress(DEFAULT_COMPRESS)
    setJob(null); setJobError(null); setResult(null)
  }, [])

  const fail = useCallback((e: unknown) => {
    if (e instanceof ApiError && e.status === 404) {
      toast('error', 'Your session expired and its files were deleted. Please upload your files again.')
      resetAll()
      return
    }
    toast('error', e instanceof Error ? e.message : 'Something went wrong.')
  }, [toast, resetAll])

  const setPages = useCallback((u: (p: PageItem[]) => PageItem[]) => setPagesRaw(u), [])

  // ---- Upload ----
  const patchUpload = (key: string, patch: Partial<UploadItem>) =>
    setUploads((cur) => cur.map((u) => (u.key === key ? { ...u, ...patch } : u)))
  const dropUpload = (key: string) => {
    fileByKey.current.delete(key)
    setUploads((cur) => cur.filter((u) => u.key !== key))
  }

  const ensureSession = (): Promise<string> => {
    if (sessionRef.current) return Promise.resolve(sessionRef.current)
    if (!sessionPromise.current) {
      sessionPromise.current = api.createSession()
        .then((s) => { sessionRef.current = s.id; limitsRef.current = s.limits; setSessionId(s.id); setLimits(s.limits); return s.id })
        .finally(() => { sessionPromise.current = null })
    }
    return sessionPromise.current
  }

  const runUpload = async (key: string, seq: number) => {
    let file = fileByKey.current.get(key)
    if (!file) return
    const ac = new AbortController()
    aborters.current.set(key, ac)
    patchUpload(key, { status: 'uploading', loaded: 0, error: undefined, note: undefined, detail: undefined })
    try {
      file = await readIntoMemory(file) // see api.ts: avoids lazy-stream failures for cloud-backed files on Android
      fileByKey.current.set(key, file)
      const picked = file
      if (isOffline()) throw new ApiError("You're offline.", 0, 'offline')
      let id: string
      try {
        id = await ensureSession()
      } catch (e) {
        if (isOffline()) throw new ApiError("You're offline.", 0, 'offline')
        // The first request after page load can hit a sleeping or restarting instance: wake it before giving up.
        if (!(e instanceof ApiError) || (e.status !== 0 && e.status < 502)) throw e
        patchUpload(key, { note: 'Waking up the server…', detail: 'Waking up the server…' })
        if (!(await api.waitForServer(40_000, ac.signal))) throw e
        id = await ensureSession()
        patchUpload(key, { note: undefined, detail: undefined })
      }
      const res = await api.upload(id, picked, {
        signal: ac.signal,
        maxFileMb: limitsRef.current ? Math.round(limitsRef.current.maxFileBytes / 1e6) : undefined,
        onProgress: (f) => patchUpload(key, { loaded: Math.round(f * picked.size) }),
        onRetry: (n, max, why) => patchUpload(key, {
          loaded: 0, note: `Retrying (${n}/${max})…`,
          detail: why.kind === 'server-busy' ? 'Server is busy or restarting, retrying…' : why.kind === 'rate-limited' ? 'Too many requests, retrying shortly…' : why.message,
        }),
      })
      res.rejected.forEach((r) => toast('error', `${r.name}: ${r.reason}`))
      res.files.forEach((f) => seqById.current.set(f.id, seq))
      // One update: the row turns from "uploading" into the real file without a flicker or a duplicate.
      setFiles((cur) => {
        const fresh = res.files.filter((f) => !cur.some((c) => c.id === f.id))
        const at = cur.findIndex((c) => (seqById.current.get(c.id) ?? 0) > seq)
        return at === -1 ? [...cur, ...fresh] : [...cur.slice(0, at), ...fresh, ...cur.slice(at)]
      })
      setBatchDone((d) => ({ bytes: d.bytes + picked.size, files: d.files + 1 }))
      dropUpload(key)
    } catch (e) {
      if (e instanceof ApiError && e.kind === 'cancelled') { dropUpload(key); return } // cancelled by the user
      if (e instanceof ApiError && e.kind === 'expired') { fail(e); return }
      const msg = e instanceof Error ? e.message : 'The upload failed.'
      patchUpload(key, { status: 'failed', error: msg, note: undefined, detail: undefined })
    } finally {
      aborters.current.delete(key)
    }
  }

  const pumpUploads = () => {
    while (activeUploads.current < uploadConcurrency() && waitingKeys.current.length) {
      const key = waitingKeys.current.shift()!
      const seq = Number(key.split(':')[0])
      activeUploads.current++
      void runUpload(key, seq).finally(() => { activeUploads.current--; pumpUploads() })
    }
  }

  const addFiles = (list: File[]) => {
    const items: UploadItem[] = []
    for (const f of list) {
      if (hasUnsupportedExtension(f.name)) { toast('error', `"${f.name}" is not a supported file type.`); continue }
      const seq = ++seqCounter.current
      const key = `${seq}:${Math.random().toString(36).slice(2, 8)}`
      fileByKey.current.set(key, f)
      items.push({ key, seq, name: f.name, size: f.size, status: 'waiting', loaded: 0 })
    }
    if (!items.length) return
    setUploads((cur) => [...cur, ...items])
    waitingKeys.current.push(...items.map((i) => i.key))
    pumpUploads()
  }

  const cancelUpload = (key: string) => {
    waitingKeys.current = waitingKeys.current.filter((k) => k !== key)
    const ac = aborters.current.get(key)
    if (ac) ac.abort() // runUpload removes the row when the request is aborted
    else dropUpload(key)
  }

  const retryUpload = (key: string) => {
    patchUpload(key, { status: 'waiting', loaded: 0, error: undefined })
    waitingKeys.current.push(key)
    pumpUploads()
  }

  // Poll conversion status while any file is still being converted.
  const pending = files.some((f) => f.status === 'queued' || f.status === 'converting')
  useEffect(() => {
    if (!pending || !sessionId || step !== 'upload') return
    const t = window.setInterval(async () => {
      try {
        const s = await api.getSession(sessionId)
        const byId = new Map(s.files.map((f) => [f.id, f]))
        setFiles((cur) => cur.filter((f) => byId.has(f.id)).map((f) => byId.get(f.id)!))
      } catch (e) { fail(e) }
    }, 700)
    return () => window.clearInterval(t)
  }, [pending, sessionId, step, fail])

  const removeFile = async (id: string) => {
    setFiles((cur) => cur.filter((f) => f.id !== id))
    if (sessionId) await api.removeFile(sessionId, id).catch((e) => { if (!(e instanceof ApiError && e.status === 404)) fail(e) })
  }

  // ---- Merge -> editor ----
  const goEdit = async () => {
    if (!sessionId) return
    setMerging(true)
    try {
      const ready = files.filter((f) => f.status === 'ready')
      const m = await api.merge(sessionId, ready.map((f) => f.id))
      const d = await loadPdf(apiUrl(m.url))
      setDoc((old) => { destroyPdf(old); return d })
      setMerge(m)
      setSizes([])
      pageSizes(d).then(setSizes).catch(() => undefined)
      setPagesRaw(m.pages.map((p) => ({ key: `p${m.version}-${p.index}`, src: p.index, rotation: 0, orientation: 'auto', selected: false })))
      setStep('edit')
    } catch (e) { fail(e) } finally { setMerging(false) }
  }

  const resetPages = () => {
    if (!merge) return
    setPagesRaw(merge.pages.map((p) => ({ key: `p${merge.version}-${p.index}`, src: p.index, rotation: 0, orientation: 'auto', selected: false })))
    setPaper('original'); setFit(true)
  }

  // ---- Export ----
  const create = async () => {
    if (!sessionId) return
    setStarting(true)
    try {
      const target = compress.enabled ? { bytes: toBytes(Number(compress.value), compress.unit), mode: compress.mode } : null
      await api.startExport(sessionId, {
        pages: pages.map((p) => ({ src: p.src, rotation: p.rotation, orientation: p.orientation })),
        paper, fitToPage: fit, filename: compress.filename.trim() || 'merged_document', target,
      })
      setJob(null); setJobError(null); setResult(null); setStep('processing')
    } catch (e) { fail(e) } finally { setStarting(false) }
  }

  useEffect(() => {
    if (step !== 'processing' || !sessionId || jobError) return
    let stop = false
    const tick = async () => {
      try {
        const j = await api.getJob(sessionId)
        if (stop) return
        setJob(j)
        if (j.status === 'done' && j.result) { setResult(j.result); setStep('result') }
        else if (j.status === 'error') setJobError(j.error ?? 'Processing failed.')
      } catch (e) { if (!stop) { if (e instanceof ApiError && e.status === 404) fail(e); else setJobError(e instanceof Error ? e.message : 'Lost contact with the server.') } }
    }
    void tick()
    const t = window.setInterval(tick, 500)
    return () => { stop = true; window.clearInterval(t) }
  }, [step, sessionId, jobError, fail])

  const startNew = async () => {
    const id = sessionId
    resetAll()
    if (id) await api.deleteSession(id).catch(() => undefined)
  }

  const paperLabel = paper === 'a4' ? 'A4' : paper === 'a3' ? 'A3' : 'Original'

  // Window-wide drop target on the upload step so files can land anywhere.
  const addRef = useRef(addFiles)
  addRef.current = addFiles
  useEffect(() => {
    if (step !== 'upload') return
    let depth = 0
    const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files')
    const enter = (e: DragEvent) => { if (hasFiles(e)) { depth++; setDragging(true) } }
    const leave = (e: DragEvent) => { if (hasFiles(e)) { depth = Math.max(0, depth - 1); if (!depth) setDragging(false) } }
    const over = (e: DragEvent) => { if (hasFiles(e)) e.preventDefault() }
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault(); depth = 0; setDragging(false)
      const list = Array.from(e.dataTransfer?.files ?? [])
      if (list.length) void addRef.current(list)
    }
    window.addEventListener('dragenter', enter); window.addEventListener('dragleave', leave)
    window.addEventListener('dragover', over); window.addEventListener('drop', drop)
    return () => {
      window.removeEventListener('dragenter', enter); window.removeEventListener('dragleave', leave)
      window.removeEventListener('dragover', over); window.removeEventListener('drop', drop)
      setDragging(false)
    }
  }, [step])

  useEffect(() => { window.scrollTo(0, 0) }, [step])
  const retention = limits?.retentionMinutes ?? 30
  const uploading = uploads.some((u) => u.status !== 'failed')
  useEffect(() => { if (!uploading) setBatchDone((d) => (d.files || d.bytes ? { bytes: 0, files: 0 } : d)) }, [uploading])
  const wide = step === 'edit' || step === 'result'

  return (
    <div className="app">
      <Navbar retentionMinutes={retention} current={STEP_INDEX[step]} theme={theme} onTheme={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))} />
      <main className="main">
        {step === 'upload' && (
          <div className="page page-upload">
            {caps && !caps.office && (
              <div className="notice warn" role="alert">
                <TriangleAlert size={18} />
                <div><strong>Word, Excel and PowerPoint conversion is unavailable.</strong> LibreOffice is not installed on this server, so only PDF, JPG and PNG files can be merged right now.</div>
              </div>
            )}
            <UploadStep
              files={files} uploads={uploads} batchDone={batchDone} limits={limits} uploading={uploading} merging={merging}
              onAdd={addFiles} onRemove={removeFile} onRetryUpload={retryUpload} onCancelUpload={cancelUpload} onReorder={(ids) => setFiles((cur) => ids.map((id) => cur.find((f) => f.id === id)!))}
              onContinue={goEdit}
            />
          </div>
        )}
        {step === 'edit' && doc && merge && (
          <PageEditor
            doc={doc} merge={merge} sizes={sizes} pages={pages} setPages={setPages}
            paper={paper} setPaper={setPaper} fit={fit} setFit={setFit}
            onReset={resetPages} onBack={() => setStep('upload')} onNext={() => setStep('finish')}
          />
        )}
        {step === 'finish' && merge && (
          <div className="page">
            {caps && !caps.imageCompression && (
              <div className="notice warn" role="status">
                <TriangleAlert size={18} />
                <div><strong>Image compression is limited.</strong> Ghostscript is not installed on this server, so only lossless size optimisation is applied and small targets may not be reachable.</div>
              </div>
            )}
            <FinishStep
              settings={compress} onChange={setCompress} pageCount={pages.length} paperLabel={paperLabel}
              originalSize={merge.originalSize} mergedSize={merge.size} busy={starting}
              onBack={() => setStep('edit')} onCreate={create}
            />
          </div>
        )}
        {step === 'processing' && <ProgressPanel job={job} error={jobError} onBack={() => { setJobError(null); setStep('finish') }} />}
        {step === 'result' && result && (
          <ResultPanel
            result={result} onNew={startNew}
            onRetryHigher={(bytes) => {
              const mb = bytes >= 1_000_000
              setCompress({ ...compress, enabled: true, unit: mb ? 'MB' : 'KB', value: String(mb ? Math.round(bytes / 10_000) / 100 : Math.round(bytes / 1000)) })
              setStep('finish')
            }}
            onRetrySmallest={() => { setCompress({ ...compress, mode: compress.mode === 'high' ? 'balanced' : 'smallest' }); setStep('finish') }}
          />
        )}
      </main>
      {wide ? (
        <footer className="foot foot-slim">
          <span>Files are deleted automatically after {retention} minutes of inactivity.</span>
          <PoweredBy />
        </footer>
      ) : (
        <footer className="foot">
          <div className="foot-row">
            <p>
              <strong>Privacy:</strong> your files are processed on this server and stored only temporarily. They are deleted automatically {retention} minutes
              after your last activity, or right away when you click “Start another task”. Closing the tab does not delete them earlier.
            </p>
            <PoweredBy />
          </div>
        </footer>
      )}
      {dragging && <div className="drop-overlay" aria-hidden><div><ArrowUpFromLine size={22} /> Drop to add files</div></div>}
      <Toasts toasts={toasts} dismiss={(id) => setToasts((t) => t.filter((x) => x.id !== id))} />
    </div>
  )
}
