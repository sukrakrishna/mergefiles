import fs from 'node:fs'; import path from 'node:path'; import os from 'node:os';
import { PDFDocument } from 'pdf-lib';
import { convertToPdf } from '../src/convert.js';
import { buildLayout } from '../src/layout.js';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'b-')); for (const d of ['converted', 'work']) fs.mkdirSync(path.join(dir, d));
const src = process.argv[2];
const conv = await convertToPdf(src, src.endsWith('.pdf') ? 'pdf' : src.endsWith('.docx') ? 'word' : 'powerpoint', dir, 'x');
const n = conv.pageCount;
console.log('source', fs.statSync(src).size, 'converted pdf', fs.statSync(conv.pdfPath).size, 'pages', n);
for (const paper of ['original', 'a4'] as const) for (const o of ['auto', 'landscape'] as const) {
  if (paper === 'original' && o === 'auto') { const b = await buildLayout(conv.pdfPath, { pages: Array.from({length:n},(_,i)=>({src:i,rotation:0,orientation:'auto'})), paper, fitToPage: true, title: 't' }); console.log(paper, o, b.bytes.length); continue; }
  const b = await buildLayout(conv.pdfPath, { pages: Array.from({length:n},(_,i)=>({src:i,rotation:0,orientation:o})), paper, fitToPage: true, title: 't' });
  console.log(paper, o, b.bytes.length);
}
