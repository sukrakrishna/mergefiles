import fs from 'node:fs/promises';
import { PDFDocument, degrees } from 'pdf-lib';
import { stripAnnotations } from './merge.js';

export type Paper = 'original' | 'a4' | 'a3';
export type Orient = 'auto' | 'portrait' | 'landscape';
export type Rotation = 0 | 90 | 180 | 270;

export interface PageSpec { src: number; rotation: Rotation; orientation: Orient }
export interface LayoutOptions { pages: PageSpec[]; paper: Paper; fitToPage: boolean; title: string }

// Portrait dimensions in PDF points (1/72 in)
export const PAPER_PORTRAIT: Record<Exclude<Paper, 'original'>, [number, number]> = {
  a4: [595.276, 841.89],
  a3: [841.89, 1190.551],
};

/** Final page size for content whose visible (post-rotation) size is vw x vh. Mirrored in the client preview. */
export function targetSize(vw: number, vh: number, paper: Paper, orientation: Orient): [number, number] {
  let [tw, th] = paper === 'original' ? [vw, vh] : PAPER_PORTRAIT[paper];
  if (orientation === 'portrait' && tw > th) [tw, th] = [th, tw];
  else if (orientation === 'landscape' && th > tw) [tw, th] = [th, tw];
  else if (orientation === 'auto' && paper !== 'original' && vw > vh && th > tw) [tw, th] = [th, tw];
  return [tw, th];
}

export interface BuiltLayout {
  bytes: Uint8Array;
  orientations: Array<'portrait' | 'landscape'>;
  sizes: Array<[number, number]>;
}

/**
 * Builds the output PDF from the merged document: applies page order/deletion (via the spec list),
 * rotation, paper size, orientation and fit-to-page. Rotation, size and orientation all change the real PDF.
 */
export async function buildLayout(mergedPath: string, opts: LayoutOptions): Promise<BuiltLayout> {
  const src = await PDFDocument.load(await fs.readFile(mergedPath), { updateMetadata: false });
  const out = await PDFDocument.create({ updateMetadata: false });
  const orientations: BuiltLayout['orientations'] = [];
  const sizes: BuiltLayout['sizes'] = [];

  const lossless = opts.paper === 'original' && opts.pages.every((p) => p.orientation === 'auto');

  if (lossless) {
    // No re-layout needed: copy pages as-is and only set the rotation flag (keeps content untouched).
    const copied = await out.copyPages(src, opts.pages.map((p) => p.src));
    copied.forEach((page, i) => {
      const total = (page.getRotation().angle + opts.pages[i].rotation) % 360;
      page.setRotation(degrees(total));
      stripAnnotations(page);
      out.addPage(page);
      const { width, height } = page.getSize();
      const swap = total % 180 === 90;
      const [vw, vh] = swap ? [height, width] : [width, height];
      sizes.push([vw, vh]);
      orientations.push(vw > vh ? 'landscape' : 'portrait');
    });
  } else {
    // Embed every needed source page in ONE call so fonts/images shared between pages are copied once.
    // (Embedding page by page copies the shared resources again for every page and bloats the file.)
    const uniq = [...new Set(opts.pages.map((p) => p.src))];
    const embeddedPages = await out.embedPages(uniq.map((i) => src.getPage(i)));
    const embeddedBySrc = new Map(uniq.map((i, k) => [i, embeddedPages[k]]));
    for (const spec of opts.pages) {
      const srcPage = src.getPage(spec.src);
      const embedded = embeddedBySrc.get(spec.src)!;
      const w = embedded.width;
      const h = embedded.height;
      const R = (srcPage.getRotation().angle + spec.rotation) % 360;
      const [vw, vh] = R % 180 === 90 ? [h, w] : [w, h];
      const [tw, th] = targetSize(vw, vh, opts.paper, spec.orientation);
      const s = opts.fitToPage ? Math.min(tw / vw, th / vh) : 1;
      const W = w * s;
      const H = h * s;
      const ox = (tw - vw * s) / 2;
      const oy = (th - vh * s) / 2;
      // Clockwise rotation R about the embedded page's origin, then translate the rotated box into place.
      const [tx, ty] =
        R === 0 ? [ox, oy] : R === 90 ? [ox, oy + W] : R === 180 ? [ox + W, oy + H] : [ox + H, oy];
      const page = out.addPage([tw, th]);
      page.drawPage(embedded, { x: tx, y: ty, xScale: s, yScale: s, rotate: degrees(-R) });
      sizes.push([tw, th]);
      orientations.push(tw > th ? 'landscape' : 'portrait');
    }
  }

  out.setProducer('MergeAnyFile');
  out.setCreator('MergeAnyFile');
  out.setTitle(opts.title);
  const bytes = await out.save({ useObjectStreams: true });
  return { bytes, orientations, sizes };
}
