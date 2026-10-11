import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs'
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url'

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl

export type PdfDoc = pdfjs.PDFDocumentProxy

const tasks = new WeakMap<PdfDoc, pdfjs.PDFDocumentLoadingTask>()

export async function loadPdf(url: string): Promise<PdfDoc> {
  const task = pdfjs.getDocument({ url, withCredentials: false })
  const doc = await task.promise
  tasks.set(doc, task)
  return doc
}

/** Releases the worker and memory held by a loaded document. Safe to call with null. */
export function destroyPdf(doc: PdfDoc | null | undefined): void {
  if (doc) void tasks.get(doc)?.destroy()
}

/** Renders page `pageNumber` (1-based) so its width is `cssWidth` CSS px (at device pixel ratio). Returns natural size in points. */
export async function renderPage(doc: PdfDoc, pageNumber: number, canvas: HTMLCanvasElement, cssWidth: number): Promise<{ width: number; height: number }> {
  const page = await doc.getPage(pageNumber)
  const natural = page.getViewport({ scale: 1 })
  const scale = (cssWidth * Math.min(window.devicePixelRatio || 1, 2)) / natural.width
  const viewport = page.getViewport({ scale })
  canvas.width = Math.floor(viewport.width)
  canvas.height = Math.floor(viewport.height)
  await page.render({ canvas, viewport }).promise
  return { width: natural.width, height: natural.height }
}

export async function pageSizes(doc: PdfDoc): Promise<Array<[number, number]>> {
  const out: Array<[number, number]> = []
  for (let i = 1; i <= doc.numPages; i++) {
    const v = (await doc.getPage(i)).getViewport({ scale: 1 })
    out.push([v.width, v.height])
  }
  return out
}
