import { AlertTriangle, CheckCircle2, Download, RefreshCw } from 'lucide-react'
import { apiUrl, type ExportResult } from '../api'
import { formatBytes } from '../format'
import { PdfPreview } from './PdfPreview'

interface Props {
  result: ExportResult
  onNew: () => void
  onRetryHigher: (bytes: number) => void
  onRetrySmallest: () => void
}

export function ResultPanel({ result: r, onNew, onRetryHigher, onRetrySmallest }: Props) {
  const missed = r.targetMet === false
  const suggestedBytes = r.suggestedTargetBytes ?? Math.ceil(r.finalSize / 10_000) * 10_000
  const hasReduction = r.reductionPercent != null && r.reductionPercent > 0
  const scale = Math.max(r.originalSize, r.finalSize, r.target?.bytes ?? 0, 1)
  const pct = (n: number) => `${Math.max(1.5, Math.min(100, (n / scale) * 100))}%`
  const [num, unit] = formatBytes(r.finalSize).split(' ')
  return (
    <section className="result">
      <div className="result-preview">
        <div className="preview-head"><h2>Preview</h2><span className="muted mono">{r.pageCount} page{r.pageCount === 1 ? '' : 's'}</span></div>
        <PdfPreview url={apiUrl(r.previewUrl)} />
      </div>

      <aside className="receipt">
        <div className={`callout ${missed ? 'warn' : 'ok'}`} role="status">
          {missed ? <AlertTriangle size={20} /> : <CheckCircle2 size={20} />}
          <div>
            <strong>{missed ? 'Target size not reached' : 'Your PDF is ready'}</strong>
            <p>{r.message}</p>
            {missed && (
              <div className="callout-actions">
                <button className="btn btn-sm" onClick={() => onRetryHigher(suggestedBytes)}><RefreshCw size={13} /> Retry with a {formatBytes(suggestedBytes)} target</button>
                {r.target?.mode !== 'smallest' && <button className="btn btn-sm" onClick={onRetrySmallest}><RefreshCw size={13} /> Use a stronger mode</button>}
              </div>
            )}
          </div>
        </div>

        {r.compression.rasterized && (
          <p className="callout warn" role="note"><AlertTriangle size={18} /><span>Pages were converted to images to reach your target, so text in this PDF can’t be selected, copied or searched. Choose a larger target if you need selectable text.</span></p>
        )}

        <div className="result-size">
          <div className="big">{num}<small>{unit}</small></div>
          <p>{hasReduction ? <>Down from {formatBytes(r.originalSize)}, <b>about {r.reductionPercent!.toFixed(1)}% smaller</b></> : <>Original combined size was {formatBytes(r.originalSize)}</>}</p>
        </div>

        <div className="ladder" aria-label="Size comparison">
          <div className="ladder-row"><div className="lab"><span>Original combined</span><b>{formatBytes(r.originalSize)}</b></div><div className="ladder-track"><div className="ladder-fill" style={{ width: pct(r.originalSize) }} /></div></div>
          <div className={`ladder-row out ${missed ? 'miss' : ''}`}><div className="lab"><span>Final PDF</span><b>{formatBytes(r.finalSize)}</b></div><div className="ladder-track"><div className="ladder-fill" style={{ width: pct(r.finalSize) }} /></div></div>
          {r.target && <div className="ladder-row target"><div className="lab"><span>Target</span><b>{formatBytes(r.target.bytes)}</b></div><div className="ladder-track"><div className="ladder-fill" style={{ width: pct(r.target.bytes) }} /></div></div>}
        </div>

        <div className="receipt-actions">
          <a className="btn btn-primary btn-lg" href={apiUrl(r.downloadUrl)} download={r.filename}><Download size={18} /> Download PDF</a>
          <button className="btn btn-ghost" onClick={onNew}>Start another task</button>
        </div>

        <dl className="facts">
          <div><dt>File name</dt><dd>{r.filename}</dd></div>
          <div><dt>Final PDF size</dt><dd className="mono">{formatBytes(r.finalSize)}</dd></div>
          <div><dt>Original combined size</dt><dd className="mono">{formatBytes(r.originalSize)}</dd></div>
          <div><dt>Size reduction</dt><dd>{r.reductionPercent != null ? `approximately ${r.reductionPercent.toFixed(1)}%` : 'None (output is not smaller than the originals)'}</dd></div>
          <div><dt>Total pages</dt><dd className="mono">{r.pageCount}</dd></div>
          <div><dt>Paper size</dt><dd>{r.paperLabel}</dd></div>
          <div><dt>Orientation</dt><dd>{r.orientationLabel}</dd></div>
          {r.target && <div><dt>Requested target</dt><dd>{formatBytes(r.target.bytes)}, {missed ? 'not reached' : 'met'}</dd></div>}
        </dl>

        {missed && r.suggestions.length > 0 && (
          <ul className="suggestions">{r.suggestions.map((s) => <li key={s}>{s}</li>)}</ul>
        )}

        {r.compression.attempts.length > 1 && (
          <details className="details">
            <summary>What was tried</summary>
            <ul>
              {r.compression.attempts.map((a, i) => <li key={i}>{a.label}{a.size ? `: ${formatBytes(a.size)}` : ''}</li>)}
            </ul>
            {r.compression.settings && <p className="muted">Final file used: {r.compression.settings}.</p>}
          </details>
        )}
        <p className="hint">Your files are deleted automatically after a period of inactivity, or immediately when you start another task.</p>
      </aside>
    </section>
  )
}
