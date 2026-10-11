import { useRef, useState, type CSSProperties, type DragEvent } from 'react'
import { DndContext, closestCenter, KeyboardSensor, PointerSensor, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core'
import { SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { AlertCircle, CheckCircle2, GripVertical, Loader2, Trash2, ArrowUpFromLine } from 'lucide-react'
import type { FileInfo, Limits } from '../api'
import { KIND_LABEL, formatBytes } from '../format'

const EXT_TAG: Record<string, string> = { pdf: 'PDF', doc: 'DOC', docx: 'DOC', xls: 'XLS', xlsx: 'XLS', ppt: 'PPT', pptx: 'PPT', jpg: 'JPG', jpeg: 'JPG', png: 'PNG' }

// Decorative sample data for the empty-state illustration. Never derived from the user's files.
const STAGE_FILES = [
  { tag: 'DOCX', cls: 'docx', name: 'Board notes.docx', size: '412 KB', top: 56, left: 24, rot: -2 },
  { tag: 'XLSX', cls: 'xlsx', name: 'Budget.xlsx', size: '286 KB', top: 140, left: 36, rot: 1.5 },
  { tag: 'PPTX', cls: 'pptx', name: 'Pitch deck.pptx', size: '1.1 MB', top: 224, left: 24, rot: -1 },
  { tag: 'JPG', cls: 'jpg', name: 'Site photo.jpg', size: '748 KB', top: 308, left: 36, rot: 2 },
  { tag: 'PDF', cls: 'pdf', name: 'Contract.pdf', size: '232 KB', top: 392, left: 24, rot: -1.5 },
]

const HOW_STEPS = [
  { title: 'Add your files', text: 'PDF, Word, Excel, PowerPoint and images. Each one is converted to PDF on the server.' },
  { title: 'Arrange the pages', text: 'Reorder, rotate or delete pages, and choose A4, A3 or the original size.' },
  { title: 'Set a size and download', text: 'Pick a target like 500 KB and see the real final size, never a guess.' },
]

const tint = (name: string): CSSProperties => ({ ['--c' as string]: `var(--t-${name})` })

function Stage() {
  return (
    <div className="stage" aria-hidden="true">
      <div className="stage-inner">
        <svg className="stage-curves" viewBox="0 0 520 520" fill="none">
          {STAGE_FILES.map((f) => {
            const x = f.left + 170
            const y = f.top + 30
            return <path key={f.tag} d={`M${x} ${y} C${x + 60} ${y}, 250 215, 310 215`} stroke="var(--drop-line)" strokeWidth="1.5" />
          })}
          <circle cx="310" cy="215" r="3.5" fill="var(--accent)" />
        </svg>
        {STAGE_FILES.map((f) => (
          <div key={f.tag} className="stage-card" style={{ ...tint(f.cls), top: f.top, left: f.left, transform: `rotate(${f.rot}deg)` }}>
            <span className="stage-tag">{f.tag}</span>
            <span>
              <span className="stage-name" style={{ display: 'block' }}>{f.name}</span>
              <span className="stage-size">{f.size}</span>
            </span>
          </div>
        ))}
        <div className="stage-pages">
          <div className="stage-sheet s3" />
          <div className="stage-sheet s2" />
          <div className="stage-sheet s1" style={tint('pdf')}>
            <span className="stage-tag">PDF</span>
            <i style={{ width: '88%' }} /><i style={{ width: '70%' }} /><i style={{ width: '80%' }} /><i style={{ width: '46%' }} /><i style={{ width: '74%' }} />
          </div>
        </div>
        <div className="stage-file">merged_document.pdf</div>
        <div className="stage-compare">
          <div className="stage-bar"><div><em>Uploaded files</em><b>2.78 MB</b></div><span /></div>
          <div className="stage-bar fin"><div><em>Final PDF</em><b>432 KB</b></div><span /></div>
        </div>
      </div>
    </div>
  )
}

function FileRow({ file, index, onRemove }: { file: FileInfo; index: number; onRemove: (id: string) => void }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: file.id })
  return (
    <li ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition }} className={`file-row k-${file.kind} ${isDragging ? 'dragging' : ''} ${file.status === 'error' ? 'has-error' : ''}`}>
      <button className="grip" {...attributes} {...listeners} aria-label={`Drag to reorder ${file.name}`}><GripVertical size={16} /></button>
      <span className="file-idx" aria-hidden>{String(index).padStart(2, '0')}</span>
      <span className="file-icon" aria-hidden>{EXT_TAG[file.ext] ?? file.ext}</span>
      <div className="file-main">
        <div className="file-name" title={file.name}>{file.name}</div>
        <div className="file-meta">
          {KIND_LABEL[file.kind] ?? file.kind} · {formatBytes(file.size)}
        </div>
        {file.status === 'error' && <div className="file-error">{file.error}</div>}
      </div>
      <span className="file-pages">{file.status === 'ready' && file.pageCount != null ? `${file.pageCount} p` : ''}</span>
      <span className={`chip chip-${file.status}`}>
        {file.status === 'ready' && <><CheckCircle2 size={13} /> Ready</>}
        {file.status === 'error' && <><AlertCircle size={13} /> Failed</>}
        {file.status === 'queued' && <><Loader2 size={13} className="spin" /> Waiting</>}
        {file.status === 'converting' && <><Loader2 size={13} className="spin" /> Converting</>}
      </span>
      <button className="icon-btn danger" onClick={() => onRemove(file.id)} aria-label={`Remove ${file.name}`}><Trash2 size={16} /></button>
    </li>
  )
}

interface Props {
  files: FileInfo[]
  limits: Limits | null
  uploading: boolean
  merging: boolean
  onAdd: (files: File[]) => void
  onRemove: (id: string) => void
  onReorder: (ids: string[]) => void
  onContinue: () => void
}

export function UploadStep({ files, limits, uploading, merging, onAdd, onRemove, onReorder, onContinue }: Props) {
  const input = useRef<HTMLInputElement>(null)
  const [over, setOver] = useState(false)
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }))

  const drop = (e: DragEvent) => {
    e.preventDefault(); setOver(false)
    const list = Array.from(e.dataTransfer.files)
    if (list.length) onAdd(list)
  }
  const end = (e: DragEndEvent) => {
    if (!e.over || e.active.id === e.over.id) return
    const ids = files.map((f) => f.id)
    onReorder(arrayMove(ids, ids.indexOf(String(e.active.id)), ids.indexOf(String(e.over.id))))
  }

  const ready = files.filter((f) => f.status === 'ready')
  const converting = files.filter((f) => f.status === 'queued' || f.status === 'converting').length
  const pending = converting > 0
  const failed = files.filter((f) => f.status === 'error').length
  const pages = ready.reduce((n, f) => n + (f.pageCount ?? 0), 0)
  const totalSize = ready.reduce((n, f) => n + f.size, 0)
  const empty = files.length === 0

  const chooseButton = (cls: string) => (
    <button className={`btn ${cls}`} onClick={() => input.current?.click()} disabled={uploading}>
      {uploading ? <><Loader2 size={16} className="spin" /> Uploading…</> : 'Choose files'}
    </button>
  )

  return (
    <>
      <section className="upload-hero">
        <div className="wrap">
          <div className={`upload ${empty ? '' : 'has-files'}`}>
            <div className="upload-intro">
              <h1>Merge files. Make one PDF.</h1>
              <p>Combine documents, organize pages, and compress your files in one place.</p>
              <div
                className={`dropzone ${empty ? '' : 'compact'} ${over ? 'over' : ''}`}
                onDragOver={(e) => { e.preventDefault(); setOver(true) }}
                onDragLeave={() => setOver(false)}
                onDrop={drop}
              >
                <span className="dz-icon"><ArrowUpFromLine size={20} /></span>
                {empty ? (
                  <>
                    <h2>Drop files anywhere</h2>
                    <p>or pick them from your computer.</p>
                    {chooseButton('btn-primary')}
                  </>
                ) : (
                  <>
                    <div className="dz-text">
                      <h2>Add more files</h2>
                      <p>Drop them anywhere on the page.</p>
                    </div>
                    {chooseButton('')}
                  </>
                )}
                <input
                  ref={input} type="file" multiple hidden
                  accept=".pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.jpg,.jpeg,.png"
                  onChange={(e) => { const l = Array.from(e.target.files ?? []); if (l.length) onAdd(l); e.target.value = '' }}
                />
                {empty && <div className="formats" aria-label="Supported formats">{['PDF', 'DOCX', 'XLSX', 'PPTX', 'JPG', 'PNG'].map((f) => <span key={f}>{f}</span>)}</div>}
                {empty && limits && <small>Up to {limits.maxFiles} files, {formatBytes(limits.maxFileBytes)} each, {formatBytes(limits.maxTotalBytes)} total, {limits.maxPages} pages.</small>}
              </div>
              {!empty && (
                <dl className="upload-summary" aria-label="Summary of added files">
                  <div><dt>Files</dt><dd>{ready.length} ready{failed > 0 && `, ${failed} skipped`}{converting > 0 && `, ${converting} converting`}</dd></div>
                  <div><dt>Pages</dt><dd>{pages}</dd></div>
                  <div><dt>Combined size</dt><dd>{formatBytes(totalSize)}</dd></div>
                </dl>
              )}
            </div>

            {empty ? (
              <Stage />
            ) : (
              <div className="order">
                <div className="order-head">
                  <h2>Merge order</h2>
                  <span>Drag the handle to reorder</span>
                </div>
                <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={end}>
                  <SortableContext items={files.map((f) => f.id)} strategy={verticalListSortingStrategy}>
                    <ul className="file-list">
                      {files.map((f, i) => <FileRow key={f.id} file={f} index={i + 1} onRemove={onRemove} />)}
                    </ul>
                  </SortableContext>
                </DndContext>
                <div className="order-foot">
                  <span className="tally">
                    <b>{ready.length}</b> ready, <b>{pages}</b> page{pages === 1 ? '' : 's'}
                    {failed > 0 && <>, {failed} failed (skipped)</>}
                    {pending && <>, converting…</>}
                  </span>
                  <button className="btn btn-primary" disabled={ready.length === 0 || pending || merging || uploading} onClick={onContinue}>
                    {merging ? <><Loader2 size={16} className="spin" /> Merging…</> : 'Merge & edit pages'}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </section>

      {empty && (
        <section className="how" aria-labelledby="how-title">
          <div className="wrap">
            <h2 id="how-title" className="sr-only">How it works</h2>
            <ol>
              {HOW_STEPS.map((s, i) => (
                <li key={s.title}>
                  <span className="how-num" aria-hidden>{i + 1}</span>
                  <div><h3>{s.title}</h3><p>{s.text}</p></div>
                </li>
              ))}
            </ol>
          </div>
        </section>
      )}
    </>
  )
}
