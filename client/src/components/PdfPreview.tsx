import { useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { destroyPdf, loadPdf, type PdfDoc } from '../pdf'
import { PageFrame } from './PageFrame'

export function PdfPreview({ url }: { url: string }) {
  const [doc, setDoc] = useState<PdfDoc | null>(null)
  const [err, setErr] = useState(false)
  useEffect(() => {
    let live = true
    let d: PdfDoc | null = null
    loadPdf(url).then((x) => { d = x; if (live) setDoc(x) }).catch(() => live && setErr(true))
    return () => { live = false; destroyPdf(d) }
  }, [url])

  if (err) return <p className="muted">The preview could not be loaded, but your PDF is ready to download.</p>
  if (!doc) return <p className="muted"><Loader2 size={16} className="spin" /> Loading preview…</p>
  return (
    <div className="preview-scroll" tabIndex={0} aria-label="Final PDF preview">
      {Array.from({ length: doc.numPages }, (_, i) => (
        <figure key={i} className="preview-page">
          <PageFrame doc={doc} src={i} natural={undefined} rotation={0} orientation="auto" paper="original" fit renderWidth={620} />
          <figcaption>Page {i + 1} of {doc.numPages}</figcaption>
        </figure>
      ))}
    </div>
  )
}
