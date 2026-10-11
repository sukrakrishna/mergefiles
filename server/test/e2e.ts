/* End-to-end tests: starts the real server, uploads real files, and inspects the generated PDFs. */
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PDFDocument } from 'pdf-lib';
import sharp from 'sharp';

const PORT = 3999;
let BASE = `http://127.0.0.1:${PORT}/api`;
const FIX = path.join(import.meta.dirname, 'fixtures');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'maf-e2e-'));

let passed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail = '') {
  if (cond) { passed++; console.log(`  ✔ ${name}`); }
  else { failures.push(name); console.log(`  ✘ ${name} ${detail}`); }
}

async function api(method: string, url: string, body?: unknown) {
  const res = await fetch(BASE + url, { method, headers: body ? { 'content-type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json: any = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, res };
}

async function newSession(): Promise<string> { return (await api('POST', '/sessions')).json.id; }

async function upload(sid: string, names: string[], asName?: Record<string, string>) {
  const fd = new FormData();
  for (const n of names) fd.append('files', new Blob([fs.readFileSync(path.join(FIX, n))]), asName?.[n] ?? n);
  const res = await fetch(`${BASE}/sessions/${sid}/files`, { method: 'POST', body: fd });
  return { status: res.status, json: (await res.json()) as any };
}

async function waitFiles(sid: string, timeoutMs = 180_000) {
  const t0 = Date.now();
  for (;;) {
    const s = (await api('GET', `/sessions/${sid}`)).json;
    if (s.files.every((f: any) => f.status === 'ready' || f.status === 'error')) return s.files as any[];
    if (Date.now() - t0 > timeoutMs) throw new Error('conversion timeout');
    await new Promise((r) => setTimeout(r, 400));
  }
}

async function exportAndWait(sid: string, body: unknown) {
  const start = await api('POST', `/sessions/${sid}/export`, body);
  if (start.status !== 202) return { start, job: null as any };
  for (;;) {
    const job = (await api('GET', `/sessions/${sid}/job`)).json;
    if (job.status !== 'running') return { start, job };
    await new Promise((r) => setTimeout(r, 300));
  }
}

const defaults = (pageCount: number, extra: any = {}) => ({
  pages: Array.from({ length: pageCount }, (_, i) => ({ src: i, rotation: 0, orientation: 'auto' })),
  paper: 'original', fitToPage: true, filename: 'merged_document', target: null, ...extra,
});

async function download(sid: string) {
  const res = await fetch(`${BASE}/sessions/${sid}/download`);
  return { res, bytes: Buffer.from(await res.arrayBuffer()) };
}

function pdftotext(buf: Buffer, page?: number): string {
  const f = path.join(DATA, `t-${Math.random().toString(36).slice(2)}.pdf`);
  fs.writeFileSync(f, buf);
  const args = page ? ['-f', String(page), '-l', String(page), f, '-'] : [f, '-'];
  return execFileSync('pdftotext', args).toString();
}

async function render(buf: Buffer, page: number): Promise<{ w: number; h: number; data: Buffer }> {
  const f = path.join(DATA, `r-${Math.random().toString(36).slice(2)}.pdf`);
  fs.writeFileSync(f, buf);
  const png = execFileSync('pdftoppm', ['-png', '-r', '30', '-f', String(page), '-l', String(page), '-singlefile', f, f + '-out']);
  void png;
  const { data, info } = await sharp(f + '-out.png').greyscale().raw().toBuffer({ resolveWithObject: true });
  return { w: info.width, h: info.height, data };
}
/** Which quadrant holds most dark pixels (the marker square). */
function darkQuadrant({ w, h, data }: { w: number; h: number; data: Buffer }): string {
  const q = { TL: 0, TR: 0, BL: 0, BR: 0 };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (data[y * w + x] < 60) q[`${y < h / 2 ? 'T' : 'B'}${x < w / 2 ? 'L' : 'R'}` as keyof typeof q]++;
  return Object.entries(q).sort((a, b) => b[1] - a[1])[0][0];
}

const A4 = [595.28, 841.89]; const A3 = [841.89, 1190.55];
const near = (a: number, b: number, tol = 1.5) => Math.abs(a - b) <= tol;

function stop(server: ChildProcess) {
  try { process.kill(-server.pid!, 'SIGTERM'); } catch { /* already gone */ }
}

async function startServer(port: number, dataDir: string, env: Record<string, string> = {}): Promise<ChildProcess> {
  const server: ChildProcess = spawn('npx', ['tsx', 'src/index.ts'], {
    shell: process.platform === 'win32',
    cwd: path.join(import.meta.dirname, '..'),
    env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, SESSION_TTL_MIN: '30', ...env },
    stdio: ['ignore', 'pipe', 'inherit'],
    detached: true, // own process group, so stop() also kills the node child that npx/tsx spawns
  });
  for (let i = 0; i < 80; i++) { try { if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) return server; } catch { /* wait */ } await new Promise((r) => setTimeout(r, 300)); }
  throw new Error(`server on ${port} did not start`);
}

async function main() {
  const server = await startServer(PORT, DATA);

  try {
    console.log('\n[1] Two PDFs merged, order preserved');
    let sid = await newSession();
    let up = await upload(sid, ['a.pdf', 'b.pdf']);
    check('upload accepted (202)', up.status === 202 && up.json.files.length === 2);
    let files = await waitFiles(sid);
    check('both files ready with page counts 3 and 2', files.map((f) => f.pageCount).join() === '3,2', JSON.stringify(files));
    const [fa, fb] = files;
    let m = (await api('POST', `/sessions/${sid}/merge`, { order: [fb.id, fa.id] })).json;
    check('merged page count = 5', m.pageCount === 5);
    check('reordered: BRAVO files first', m.pages[0].fileName === 'b.pdf' && m.pages[2].fileName === 'a.pdf');
    let r = await exportAndWait(sid, defaults(5));
    let dl = await download(sid);
    check('download returns application/pdf attachment', dl.res.headers.get('content-type') === 'application/pdf' && /attachment; filename="merged_document.pdf"/.test(dl.res.headers.get('content-disposition') ?? ''));
    let doc = await PDFDocument.load(dl.bytes);
    check('output has 5 pages', doc.getPageCount() === 5);
    check('text order BRAVO,BRAVO,ALPHA,ALPHA,ALPHA', ['BRAVO-PAGE-1', 'BRAVO-PAGE-2', 'ALPHA-PAGE-1', 'ALPHA-PAGE-2', 'ALPHA-PAGE-3'].every((t, i) => pdftotext(dl.bytes, i + 1).includes(t)));
    check('result sizes come from real files', r.job.result.finalSize === dl.bytes.length && r.job.result.pageCount === 5);
    check('originalSize = sum of uploaded sizes', r.job.result.originalSize === fs.statSync(path.join(FIX, 'a.pdf')).size + fs.statSync(path.join(FIX, 'b.pdf')).size);

    console.log('\n[2] PDF + Word + Excel + PowerPoint + images (real conversion)');
    sid = await newSession();
    await upload(sid, ['a.pdf', 'c.docx', 'd.xlsx', 'e.pptx', 'img1.jpg', 'img2.png']);
    files = await waitFiles(sid);
    check('all 6 converted', files.length === 6 && files.every((f) => f.status === 'ready'), JSON.stringify(files.map((f) => [f.name, f.status, f.error])));
    m = (await api('POST', `/sessions/${sid}/merge`, { order: files.map((f) => f.id) })).json;
    check('merged pages = sum of parts', m.pageCount === files.reduce((n, f) => n + f.pageCount, 0), `${m.pageCount}`);
    r = await exportAndWait(sid, defaults(m.pageCount));
    dl = await download(sid);
    const all = pdftotext(dl.bytes);
    check('Word text present in output', all.includes('WORD-DOC-TITLE'));
    check('Excel text present in output', all.includes('EXCEL-HEADER'));
    check('PowerPoint text present (3 slides)', all.includes('PPT-SLIDE-1') && all.includes('PPT-SLIDE-3'));
    doc = await PDFDocument.load(dl.bytes);
    check('output page count matches', doc.getPageCount() === m.pageCount);

    console.log('\n[3] Page reorder + deletion + individual rotation');
    sid = await newSession();
    await upload(sid, ['a.pdf']); files = await waitFiles(sid);
    await api('POST', `/sessions/${sid}/merge`, { order: [files[0].id] });
    r = await exportAndWait(sid, defaults(3, { pages: [{ src: 2, rotation: 0, orientation: 'auto' }, { src: 0, rotation: 90, orientation: 'auto' }] }));
    dl = await download(sid); doc = await PDFDocument.load(dl.bytes);
    check('deleted page 2; 2 pages remain', doc.getPageCount() === 2);
    check('reordered: ALPHA-3 then ALPHA-1', pdftotext(dl.bytes, 1).includes('ALPHA-PAGE-3') && pdftotext(dl.bytes, 2).includes('ALPHA-PAGE-1'));
    check('page 2 rotation = 90, page 1 = 0', doc.getPage(1).getRotation().angle === 90 && doc.getPage(0).getRotation().angle === 0);

    console.log('\n[4] Rotation geometry in the rendered output (marker square top-left)');
    sid = await newSession();
    await upload(sid, ['marker.pdf']); files = await waitFiles(sid);
    await api('POST', `/sessions/${sid}/merge`, { order: [files[0].id] });
    const quad = async (extra: any, rot: number) => {
      await exportAndWait(sid, defaults(1, { pages: [{ src: 0, rotation: rot, orientation: extra.orientation ?? 'auto' }], ...extra.opts }));
      return darkQuadrant(await render((await download(sid)).bytes, 1));
    };
    check('rotation 0   (lossless path) → marker top-left', (await quad({}, 0)) === 'TL');
    check('rotation 90  (lossless path) → marker top-right', (await quad({}, 90)) === 'TR');
    check('rotation 180 (lossless path) → marker bottom-right', (await quad({}, 180)) === 'BR');
    check('rotation 270 (lossless path) → marker bottom-left', (await quad({}, 270)) === 'BL');
    check('rotation 90  (A4 re-layout path) → marker top-right', (await quad({ opts: { paper: 'a4' } }, 90)) === 'TR');
    check('rotation 180 (A4 re-layout path) → marker bottom-right', (await quad({ opts: { paper: 'a4' } }, 180)) === 'BR');
    check('rotation 270 (A4 re-layout path) → marker bottom-left', (await quad({ opts: { paper: 'a4' } }, 270)) === 'BL');
    check('rotation 0   (A4 re-layout path) → marker top-left', (await quad({ opts: { paper: 'a4' } }, 0)) === 'TL');

    console.log('\n[5] Paper size & orientation change the real PDF');
    sid = await newSession();
    await upload(sid, ['a.pdf', 'b.pdf']); files = await waitFiles(sid);
    await api('POST', `/sessions/${sid}/merge`, { order: files.map((f) => f.id) });
    const dims = async (opts: any) => { await exportAndWait(sid, defaults(5, opts)); const d = await PDFDocument.load((await download(sid)).bytes); return d.getPages().map((p) => p.getSize()); };
    let sz = await dims({ paper: 'a4' });
    check('A4 + auto: portrait pages are 595x842, landscape page is 842x595', near(sz[0].width, A4[0]) && near(sz[0].height, A4[1]) && near(sz[3].width, A4[1]) && near(sz[3].height, A4[0]));
    sz = await dims({ paper: 'a3' });
    check('A3: portrait page is 842x1191', near(sz[0].width, A3[0]) && near(sz[0].height, A3[1]));
    sz = await dims({ paper: 'a4', pages: Array.from({ length: 5 }, (_, i) => ({ src: i, rotation: 0, orientation: 'landscape' })) });
    check('A4 + landscape for all: every page 842x595', sz.every((s) => near(s.width, A4[1]) && near(s.height, A4[0])));
    sz = await dims({ paper: 'a4', pages: Array.from({ length: 5 }, (_, i) => ({ src: i, rotation: 0, orientation: 'portrait' })) });
    check('A4 + portrait for all: every page 595x842', sz.every((s) => near(s.width, A4[0]) && near(s.height, A4[1])));
    sz = await dims({ paper: 'a4', pages: [0, 1, 2, 3, 4].map((i) => ({ src: i, rotation: 0, orientation: i === 1 ? 'landscape' : 'auto' })) });
    check('orientation on selected page only: page 2 landscape, page 1 portrait', near(sz[1].width, A4[1]) && near(sz[0].width, A4[0]));
    sz = await dims({ paper: 'original' });
    check('Original keeps source sizes (A4 and US-Letter landscape 792x612)', near(sz[0].width, 595.28) && near(sz[3].width, 792) && near(sz[3].height, 612));
    sz = await dims({ paper: 'original', pages: [0, 1, 2, 3, 4].map((i) => ({ src: i, rotation: 0, orientation: i === 0 ? 'landscape' : 'auto' })) });
    check('Original + landscape on one page swaps that page to 842x595', near(sz[0].width, A4[1]) && near(sz[0].height, A4[0]));
    await exportAndWait(sid, defaults(5, { paper: 'a4' }));
    const fitText = pdftotext((await download(sid)).bytes, 4);
    check('content preserved after A4 re-layout (text still extractable)', fitText.includes('BRAVO-PAGE-1'));

    console.log('\n[6] Compression to custom targets');
    sid = await newSession();
    await upload(sid, ['heavy.pdf', 'a.pdf']); files = await waitFiles(sid);
    check('heavy.pdf (~28 MB) accepted within limits', files.every((f) => f.status === 'ready'), JSON.stringify(files));
    await api('POST', `/sessions/${sid}/merge`, { order: files.map((f) => f.id) });
    const pg = 7;
    const t0 = Date.now();
    r = await exportAndWait(sid, defaults(pg, { target: { bytes: 5_000_000, mode: 'balanced' } }));
    dl = await download(sid);
    console.log(`     5 MB target: final ${dl.bytes.length.toLocaleString()} bytes, met=${r.job.result.targetMet}, ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    console.log('     attempts:', r.job.result.compression.attempts.map((a: any) => `${a.label}=${a.size}`).join(' | '));
    check('5 MB target met and actual size reported honestly', r.job.result.targetMet === true && dl.bytes.length <= 5_000_000 && r.job.result.finalSize === dl.bytes.length);
    check('compressed output still has 7 pages and readable text', (await PDFDocument.load(dl.bytes)).getPageCount() === 7 && pdftotext(dl.bytes, 5).includes('ALPHA-PAGE-1'));
    check('reduction % computed from real sizes', Math.abs(r.job.result.reductionPercent - (1 - dl.bytes.length / r.job.result.originalSize) * 100) < 0.1);
    const small = await render(dl.bytes, 1);
    check('compressed page 1 still renders', small.w > 0);

    r = await exportAndWait(sid, defaults(pg, { target: { bytes: 100_000_000, mode: 'smallest' } }));
    check('already under target → no image recompression, says so', r.job.result.targetMet === true && r.job.result.compression.performed === false && /already within/.test(r.job.result.message), r.job.result.message);

    console.log('\n[7] Impossible target is reported honestly');
    r = await exportAndWait(sid, defaults(pg, { target: { bytes: 20_000, mode: 'smallest' } }));
    dl = await download(sid);
    console.log(`     20 KB target: final ${dl.bytes.length.toLocaleString()} bytes; message: ${r.job.result.message}`);
    check('targetMet === false', r.job.result.targetMet === false);
    check('actual size reported and equals file', r.job.result.finalSize === dl.bytes.length && dl.bytes.length > 20_000);
    check('message does not claim success', /could not be reached/.test(r.job.result.message) && !/Target met/.test(r.job.result.message));
    check('suggests a higher target', r.job.result.suggestions.some((s: string) => /Increase the target/.test(s)));
    r = await exportAndWait(sid, defaults(pg, { target: { bytes: 300_000, mode: 'high' } }));
    check('High Quality mode that cannot reach target suggests stronger mode', r.job.result.targetMet === false && r.job.result.suggestions.some((s: string) => /Balanced or Smallest/.test(s)));

    console.log('\n[7b] Vector-heavy PDF (no images) to 500 KB');
    sid = await newSession();
    await upload(sid, ['vector.pdf']); files = await waitFiles(sid);
    await api('POST', `/sessions/${sid}/merge`, { order: [files[0].id] });
    const vsize = fs.statSync(path.join(FIX, 'vector.pdf')).size;
    r = await exportAndWait(sid, defaults(6, { target: { bytes: 500_000, mode: 'balanced' } }));
    check(`Balanced cannot shrink a pure-vector PDF (${vsize.toLocaleString()} B) to 500 KB → honestly reported`, r.job.result.targetMet === false && r.job.result.compression.rasterized === false);
    check('…and it suggests Smallest Size', r.job.result.suggestions.some((x: string) => /Smallest Size/.test(x)));
    r = await exportAndWait(sid, defaults(6, { target: { bytes: 500_000, mode: 'smallest' } }));
    dl = await download(sid);
    console.log(`     Smallest → ${dl.bytes.length.toLocaleString()} bytes, rasterized=${r.job.result.compression.rasterized}`);
    check('Smallest Size reaches 500 KB via page-to-image fallback', r.job.result.targetMet === true && dl.bytes.length <= 500_000 && r.job.result.finalSize === dl.bytes.length);
    check('result flags rasterization and warns text is not selectable', r.job.result.compression.rasterized === true && /no longer selectable/.test(r.job.result.message));
    doc = await PDFDocument.load(dl.bytes);
    check('6 pages kept at A4 size', doc.getPageCount() === 6 && near(doc.getPage(0).getWidth(), A4[0], 2) && near(doc.getPage(0).getHeight(), A4[1], 2));
    check('output pages render (not blank): dark pixels present', (await render(dl.bytes, 3)).data.some((v) => v < 200));
    r = await exportAndWait(sid, defaults(6, { pages: [0, 1, 2, 3, 4, 5].map((i) => ({ src: i, rotation: i === 0 ? 90 : 0, orientation: 'auto' })), target: { bytes: 500_000, mode: 'smallest' } }));
    doc = await PDFDocument.load((await download(sid)).bytes);
    check('rotation survives the image fallback (page 1 becomes landscape)', doc.getPage(0).getWidth() > doc.getPage(0).getHeight());
    r = await exportAndWait(sid, defaults(6, { target: { bytes: 20_000, mode: 'smallest' } }));
    check('absurd 20 KB target on it is still reported as not reached', r.job.result.targetMet === false && /could not be reached/.test(r.job.result.message));

    console.log('\n[8] Invalid / corrupted / malicious files');
    sid = await newSession();
    up = await upload(sid, ['corrupt.pdf', 'fake.pdf', 'notes.txt', 'encrypted.pdf', 'corrupt.docx', 'a.pdf'], {});
    files = await waitFiles(sid);
    const byName = Object.fromEntries(files.map((f) => [f.name, f]));
    check('plain .txt rejected at upload', up.json.rejected.some((x: any) => x.name === 'notes.txt'));
    check('exe disguised as .pdf rejected by content check', up.json.rejected.some((x: any) => x.name === 'fake.pdf' && /does not match/.test(x.reason)));
    check('corrupt PDF reported as error, session survives', byName['corrupt.pdf']?.status === 'error', JSON.stringify(byName['corrupt.pdf']));
    check('password-protected PDF reported as error', byName['encrypted.pdf']?.status === 'error' && /password/i.test(byName['encrypted.pdf'].error));
    check('corrupt .docx reported as error', byName['corrupt.docx']?.status === 'error', JSON.stringify(byName['corrupt.docx']));
    check('good file in the same batch still ready', byName['a.pdf']?.status === 'ready');
    const mm = await api('POST', `/sessions/${sid}/merge`, { order: [byName['a.pdf'].id] });
    check('can still merge the good file', mm.json.pageCount === 3);
    const bad = await api('POST', `/sessions/${sid}/merge`, { order: [byName['corrupt.pdf'].id] });
    check('merging a failed file is refused (409)', bad.status === 409);
    up = await upload(sid, ['img2.png'], { 'img2.png': '../../etc/passwd.png' });
    check('path-traversal filename is neutralised', up.json.files[0]?.name === 'passwd.png', JSON.stringify(up.json));

    console.log('\n[8b] Files without an extension are detected by content');
    const sidBeforeExt = sid; // section 9 reuses the merged session from section 8
    sid = await newSession();
    const noExt: Record<string, string> = {
      'a.pdf': 'Document from Sukran', 'img2.png': 'Photo 1', 'img1.jpg': 'Scan 12.03',
      'c.docx': 'Letter', 'd.xlsx': 'Budget', 'e.pptx': 'Slides',
    };
    up = await upload(sid, Object.keys(noExt), noExt);
    const gotExt = Object.fromEntries((up.json.files as any[]).map((f) => [f.name, f.ext]));
    check('all six extension-less files accepted', up.json.files.length === 6 && up.json.rejected.length === 0, JSON.stringify(up.json));
    check('PDF gets .pdf appended', gotExt['Document from Sukran.pdf'] === 'pdf', JSON.stringify(gotExt));
    check('PNG gets .png appended', gotExt['Photo 1.png'] === 'png');
    check('JPEG gets .jpg appended (name with numeric dot suffix)', gotExt['Scan 12.03.jpg'] === 'jpg');
    check('DOCX gets .docx appended', gotExt['Letter.docx'] === 'docx');
    check('XLSX gets .xlsx appended', gotExt['Budget.xlsx'] === 'xlsx');
    check('PPTX gets .pptx appended', gotExt['Slides.pptx'] === 'pptx');
    files = await waitFiles(sid);
    check('extension-less files convert to PDF', files.length === 6 && files.every((f) => f.status === 'ready'), JSON.stringify(files.map((f) => [f.name, f.status, f.error])));
    up = await upload(sid, ['notes.txt'], { 'notes.txt': 'Notes from phone' });
    check('extension-less text content rejected', up.json.rejected.length === 1 && /not supported/.test(up.json.rejected[0].reason), JSON.stringify(up.json));
    up = await upload(sid, ['c.docx'], { 'c.docx': 'report.pdf' });
    check('.pdf name with DOCX content rejected', up.json.rejected.length === 1 && /does not match/.test(up.json.rejected[0].reason), JSON.stringify(up.json));
    up = await upload(sid, ['a.pdf'], { 'a.pdf': 'archive.zip' });
    check('clearly unsupported extension (.zip) rejected even with PDF content', up.json.rejected.length === 1 && /Unsupported file type/.test(up.json.rejected[0].reason), JSON.stringify(up.json));
    {
      const cfb = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(1024)]);
      const fd = new FormData();
      fd.append('files', new Blob([cfb]), 'Old document');
      const res = await fetch(`${BASE}/sessions/${sid}/files`, { method: 'POST', body: fd });
      const j: any = await res.json();
      check('legacy Office content without extension gets the rename hint', j.rejected?.length === 1 && /old Office file\. Rename it to end in \.doc, \.xls or \.ppt/.test(j.rejected[0].reason), JSON.stringify(j));
    }

    sid = sidBeforeExt;

    console.log('\n[9] Input validation, session isolation, cleanup');
    const trav = await api('GET', '/sessions/..%2F..%2Fetc');
    check('path-traversal session id → 404 JSON error (never touches disk)', trav.status === 404 && typeof trav.json?.error === 'string', `${trav.status}`);
    const trav2 = await api('GET', '/sessions/' + encodeURIComponent('../../../../etc/pas'));
    check('traversal-shaped id of any length → 404', trav2.status === 404, `${trav2.status}`);
    check('unknown session → 404', (await api('GET', '/sessions/AAAAAAAAAAAAAAAAAAAAA')).status === 404);
    let v = await api('POST', `/sessions/${sid}/export`, defaults(3, { pages: [{ src: 99, rotation: 0, orientation: 'auto' }] }));
    check('out-of-range page rejected (400)', v.status === 400);
    v = await api('POST', `/sessions/${sid}/export`, defaults(3, { pages: [{ src: 0, rotation: 45, orientation: 'auto' }] }));
    check('invalid rotation rejected (400)', v.status === 400);
    v = await api('POST', `/sessions/${sid}/export`, defaults(3, { target: { bytes: 10, mode: 'balanced' } }));
    check('absurd target rejected (400)', v.status === 400);
    const sessionDir = path.join(DATA, 'sessions', sid);
    check('session dir exists before delete', fs.existsSync(sessionDir));
    check('DELETE session returns 204', (await api('DELETE', `/sessions/${sid}`)).status === 204);
    check('session dir actually removed from disk', !fs.existsSync(sessionDir));
    check('session gone after delete (404)', (await api('GET', `/sessions/${sid}`)).status === 404);

    console.log('\n[10] Configurable limits are enforced');
    const DATA2 = fs.mkdtempSync(path.join(os.tmpdir(), 'maf-e2e2-'));
    const s2 = await startServer(3998, DATA2, { MAX_FILE_MB: '1', MAX_FILES: '3', MAX_PAGES: '4', RATE_LIMIT_HEAVY_MAX: '40' });
    BASE = 'http://127.0.0.1:3998/api';
    try {
      sid = await newSession();
      let u = await upload(sid, ['img1.jpg']);
      check('file over MAX_FILE_MB → 413 with clear message', u.status === 413 && /larger than the 1 MB limit/.test(u.json.error), JSON.stringify(u.json));
      u = await upload(sid, ['a.pdf', 'b.pdf', 'c.docx', 'd.xlsx']);
      check('more than MAX_FILES in one request → 413', u.status === 413, JSON.stringify(u.json));
      sid = await newSession();
      await upload(sid, ['a.pdf', 'b.pdf']);
      files = await waitFiles(sid);
      const over = await api('POST', `/sessions/${sid}/merge`, { order: files.map((f) => f.id) });
      check('merged pages over MAX_PAGES (3+2 > 4) → 422', over.status === 422 && /limit/.test(over.json.error), JSON.stringify(over.json));
      await upload(sid, ['c.docx']); await upload(sid, ['d.xlsx']);
      await waitFiles(sid);
      u = await upload(sid, ['e.pptx']);
      check('MAX_FILES across the session enforced (rejected with reason)', u.json.rejected?.length === 1 && /up to 3 files/.test(u.json.rejected[0].reason), JSON.stringify(u.json));
      let limited = 0;
      for (let i = 0; i < 60; i++) if ((await api('POST', '/sessions')).status === 429) limited++;
      check('rate limiter returns 429 when the heavy-route limit is exceeded', limited > 0, `${limited} limited`);
    } finally { stop(s2); fs.rmSync(DATA2, { recursive: true, force: true }); }

    console.log('\n[11] Retention: idle sessions are deleted from disk by the sweeper');
    const DATA3 = fs.mkdtempSync(path.join(os.tmpdir(), 'maf-e2e3-'));
    const s3 = await startServer(3997, DATA3, { SESSION_TTL_MIN: '0.05', SWEEP_INTERVAL_SEC: '1' });
    BASE = 'http://127.0.0.1:3997/api';
    try {
      sid = await newSession();
      await upload(sid, ['a.pdf']); await waitFiles(sid);
      const dir3 = path.join(DATA3, 'sessions', sid);
      check('session files exist right after upload', fs.existsSync(dir3) && fs.readdirSync(path.join(dir3, 'uploads')).length === 1);
      await new Promise((r) => setTimeout(r, 7000));
      check('after TTL (3 s idle) the session directory is gone from disk', !fs.existsSync(dir3));
      check('and the session no longer exists via the API', (await api('GET', `/sessions/${sid}`)).status === 404);
    } finally { stop(s3); fs.rmSync(DATA3, { recursive: true, force: true }); }
  } finally {
    stop(server);
    fs.rmSync(DATA, { recursive: true, force: true });
  }

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) { console.log('FAILED:\n - ' + failures.join('\n - ')); process.exit(1); }
}

main().catch((e) => { console.error(e); process.exit(1); });
