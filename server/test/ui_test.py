"""Drives the real UI in headless Chromium against a running server (default http://127.0.0.1:3001)."""
import os, re, sys, io
from playwright.sync_api import sync_playwright, expect
from pypdf import PdfReader

BASE = os.environ.get('BASE', 'http://127.0.0.1:3001')
FIX = os.path.join(os.path.dirname(__file__), 'fixtures')
SHOTS = os.environ.get('SHOTS', '/tmp/maf-shots'); os.makedirs(SHOTS, exist_ok=True)
F = lambda *n: [os.path.join(FIX, x) for x in n]
passed, failed = 0, []

def check(name, cond, detail=''):
    global passed
    if cond: passed += 1; print('  ✔', name)
    else: failed.append(name); print('  ✘', name, detail)

def wait_count(loc, n, timeout=30000):
    import time
    t0 = time.time()
    while time.time() - t0 < timeout / 1000:
        if loc.count() >= n: return True
        time.sleep(0.25)
    return False

def act(thumb, label):
    thumb.hover(); thumb.get_by_label(label).click()

def shot(page, name): page.screenshot(path=os.path.join(SHOTS, name + '.png'), full_page=True)

with sync_playwright() as p:
    browser = p.chromium.launch()
    ctx = browser.new_context(viewport={'width': 1360, 'height': 900}, accept_downloads=True)
    page = ctx.new_page()
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None)

    print('\n[UI 1] Upload, validate, reorder, remove')
    page.goto(BASE)
    check('main heading', page.locator('h1').inner_text() == 'Merge files. Make one PDF.')
    check('subtitle', 'Combine documents, organize pages, and compress your files in one place.' in page.content())
    page.set_input_files('input[type=file]', F('a.pdf', 'b.pdf', 'c.docx', 'e.pptx', 'img1.jpg'))
    expect(page.locator('.file-row')).to_have_count(5)
    expect(page.locator('.chip-ready')).to_have_count(5, timeout=120000)
    check('5 files ready (PDF/Word/PowerPoint/image converted)', True)
    names = lambda: [t.strip() for t in page.locator('.file-name').all_inner_texts()]
    check('initial order', names() == ['a.pdf', 'b.pdf', 'c.docx', 'e.pptx', 'img1.jpg'], str(names()))
    # keyboard reorder: move b.pdf above a.pdf
    page.locator('.file-row').nth(1).locator('.grip').focus()
    page.keyboard.press('Space'); page.wait_for_timeout(250)
    page.keyboard.press('ArrowUp'); page.wait_for_timeout(250)
    page.keyboard.press('Space'); page.wait_for_timeout(500)
    check('reorder changes list order (b.pdf first)', names()[:2] == ['b.pdf', 'a.pdf'], str(names()))
    page.locator('.file-row', has_text='e.pptx').get_by_label('Remove e.pptx').click()
    expect(page.locator('.file-row')).to_have_count(4)
    check('remove deletes the file', 'e.pptx' not in names())
    # invalid uploads
    page.set_input_files('input[type=file]', F('fake.pdf', 'corrupt.pdf'))
    expect(page.locator('.toast-error').first).to_be_visible(timeout=15000)
    check('disguised file rejected with visible error toast', 'does not match' in page.locator('.toasts').inner_text())
    expect(page.locator('.chip-error')).to_have_count(1, timeout=30000)
    check('corrupt PDF shown as Failed (others unaffected)', page.locator('.chip-ready').count() == 4)
    shot(page, '01-upload')

    print('\n[UI 2] Merge → page editor')
    page.get_by_role('button', name='Merge & edit pages').click()
    page.wait_for_selector('.thumb', timeout=30000)
    n = page.locator('.thumb').count()
    check(f'editor shows thumbnails ({n} pages)', n >= 7, str(n))
    check('thumbnails actually rendered by PDF.js', wait_count(page.locator('.frame-content canvas.ready'), 3))
    labels = page.locator('.thumb-label').all_inner_texts()
    check('merge order respected (b.pdf pages first)', labels[0].startswith('b.pdf') and labels[2].startswith('a.pdf'), str(labels[:4]))
    shot(page, '02-editor')

    # per-page rotate
    first_content = page.locator('.thumb').first.locator('.frame-content')
    check('page 1 starts unrotated', 'rotate(0deg)' in (first_content.get_attribute('style') or ''))
    act(page.locator('.thumb').first, 'Rotate page 1 clockwise')
    check('rotate button rotates preview 90°', 'rotate(90deg)' in (first_content.get_attribute('style') or ''))
    # delete page 2
    before = page.locator('.thumb').count()
    act(page.locator('.thumb').nth(1), 'Delete page 2')
    check('delete removes a page', page.locator('.thumb').count() == before - 1)
    # select multiple + rotate selected
    page.locator('.thumb').nth(1).get_by_role('checkbox').click()
    page.locator('.thumb').nth(2).get_by_role('checkbox').click()
    page.get_by_role('radio', name=re.compile('Selected')).click()
    page.get_by_role('button', name='180°').click()
    check('rotate selected pages 180°', all('rotate(180deg)' in (page.locator('.thumb').nth(i).locator('.frame-content').get_attribute('style') or '') for i in (1, 2)))
    check('unselected page not rotated', 'rotate(180deg)' not in (page.locator('.thumb').nth(3).locator('.frame-content').get_attribute('style') or ''))
    # rotate all
    page.get_by_role('radio', name='All pages').click()
    page.get_by_role('button', name='90° counter-clockwise').click()
    check('rotate ALL pages (page 1: 90 → 0)', 'rotate(0deg)' in (page.locator('.thumb').first.locator('.frame-content').get_attribute('style') or ''))
    # paper + orientation
    page.get_by_role('radio', name=re.compile('^A4')).click()
    page.get_by_role('radio', name='Landscape').click()
    style = page.locator('.thumb').first.locator('.frame').get_attribute('style') or ''
    check('landscape A4 preview aspect ratio applied', '841.89 / 595.276' in style, style)
    act(page.locator('.thumb').first, 'Preview page 1')
    expect(page.locator('.modal')).to_be_visible()
    check('single-page preview modal renders', wait_count(page.locator('.modal canvas.ready'), 1, 15000))
    shot(page, '03-modal'); page.keyboard.press('Escape') if False else page.locator('.modal-close').click()
    shot(page, '04-editor-a4-landscape')
    page.get_by_role('button', name='Reset changes').click()
    check('Reset restores all pages', page.locator('.thumb').count() == before)
    check('Reset restores rotation', 'rotate(0deg)' in (page.locator('.thumb').first.locator('.frame-content').get_attribute('style') or ''))
    # redo A4 landscape for export
    page.get_by_role('radio', name=re.compile('^A4')).click()
    page.get_by_role('radio', name='Landscape').click()
    act(page.locator('.thumb').nth(1), 'Delete page 2')
    act(page.locator('.thumb').first, 'Rotate page 1 clockwise')
    expected_pages = page.locator('.thumb').count()
    page.get_by_role('button', name='Continue').click()

    print('\n[UI 3] Finish → export small file (no compression needed)')
    page.wait_for_selector('#target-size')
    page.fill('#target-size', '0')
    page.locator('#filename').fill('my report')
    page.locator('#target-size').blur()
    check('invalid target (0) shows an error', page.locator('.field-error').is_visible())
    page.fill('#target-size', '2')
    page.get_by_role('radio', name='MB').click()
    shot(page, '05-finish')
    page.get_by_role('button', name='Create PDF').click()
    page.wait_for_selector('.result', timeout=120000)
    shot(page, '06-result')
    txt = page.locator('.result').inner_text()
    check('result: success callout', 'Your PDF is ready' in page.locator('.callout').inner_text())
    check('result: filename shown', 'my report.pdf' in txt)
    check('result: says compression was unnecessary', 'already within' in txt)
    with page.expect_download() as d:
        page.get_by_role('link', name='Download PDF').click()
    dl = d.value; path = dl.path()
    r = PdfReader(path)
    check(f'download is a real PDF with {expected_pages} pages', len(r.pages) == expected_pages, f'{len(r.pages)} vs {expected_pages}')
    check('download filename', dl.suggested_filename == 'my report.pdf', dl.suggested_filename)
    w, h = float(r.pages[1].mediabox.width), float(r.pages[1].mediabox.height)
    check('exported page 2 is A4 landscape (842x595)', abs(w - 841.89) < 1.5 and abs(h - 595.28) < 1.5, f'{w}x{h}')
    check('exported page 1 has the 90° user rotation applied', int(r.pages[0].get('/Rotate', 0) or 0) in (90,) or abs(float(r.pages[0].mediabox.width) - 841.89) < 1.5)
    shown = re.search(r'Final PDF size\s*([\d.]+) (KB|MB)', txt)
    mult = 1_000_000 if shown.group(2) == 'MB' else 1000
    check('displayed final size matches the downloaded file', abs(float(shown.group(1)) * mult - os.path.getsize(path)) / os.path.getsize(path) < 0.01, f'{shown.group(0)} vs {os.path.getsize(path)}')
    check('final PDF preview rendered', wait_count(page.locator('.preview-page canvas.ready'), 1, 20000))
    page.get_by_role('button', name='Start another task').click()
    expect(page.locator('h1')).to_be_visible()
    check('start another task returns to upload with empty list', page.locator('.file-row').count() == 0)

    print('\n[UI 4] Compression through the UI (28 MB → 1 MB target)')
    page.set_input_files('input[type=file]', F('heavy.pdf'))
    expect(page.locator('.chip-ready')).to_have_count(1, timeout=120000)
    page.get_by_role('button', name='Merge & edit pages').click()
    page.wait_for_selector('.thumb', timeout=60000)
    page.get_by_role('button', name='Continue').click()
    page.wait_for_selector('#target-size')
    page.fill('#target-size', '1'); page.get_by_role('radio', name='MB').click()
    page.get_by_role('radio', name=re.compile('Balanced')).click()
    page.get_by_role('button', name='Create PDF').click()
    page.wait_for_selector('.result', timeout=180000)
    txt = page.locator('.result').inner_text()
    shot(page, '07-compressed')
    with page.expect_download() as d:
        page.get_by_role('link', name='Download PDF').click()
    size = os.path.getsize(d.value.path())
    check(f'compressed download is ≤ 1 MB ({size:,} bytes)', size <= 1_000_000)
    check('UI reports target met', 'Target met' in txt and 'Original combined size' in txt)
    m = re.search(r'approximately ([\d.]+)%', txt)
    check('reduction % shown (>95% for 28 MB → <1 MB)', m is not None and float(m.group(1)) > 95, txt[:300])
    check('4 pages preserved', len(PdfReader(d.value.path()).pages) == 4)

    print('\n[UI 5] Impossible target')
    page.get_by_role('button', name=re.compile('Retry with a')).count()  # not present on success
    page.get_by_role('button', name='Start another task').click()
    page.set_input_files('input[type=file]', F('heavy.pdf'))
    expect(page.locator('.chip-ready')).to_have_count(1, timeout=120000)
    page.get_by_role('button', name='Merge & edit pages').click(); page.wait_for_selector('.thumb', timeout=60000)
    page.get_by_role('button', name='Continue').click(); page.wait_for_selector('#target-size')
    page.fill('#target-size', '50'); page.get_by_role('radio', name='KB').click()
    page.get_by_role('radio', name=re.compile('Smallest')).click()
    page.get_by_role('button', name='Create PDF').click()
    page.wait_for_selector('.result', timeout=180000)
    shot(page, '08-impossible')
    txt = page.locator('.result').inner_text()
    check('warning callout shown', page.locator('.callout.warn').is_visible())
    check('"Target size not reached" and does not claim success', 'Target size not reached' in txt and 'Target met' not in txt)
    check('offers higher target / stronger-mode retry actions', page.get_by_role('button', name=re.compile('Retry with a')).is_visible())
    page.get_by_role('button', name=re.compile('Retry with a')).click()
    page.wait_for_selector('#target-size')
    check('retry button prefills a higher target', float(page.input_value('#target-size')) > 50 or page.get_by_role('radio', name='MB').get_attribute('aria-checked') == 'true')

    print('\n[UI 6] Mobile layout')
    m = browser.new_context(viewport={'width': 390, 'height': 800}, is_mobile=True, has_touch=True)
    mp = m.new_page(); mp.goto(BASE)
    mp.set_input_files('input[type=file]', F('a.pdf', 'img2.png'))
    expect(mp.locator('.file-row')).to_have_count(2)
    mp.wait_for_timeout(4000)
    overflow = mp.evaluate("document.documentElement.scrollWidth > document.documentElement.clientWidth")
    check('no horizontal scroll on mobile (upload)', not overflow)
    mp.get_by_role('button', name='Merge & edit pages').click(); mp.wait_for_selector('.thumb', timeout=30000)
    mp.wait_for_timeout(1200)
    check('no horizontal scroll on mobile (editor)', not mp.evaluate("document.documentElement.scrollWidth > document.documentElement.clientWidth"))
    mp.screenshot(path=os.path.join(SHOTS, '09-mobile-editor.png'), full_page=True)

    print('\n[UI 7] Upload failures: specific messages, retries, slow connection')
    import io, tempfile, json as _json
    from PIL import Image
    from pypdf import PdfWriter, PdfReader as _PR
    tmpd = tempfile.mkdtemp()
    # a ~205 KB PDF and a ~4 MB JPEG, as in the phone report
    w = PdfWriter(); w.append(_PR(os.path.join(FIX, 'a.pdf'))); w.add_attachment('pad.bin', os.urandom(200_000))
    pdf205 = os.path.join(tmpd, 'report.pdf'); w.write(open(pdf205, 'wb'))
    rnd = os.urandom(2200 * 1600 * 3)
    jpg4 = os.path.join(tmpd, 'Photo from phone')  # extension-less on purpose
    Image.frombytes('RGB', (2200, 1600), rnd).save(jpg4, 'JPEG', quality=97)
    check('fixtures sizes (~205 KB pdf, ~4 MB jpeg)', 150_000 < os.path.getsize(pdf205) < 260_000 and os.path.getsize(jpg4) > 3_000_000, f'{os.path.getsize(pdf205)} {os.path.getsize(jpg4)}')

    def fresh():
        c = browser.new_context(viewport={'width': 1100, 'height': 800})
        pg = c.new_page(); pg.goto(BASE); pg.wait_for_selector('.stage')
        return c, pg
    def only_row_text(pg, timeout=40000):
        pg.wait_for_selector('.file-row.has-error', timeout=timeout)
        return pg.locator('.file-row.has-error .file-error').first.inner_text().replace('\n', ' ')

    # offline
    c, pg = fresh()
    c.set_offline(True)
    pg.set_input_files('input[type=file]', F('a.pdf'))
    t = only_row_text(pg, 20000)
    check('offline shows "You\'re offline."', "You're offline." in t, t)
    c.set_offline(False)
    pg.locator('.retry-btn').first.click()
    expect(pg.locator('.chip-ready')).to_have_count(1, timeout=60000)
    check('Retry after coming back online succeeds', True)
    c.close()

    # simulated 503 once -> automatic retry, "Retrying (1/3)…" shown, then success
    c, pg = fresh()
    st = {'n': 0}
    def once_503(route):
        if route.request.method == 'POST' and route.request.url.endswith('/files') and st['n'] == 0:
            st['n'] += 1
            route.fulfill(status=503, content_type='text/html', body='<h1>Service Unavailable</h1>')
        else:
            route.continue_()
    pg.route('**/api/sessions/*/files', once_503)
    pg.set_input_files('input[type=file]', F('a.pdf'))
    seen_retry = False
    for _ in range(60):
        if pg.get_by_text('Retrying (1/3)').count(): seen_retry = True; break
        pg.wait_for_timeout(50)
    check('503 shows "Retrying (1/3)…" on the file row (not Failed)', seen_retry)
    expect(pg.locator('.chip-ready')).to_have_count(1, timeout=60000)
    check('upload succeeds after the automatic retry; no Failed row left', pg.locator('.has-error').count() == 0 and st['n'] == 1)
    c.close()

    # always 503 -> 3 retries then a clear final message
    c, pg = fresh()
    cnt = {'n': 0}
    def always(status, body='{"error":"x"}', ctype='application/json'):
        def h(route):
            if route.request.method == 'POST' and route.request.url.endswith('/files'):
                cnt['n'] += 1
                route.fulfill(status=status, content_type=ctype, body=body)
            else:
                route.continue_()
        return h
    pg.route('**/api/sessions/*/files', always(503, '<h1>503</h1>', 'text/html'))
    pg.set_input_files('input[type=file]', F('a.pdf'))
    t = only_row_text(pg, 60000)
    check('persistent 503: message says server is busy or restarting', 'Server is busy or restarting' in t, t)
    check('persistent 503: 1 try + 3 retries = 4 requests', cnt['n'] == 4, str(cnt['n']))
    c.close()

    # 413 / 429 / 400 / network drop
    for status, body, expect_txt, retries in [
        (413, '{"error":"A file is larger than the 50 MB limit."}', 'File is too large (limit 50 MB).', 0),
        (429, '{"error":"Too many requests."}', 'Too many requests, wait a minute.', 3),
        (400, '{"error":"Invalid request."}', 'Invalid request.', 0),
    ]:
        c, pg = fresh(); cnt['n'] = 0
        pg.route('**/api/sessions/*/files', always(status, body))
        pg.set_input_files('input[type=file]', F('a.pdf'))
        t = only_row_text(pg, 60000)
        check(f'HTTP {status}: "{expect_txt}"', expect_txt in t, t)
        check(f'HTTP {status}: {retries} automatic retries', cnt['n'] == retries + 1, str(cnt['n']))
        c.close()
    c, pg = fresh(); cnt['n'] = 0
    def drop(route):
        if route.request.method == 'POST' and route.request.url.endswith('/files'):
            cnt['n'] += 1; route.abort('connectionreset')
        else: route.continue_()
    pg.route('**/api/sessions/*/files', drop)
    pg.set_input_files('input[type=file]', F('a.pdf'))
    t = only_row_text(pg, 60000)
    check('network drop: "Connection dropped during upload."', 'Connection dropped during upload.' in t, t)
    check('network drop: retried 3 times', cnt['n'] == 4, str(cnt['n']))
    c.close()

    # unreadable file: arrayBuffer() fails -> phone message, and nothing is sent
    c, pg = fresh(); cnt['n'] = 0
    pg.add_init_script("File.prototype.arrayBuffer = function () { return Promise.reject(new DOMException('NotReadableError')) }")
    pg.goto(BASE); pg.wait_for_selector('.stage')
    pg.route('**/api/sessions/*/files', always(200, '{}'))
    pg.set_input_files('input[type=file]', F('a.pdf'))
    t = only_row_text(pg, 20000)
    check('unreadable file: phone-specific message', "Your phone couldn't read this file" in t, t)
    check('unreadable file: no upload request was made', cnt['n'] == 0)
    c.close()

    # Slow 3G: both the 205 KB PDF and the 4 MB extension-less JPEG must arrive
    c = browser.new_context(viewport={'width': 1100, 'height': 800})
    pg = c.new_page(); pg.goto(BASE); pg.wait_for_selector('.stage')
    cdp = c.new_cdp_session(pg); cdp.send('Network.enable')
    cdp.send('Network.emulateNetworkConditions', {'offline': False, 'latency': 400, 'downloadThroughput': 400 * 1024 // 8, 'uploadThroughput': 400 * 1024 // 8})
    import time as _t; t0 = _t.time()
    pg.set_input_files('input[type=file]', [pdf205, jpg4])
    expect(pg.locator('.chip-ready')).to_have_count(2, timeout=240000)
    names3g = [x.strip() for x in pg.locator('.file-name').all_inner_texts()]
    check(f'Slow 3G: 205 KB PDF and 4 MB JPEG both uploaded ({_t.time() - t0:.0f}s)', pg.locator('.has-error').count() == 0)
    check('Slow 3G: extension-less photo got ".jpg"', 'Photo from phone.jpg' in names3g, str(names3g))
    c.close()

    check('no uncaught page errors', not [e for e in errors if 'favicon' not in e], str(errors[:3]))
    browser.close()

print(f'\n{passed} passed, {len(failed)} failed')
if failed: print('FAILED:\n - ' + '\n - '.join(failed)); sys.exit(1)
