import fs from 'node:fs/promises';
import path from 'node:path';
import { PDFDocument, PDFName } from 'pdf-lib';
import { config } from './config.js';
import { HttpError } from './util.js';
import type { Session, MergedInfo, MergedPage } from './sessions.js';

/** Interactive elements (links, form widgets, JavaScript actions) are dropped from copied pages. */
export function stripAnnotations(page: ReturnType<PDFDocument['getPage']>): void {
  page.node.delete(PDFName.of('Annots'));
}

export async function mergeSessionFiles(session: Session, order: string[]): Promise<MergedInfo> {
  if (!order.length) throw new HttpError(400, 'Add at least one file to merge.');
  if (new Set(order).size !== order.length) throw new HttpError(400, 'The file order contains duplicates.');

  const recs = order.map((id) => {
    const rec = session.files.get(id);
    if (!rec) throw new HttpError(400, 'One of the files is no longer available.');
    if (rec.status !== 'ready' || !rec.pdfPath) throw new HttpError(409, `"${rec.name}" is not ready yet.`);
    return rec;
  });

  const total = recs.reduce((n, r) => n + (r.pageCount ?? 0), 0);
  if (total > config.maxPages) throw new HttpError(422, `The combined document would have ${total} pages; the limit is ${config.maxPages}.`);

  const out = await PDFDocument.create({ updateMetadata: false });
  const pages: MergedPage[] = [];
  for (const rec of recs) {
    const src = await PDFDocument.load(await fs.readFile(rec.pdfPath!), { updateMetadata: false, throwOnInvalidObject: false });
    for (let i = 0; i < src.getPageCount(); i++) {
      // Pull inherited attributes (MediaBox, Rotate, Resources) onto the page so the copy is self-contained.
      (src.getPage(i).node as unknown as { normalize(): void }).normalize();
    }
    const copied = await out.copyPages(src, src.getPageIndices());
    copied.forEach((p, i) => {
      stripAnnotations(p);
      out.addPage(p);
      pages.push({ index: pages.length, fileId: rec.id, fileName: rec.name, pageInFile: i + 1 });
    });
  }
  out.setProducer('MergeAnyFile');
  out.setCreator('MergeAnyFile');

  const version = (session.merged?.version ?? 0) + 1;
  const outPath = path.join(session.dir, `merged-${version}.pdf`);
  const bytes = await out.save({ useObjectStreams: true });
  await fs.writeFile(outPath, bytes);
  if (session.merged) await fs.rm(session.merged.path, { force: true });

  const info: MergedInfo = {
    path: outPath,
    size: bytes.byteLength,
    originalSize: recs.reduce((n, r) => n + r.size, 0),
    pageCount: pages.length,
    pages,
    version,
  };
  session.merged = info;
  return info;
}
