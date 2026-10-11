import { useMemo, useState } from 'react'
import { DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core'
import { SortableContext, arrayMove, rectSortingStrategy, sortableKeyboardCoordinates, useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { Check, GripVertical, Maximize2, RotateCcw, RotateCw, Trash2, Undo2, X } from 'lucide-react'
import type { PdfDoc } from '../pdf'
import type { MergeResult } from '../api'
import type { Orient, Paper, Rotation } from '../layout'
import type { PageItem } from '../types'
import { PageFrame } from './PageFrame'

interface Props {
  doc: PdfDoc
  merge: MergeResult
  sizes: Array<[number, number]>
  pages: PageItem[]
  setPages: (updater: (p: PageItem[]) => PageItem[]) => void
  paper: Paper
  setPaper: (p: Paper) => void
  fit: boolean
  setFit: (f: boolean) => void
  onReset: () => void
  onBack: () => void
  onNext: () => void
}

const rot = (r: number, d: number) => (((r + d) % 360) + 360) % 360 as Rotation

function Thumb(p: {
  item: PageItem; position: number; doc: PdfDoc; label: string; natural: [number, number] | undefined; paper: Paper; fit: boolean
  onToggle: () => void; onRotate: (d: number) => void; onDelete: () => void; onPreview: () => void
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: p.item.key })
  return (
    <li ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition }} className={`thumb ${p.item.selected ? 'selected' : ''} ${isDragging ? 'dragging' : ''}`}>
      <div className="thumb-top">
        <button className={`check ${p.item.selected ? 'on' : ''}`} onClick={p.onToggle} role="checkbox" aria-checked={p.item.selected} aria-label={`Select page ${p.position}`}>
          {p.item.selected && <Check size={13} strokeWidth={3} />}
        </button>
        <button className="grip small" {...attributes} {...listeners} aria-label={`Drag page ${p.position} to reorder`}><GripVertical size={15} /></button>
      </div>
      <div className="thumb-body" onClick={p.onToggle}>
        <PageFrame doc={p.doc} src={p.item.src} natural={p.natural} rotation={p.item.rotation} orientation={p.item.orientation} paper={p.paper} fit={p.fit} renderWidth={220} />
      </div>
      <div className="thumb-actions">
        <button className="icon-btn" onClick={() => p.onRotate(-90)} aria-label={`Rotate page ${p.position} counterclockwise`} title="Rotate left"><RotateCcw size={15} /></button>
        <button className="icon-btn" onClick={() => p.onRotate(90)} aria-label={`Rotate page ${p.position} clockwise`} title="Rotate right"><RotateCw size={15} /></button>
        <button className="icon-btn" onClick={p.onPreview} aria-label={`Preview page ${p.position}`} title="Preview"><Maximize2 size={15} /></button>
        <button className="icon-btn danger" onClick={p.onDelete} aria-label={`Delete page ${p.position}`} title="Delete"><Trash2 size={15} /></button>
      </div>
      <div className="thumb-meta">
        <span className="page-no">{p.position}</span>
        <span className="thumb-label" title={p.label}>{p.label}</span>
      </div>
    </li>
  )
}

export function PageEditor({ doc, merge, sizes, pages, setPages, paper, setPaper, fit, setFit, onReset, onBack, onNext }: Props) {
  const [scope, setScope] = useState<'selected' | 'all'>('all')
  const [preview, setPreview] = useState<PageItem | null>(null)
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }))

  const selectedCount = pages.filter((p) => p.selected).length
  const effectiveScope = scope === 'selected' && selectedCount === 0 ? 'none' : scope
  const targets = (p: PageItem) => effectiveScope === 'all' || (effectiveScope === 'selected' && p.selected)
  const deleted = merge.pageCount - pages.length

  const labels = useMemo(() => merge.pages.map((m) => `${m.fileName} · p${m.pageInFile}`), [merge.pages])
  const orientNow = useMemo<Orient | 'mixed'>(() => {
    const t = pages.filter(targets)
    if (!t.length) return 'mixed'
    return t.every((p) => p.orientation === t[0].orientation) ? t[0].orientation : 'mixed'
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pages, scope])

  const rotate = (d: number) => setPages((ps) => ps.map((p) => (targets(p) ? { ...p, rotation: rot(p.rotation, d) } : p)))
  const orient = (o: Orient) => setPages((ps) => ps.map((p) => (targets(p) ? { ...p, orientation: o } : p)))
  const del = () => {
    if (effectiveScope === 'all') return
    setPages((ps) => ps.filter((p) => !p.selected))
  }
  const end = (e: DragEndEvent) => {
    if (!e.over || e.active.id === e.over.id) return
    setPages((ps) => {
      const keys = ps.map((p) => p.key)
      return arrayMove(ps, keys.indexOf(String(e.active.id)), keys.indexOf(String(e.over!.id)))
    })
  }
  const toggle = (key: string) => setPages((ps) => ps.map((p) => (p.key === key ? { ...p, selected: !p.selected } : p)))

  return (
    <section className={`editor ${selectedCount ? 'has-selection' : ''}`}>
      <div className="editor-main">
        <div className="toolbar">
          <strong>{pages.length} page{pages.length === 1 ? '' : 's'}</strong>
          {deleted > 0 && <span className="count">{deleted} deleted</span>}
          {selectedCount > 0 && <span className="count">{selectedCount} selected</span>}
          <span className="spacer" />
          <button className="btn btn-ghost btn-sm" onClick={() => setPages((ps) => ps.map((p) => ({ ...p, selected: true })))}>Select all</button>
          <button className="btn btn-ghost btn-sm" onClick={() => setPages((ps) => ps.map((p) => ({ ...p, selected: false })))} disabled={!selectedCount}><X size={14} /> Clear</button>
          <button className="btn btn-ghost btn-sm" onClick={onReset}><Undo2 size={14} /> Reset changes</button>
        </div>
        <div className="canvas">
        {pages.length === 0 ? (
          <div className="empty"><p>All pages were deleted.</p><button className="btn btn-primary" onClick={onReset}>Restore pages</button></div>
        ) : (
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={end}>
            <SortableContext items={pages.map((p) => p.key)} strategy={rectSortingStrategy}>
              <ul className="thumb-grid">
                {pages.map((item, i) => (
                  <Thumb
                    key={item.key} item={item} position={i + 1} doc={doc} label={labels[item.src]} natural={sizes[item.src]} paper={paper} fit={fit}
                    onToggle={() => toggle(item.key)}
                    onRotate={(d) => setPages((ps) => ps.map((p) => (p.key === item.key ? { ...p, rotation: rot(p.rotation, d) } : p)))}
                    onDelete={() => setPages((ps) => ps.filter((p) => p.key !== item.key))}
                    onPreview={() => setPreview(item)}
                  />
                ))}
              </ul>
            </SortableContext>
          </DndContext>
        )}
        </div>
      </div>

      <aside className="inspector">
        <div className="inspector-scroll">
        <div className="side-card">
          <h3>Page tools</h3>
          <div className="seg full" role="radiogroup" aria-label="Apply tools to">
            <button role="radio" aria-checked={scope === 'all'} className={scope === 'all' ? 'on' : ''} onClick={() => setScope('all')}>All pages</button>
            <button role="radio" aria-checked={scope === 'selected'} className={scope === 'selected' ? 'on' : ''} onClick={() => setScope('selected')}>Selected ({selectedCount})</button>
          </div>
          {effectiveScope === 'none' && <p className="hint">Select one or more pages first.</p>}
          <label className="field-label">Rotate</label>
          <div className="btn-grid">
            <button className="btn" disabled={effectiveScope === 'none'} onClick={() => rotate(90)}><RotateCw size={16} /> 90° clockwise</button>
            <button className="btn" disabled={effectiveScope === 'none'} onClick={() => rotate(180)}>180°</button>
            <button className="btn" disabled={effectiveScope === 'none'} onClick={() => rotate(270)}><RotateCw size={16} /> 270° clockwise</button>
            <button className="btn" disabled={effectiveScope === 'none'} onClick={() => rotate(-90)}><RotateCcw size={16} /> 90° counter-clockwise</button>
          </div>
          <label className="field-label">Orientation</label>
          <div className="seg full" role="radiogroup" aria-label="Orientation">
            {(['auto', 'portrait', 'landscape'] as Orient[]).map((o) => (
              <button key={o} role="radio" aria-checked={orientNow === o} disabled={effectiveScope === 'none'} className={orientNow === o ? 'on' : ''} onClick={() => orient(o)}>
                {o === 'auto' ? 'Keep each' : o[0].toUpperCase() + o.slice(1)}
              </button>
            ))}
          </div>
          {orientNow === 'mixed' && effectiveScope !== 'none' && <p className="hint">Pages currently have different orientations.</p>}
          <button className="btn btn-danger-ghost" disabled={effectiveScope !== 'selected'} onClick={del}><Trash2 size={16} /> Delete selected pages</button>
        </div>

        <div className="side-card">
          <h3>Paper size</h3>
          <div className="radio-cards" role="radiogroup" aria-label="Paper size">
            {([['original', 'Original', 'Keep page sizes'], ['a4', 'A4', '210×297 mm'], ['a3', 'A3', '297×420 mm']] as const).map(([v, t, d]) => (
              <button key={v} role="radio" aria-checked={paper === v} className={`radio-card ${paper === v ? 'on' : ''}`} onClick={() => setPaper(v)}>
                <strong>{t}</strong><small>{d}</small>
              </button>
            ))}
          </div>
          <label className="check-row">
            <input type="checkbox" checked={fit} onChange={(e) => setFit(e.target.checked)} />
            <span>Fit content to page<small>Off keeps the original scale; larger content may be clipped.</small></span>
          </label>
          <p className="hint">Thumbnails show the exact layout of the exported PDF.</p>
        </div>

        </div>
        <div className="inspector-foot">
          <button className="btn" onClick={onBack}>Back</button>
          <button className="btn btn-primary" disabled={pages.length === 0} onClick={onNext}>Continue</button>
        </div>
      </aside>

      {preview && (
        <div className="modal" role="dialog" aria-modal="true" aria-label="Page preview" onClick={() => setPreview(null)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <button className="icon-btn modal-close" onClick={() => setPreview(null)} aria-label="Close preview"><X size={20} /></button>
            <PageFrame doc={doc} src={preview.src} natural={sizes[preview.src]} rotation={preview.rotation} orientation={preview.orientation} paper={paper} fit={fit} renderWidth={760} eager />
            <p className="muted center">{labels[preview.src]}</p>
          </div>
        </div>
      )}
    </section>
  )
}
