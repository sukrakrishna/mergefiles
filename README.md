# MergeAnyFile

Upload PDFs, Word, Excel, PowerPoint and images → merge them into one PDF → rearrange / rotate / delete pages →
choose A4, A3 or original size and portrait/landscape → compress toward a target size (KB/MB) → download.

Everything runs through a real backend. Nothing in the UI is a mock: rotation, paper size, orientation and compression all
change the PDF that is generated, and every number on the results page is measured from the actual files.

```
client/   React + Vite + TypeScript UI  (PDF.js previews, dnd-kit drag & drop)
server/   Node + Express + TypeScript API
  src/validate.ts   server-side type validation (extension + magic bytes)
  src/convert.ts    DOC/XLS/PPT(X) via LibreOffice headless, images via Sharp, PDF inspection
  src/merge.ts      merge in the user's file order (pdf-lib)
  src/layout.ts     page order/deletion, rotation, paper size, orientation, fit-to-page (pdf-lib)
  src/compress.ts   qpdf lossless optimisation + Ghostscript image recompression search
  src/exporter.ts   export job, honest result reporting
  src/sessions.ts   per-session temp storage, expiry sweeper, cleanup
  src/routes.ts     REST API, rate limiting, upload handling
  test/             end-to-end API tests, browser (Playwright) UI tests, fixture generator
```

## Requirements

| Needed | Why | Install (Debian/Ubuntu) |
|---|---|---|
| Node.js 20+ (22 tested) | server and build | https://nodejs.org |
| **LibreOffice** (`soffice`) | Word / Excel / PowerPoint → PDF | `apt install libreoffice-writer libreoffice-calc libreoffice-impress` |
| **Ghostscript** (`gs`) | image downsampling / recompression | `apt install ghostscript` |
| **qpdf** | lossless structure optimisation | `apt install qpdf` |
| Fonts | LibreOffice output only looks right if the document's fonts exist | `apt install fonts-liberation fonts-dejavu-core fonts-noto-core` |

### Windows and macOS

The server looks for the three tools at startup (on `PATH`, then in the usual install folders such as `C:\Program Files\LibreOffice\program\soffice.exe`
and `C:\Program Files\gs\gs*\bin\gswin64c.exe`) and prints what it found. Install them with winget if needed:

```powershell
winget install TheDocumentFoundation.LibreOffice
winget install ArtifexSoftware.GhostScript
winget install QPDF.QPDF
```

If a tool lives somewhere unusual, set `SOFFICE_BIN`, `GS_BIN` or `QPDF_BIN` to its full path. The app shows a banner in the UI when
LibreOffice or Ghostscript is missing, and reports a clear reason instead of a generic conversion error. Restart the server after installing.

Without LibreOffice, Office files are reported as failed (PDF and images still work). Without Ghostscript, compression cannot
recompress images, so targets that need it will be reported as not reached. Without qpdf, only the Ghostscript step is used.

## Run it

```bash
npm run install:all
npm run build                 # builds client/dist and server/dist
cd server && PORT=3001 node dist/index.js    # serves the API and the built UI on http://localhost:3001
```

Development with hot reload: `npm run dev:server` (port 3001) and `npm run dev:client` (port 5173, proxies `/api`).

Configuration is by environment variables; see [`.env.example`](.env.example) for all of them with defaults
(upload size / file count / page limits, retention time, timeouts, concurrency, rate limits, binary paths).

## How it works

1. **Upload** (`POST /api/sessions/:id/files`): the browser sends each file in its own request (3 in parallel, with real byte
   progress and a per-file Retry). Each file is checked server-side: supported extension *and* matching content
   (magic bytes), size and count limits. A name with no extension (phone exports such as "Document from Sam") is accepted when
   its content is a PDF, JPG, PNG, DOCX, XLSX or PPTX; the detected extension is appended to the name. Legacy Office files need
   a `.doc`/`.xls`/`.ppt` name. Files are stored under random names; the client's filename is only a display label.
   Accepted files convert in the background (2 at a time); the UI polls and shows Waiting / Converting / Ready / Failed.
   A failed file never affects the others.
2. **Merge** (`POST …/merge`): converted PDFs are combined in the order the user set.
3. **Edit**: the browser shows PDF.js thumbnails. Page order, deletions, per-page rotation and per-page orientation are sent
   with the export request, together with paper size and fit-to-page.
4. **Export** (`POST …/export` → poll `GET …/job`): builds the real PDF, then compresses. The progress panel shows the stage
   the server is actually executing; there is no percentage because the server can't know it in advance.
5. **Download** (`GET …/download`) and inline preview (`GET …/output.pdf`).

### Page layout rules
* **Original + Keep each** → pages are copied untouched; rotation only sets the page's rotation flag (lossless).
* **A4 / A3 or forced Portrait/Landscape** → each page is redrawn onto a new page of the target size. *Fit to page* scales
  content to fit without clipping (scaling up or down); with it off, content keeps its scale, is centred, and may be clipped.
* **Keep each** orientation on A4/A3 picks portrait or landscape per page from the content's shape.
* Rotation is clockwise: 90°, 180°, 270° (= 90° counter-clockwise) for one page, selected pages or all pages.

### Compression
Sizes are **decimal** (1 KB = 1,000 bytes, 1 MB = 1,000,000 bytes), so a file that meets a target also meets it on portals that
count in binary units.

1. Measure the layout PDF. 2. qpdf lossless optimisation (object streams, Flate recompression, unused resources).
3. If it is already ≤ target, stop: **image quality is not touched**.
4. Otherwise Ghostscript recompresses images using a ladder of settings from 300 dpi down to 48 dpi. Each mode owns a slice:
   High Quality (≥150 dpi), Balanced (≥100 dpi), Smallest Size (down to 48 dpi). The strongest setting of the slice is tried
   first; if even that is too big the target is reported as not reached, otherwise the server searches for the *mildest*
   setting that fits. Every candidate is measured, never estimated.
5. **Smallest Size only, last resort:** some PDFs (vector drawings, maps, CAD plans, heavy fonts) contain almost no images,
   so image recompression barely helps. If the target is still not met, every page is rendered to a JPEG (150 → 48 dpi, mildest
   setting that fits) and the PDF is rebuilt from those pictures. This almost always reaches the target but **text is no longer
   selectable or searchable**; the result page says so in a warning. Rotation, paper size and orientation are kept.
6. If the target can't be reached, the result says so, shows the true size, lists what was tried, suggests a higher target and
   a stronger mode, and offers one-click retry buttons.

High Quality and Balanced never convert pages to images. A text-only or vector-only PDF therefore may not reach a small
target in those modes; the result then suggests Smallest Size or a larger target.

## Deployment

MergeAnyFile can run as one process (Express serves the built UI, the default) or split: the React client on a static host such
as Vercel and the Node server in a container elsewhere (the included `Dockerfile` has LibreOffice, Ghostscript and qpdf installed).

### One container on Render (API and website together)

The simplest deployment is a single Docker container that serves both the API and the website; no client hosting or CORS setup is needed.

* **Render:** New → Web Service → connect this repository → Runtime **Docker** (it uses the root `Dockerfile`).
  Region **Singapore**, an instance type with **at least 2 GB RAM** (LibreOffice and Ghostscript are memory-hungry), **1 instance**
  (sessions live in memory and on local disk, so do not scale out).
  Environment: `TRUST_PROXY=1`. Health check path: `/api/health`.
* **Locally with Docker:**
  ```bash
  docker build -t mergeanyfile .
  docker run --rm -p 3001:3001 -v maf-data:/data mergeanyfile
  ```
  Then open http://localhost:3001.
* **Tools:** the app needs LibreOffice, Ghostscript and qpdf. The Docker image installs all three. Without Docker (for example
  on Windows) install them yourself, see [Windows and macOS](#windows-and-macos).

### Reading the logs on Render

* `[upload] POST /api/sessions/:id/files status=… content_length=… ms=… rss_mb=…` is logged for every upload. `status=aborted`
  means the client or a proxy closed the connection before the response; `error="…"` shows what the server threw.
* `[info] startup rss … MB` appearing again means the instance restarted (redeploy, crash or out of memory). Sessions are kept in
  memory, so a restart ends them. `[fatal] uncaughtException` / `[error] unhandledRejection` carry a stack trace.
* `[info] SIGTERM: no new connections…` / `all connections closed` show a graceful redeploy: in-flight uploads get up to 25 s.
* The server sets `keepAliveTimeout=65 s`, `headersTimeout=66 s` and no request timeout, so it outlasts the proxy's idle timeout
  and slow mobile uploads are not cut off.

### Server (Docker or any Node host)

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3001` | Port to listen on. Use the host's health check `GET /api/health` (cheap, no auth). |
| `DATA_DIR` | `./data` (`/data` in Docker) | Temporary session files. Wiped on start; mount a volume with enough free space. |
| `CORS_ORIGIN` | empty (CORS off) | **Required for a split deployment.** The exact origin of the client, e.g. `https://mergeanyfile.vercel.app`. Several origins are allowed, comma-separated (production plus preview URLs). No wildcards, no paths, trailing slashes are ignored. |
| `TRUST_PROXY` | `0` | Set to `1` when the host puts one reverse proxy in front of the container (Render, Fly, Railway, nginx, ...). Without it every request appears to come from the proxy's IP and the per-IP rate limits apply to all users together. Use the number of proxy hops; avoid `true`. |
| `SESSION_TTL_MIN` | `30` | Minutes of inactivity before a session and its files are deleted. |
| `MAX_FILE_MB`, `MAX_FILES`, `MAX_TOTAL_MB`, `MAX_PAGES`, `MAX_SESSIONS`, `MAX_IMAGE_MEGAPIXELS` | `50`, `20`, `200`, `500`, `200`, `100` | Upload and resource limits. |
| `RATE_LIMIT_WINDOW_MIN`, `RATE_LIMIT_MAX`, `RATE_LIMIT_HEAVY_MAX` | `15`, `3000`, `1000` | Per-IP rate limits. |
| `GS_BIN`, `SOFFICE_BIN`, `QPDF_BIN` | auto-detect | Not needed in Docker (the tools are on `PATH`). Only for Windows or unusual installs. |

See [`.env.example`](.env.example) for every variable. The server does not read `.env` files; set real environment variables.

```bash
docker build -t mergeanyfile .
docker run -p 3001:3001 -v mergeanyfile-data:/data   -e CORS_ORIGIN=https://mergeanyfile.vercel.app -e TRUST_PROXY=1 mergeanyfile
```

Notes for the split setup:
* The backend must be served over **HTTPS**, otherwise browsers block its calls from an HTTPS Vercel page (mixed content).
* No cookies are used. The session ID travels in the URL, so CORS is configured without credentials.
* The result page's *Download PDF* is a plain link to the backend with `Content-Disposition: attachment`; it works cross-origin.
* The backend's own CSP/helmet headers only govern pages the backend itself serves. They do not restrict the Vercel page, and the
  client loads PDFs with `fetch` (CORS) and a same-origin PDF.js worker, so no CSP change is needed on the server. If you add a CSP
  to the Vercel site, its `connect-src` must include the backend origin.
* Do not proxy `/api` through Vercel: uploads would hit its request body size limit.

### Client (Vercel)

1. Import the repository, set the project's **Root Directory** to `client`. Build command `npm run build`, output `dist` (auto-detected for Vite).
2. Set the environment variable **`VITE_API_URL`** to the backend origin, without a trailing slash, e.g. `https://your-backend.example.com`.
   It is read at build time, so redeploy after changing it. When it is unset the client calls `/api` on its own origin (local development
   and the single-process deployment are unchanged).
3. [`client/vercel.json`](client/vercel.json) contains only the SPA fallback rewrite to `index.html`.
4. Add the Vercel URL to the server's `CORS_ORIGIN`.

## Security and privacy
* Uploads are untrusted: extension + magic-byte validation, per-file / total / count / page / megapixel limits, random on-disk
  names, session IDs validated against a strict pattern (no path traversal), output filenames sanitised.
* LibreOffice runs without a shell, in a throw-away profile directory, with a hard timeout (the process group is killed),
  limited concurrency. Ghostscript runs with `-dSAFER`. qpdf/Ghostscript/LibreOffice also get timeouts.
* PDF **links, form fields and JavaScript actions are removed** from output (pages are copied without annotations).
* Helmet security headers with a strict CSP; rate limiting per IP (stricter on upload/merge/export).
* A session is identified by an unguessable 21-character random ID (no accounts). Anyone holding the ID can read that session.
* **Retention (this is what the code does):** all of a session's files live in `DATA_DIR/sessions/<id>/`. They are deleted
  **`SESSION_TTL_MIN` minutes (default 30) after the last request for that session**, or **immediately** when the user clicks
  *Start another task*. Closing the browser does *not* delete earlier. All data is also wiped on server start. Files are
  not encrypted at rest.

## Interface

A workbench-style layout (app bar with step track, merge-order table, page canvas with inspector, size ladder on the compress and result steps), Geist and
Geist Mono bundled locally (no external font requests), light and dark themes (follows the system, toggle in the app bar), keyboard focus states,
reduced-motion support, and responsive down to phone width.

## Tests
```bash
npm run fixtures     # generates real sample files (needs python3 with reportlab, python-docx, openpyxl, python-pptx, pillow, pypdf)
npm run test:api     # 80 end-to-end API checks; starts its own servers (:3999, :3998, :3997) and inspects the generated PDFs
# UI tests drive headless Chromium (python3 + playwright) against a running server:
BASE=http://127.0.0.1:3001 npm run test:ui
```
The API suite verifies, on real output files: merge order and page counts; Word/Excel/PowerPoint/image conversion (text present
in output); reorder/delete/rotate; rotation geometry by rendering pages and locating a marker; A4/A3/original and
portrait/landscape page sizes; compression to a 5 MB target on a 28 MB PDF; a pure-vector PDF reaching 500 KB only via the image fallback (and not in Balanced); an impossible 20 KB target reported honestly;
corrupt, disguised, encrypted and path-traversal files; input validation; the configurable size/count/page limits and the rate limiter; and that both explicit deletion and the idle-expiry sweeper remove a session's files from disk.

## Known limitations
* **Single server instance.** Sessions live in memory and files on local disk. Scaling out needs sticky routing or shared storage.
* Office conversion fidelity is LibreOffice's; documents with unusual fonts/features may render differently from Microsoft Office.
* LibreOffice is time-limited but not memory-limited by the app. In production run it in a container with CPU/memory limits and no
  outbound network. A `Dockerfile` is included but **was not built or run** where this project was developed.
* Password-protected files are rejected, not unlocked. Links/forms/JavaScript in PDFs are dropped.
* PNG/JPG inputs are re-encoded as JPEG (quality 88, max 3508 px longest side, transparency flattened onto white).
* Paper size is document-wide; orientation and rotation can be per page.
* Tested in Chromium (headless) only; the layout was checked at 1360 px and 390 px widths. Not load-tested.
* The UI uses PDF.js' *legacy* build for compatibility with browsers that lack newer JavaScript features.
