import { useEffect, useRef, useState } from 'react'
import { renderPage, type PdfDoc } from '../pdf'
import { targetSize, type Orient, type Paper, type Rotation } from '../layout'

interface Props {
  doc: PdfDoc
  src: number
  natural: [number, number] | undefined // page size in points (as displayed, before user rotation)
  rotation: Rotation
  orientation: Orient
  paper: Paper
  fit: boolean
  renderWidth: number // CSS px width the bitmap is rendered at
  eager?: boolean
}

/** Draws one page the way the exported PDF will lay it out: rotated, on the chosen paper, fitted or clipped. */
export function PageFrame({ doc, src, natural, rotation, orientation, paper, fit, renderWidth, eager }: Props) {
  const wrap = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const [rendered, setRendered] = useState(false)
  const [failed, setFailed] = useState(false)
  const [dims, setDims] = useState<[number, number] | undefined>(natural)

  useEffect(() => { if (natural) setDims(natural) }, [natural])

  useEffect(() => {
    let cancelled = false
    const el = wrap.current
    if (!el || rendered) return
    const go = () => {
      const c = canvas.current
      if (!c) return
      renderPage(doc, src + 1, c, renderWidth)
        .then((size) => { if (!cancelled) { setRendered(true); setDims([size.width, size.height]) } })
        .catch((err) => { console.error('page render failed', err); if (!cancelled) setFailed(true) })
    }
    if (eager) { go(); return () => { cancelled = true } }
    const io = new IntersectionObserver((entries) => { if (entries.some((e) => e.isIntersecting)) { io.disconnect(); go() } }, { rootMargin: '300px' })
    io.observe(el)
    return () => { cancelled = true; io.disconnect() }
  }, [doc, src, renderWidth, eager, rendered])

  const [dw, dh] = dims ?? [595.276, 841.89]
  const sideways = rotation % 180 === 90
  const [vw, vh] = sideways ? [dh, dw] : [dw, dh]
  const [tw, th] = targetSize(vw, vh, paper, orientation)
  const s = fit ? Math.min(tw / vw, th / vh) : 1

  return (
    <div ref={wrap} className="frame" style={{ aspectRatio: `${tw} / ${th}` }}>
      <div
        className="frame-content"
        style={{ width: `${((dw * s) / tw) * 100}%`, height: `${((dh * s) / th) * 100}%`, transform: `translate(-50%, -50%) rotate(${rotation}deg)` }}
      >
        <canvas ref={canvas} className={rendered ? 'ready' : ''} />
      </div>
      {!rendered && !failed && <span className="frame-loading" aria-hidden />}
      {failed && <span className="frame-failed">Preview unavailable</span>}
    </div>
  )
}
