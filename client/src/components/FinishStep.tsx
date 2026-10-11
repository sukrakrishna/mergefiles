import { useState } from 'react'
import { Gauge, Loader2, Minimize2, Sparkles } from 'lucide-react'
import { formatBytes, toBytes, type Unit } from '../format'

export type Mode = 'high' | 'balanced' | 'smallest'
export interface CompressSettings { enabled: boolean; value: string; unit: Unit; mode: Mode; filename: string }

const MODES: Array<[Mode, string, string, typeof Gauge]> = [
  ['high', 'High Quality', 'Best readability. Images stay sharp; may not reach very small targets.', Sparkles],
  ['balanced', 'Balanced', 'Good quality with a noticeably smaller file.', Gauge],
  ['smallest', 'Smallest Size', 'Strongest compression, used only as far as needed. If images alone can’t reach your target, pages may be converted to images (text then can’t be selected).', Minimize2],
]
const CHIPS: Array<[string, Unit]> = [['500', 'KB'], ['1', 'MB'], ['2', 'MB'], ['5', 'MB']]

export function validateTarget(s: CompressSettings): string | null {
  if (!s.enabled) return null
  const v = Number(s.value)
  if (!s.value.trim() || !Number.isFinite(v) || v <= 0) return 'Enter a size greater than zero.'
  const b = toBytes(v, s.unit)
  if (b < 5000) return 'The smallest supported target is 5 KB.'
  if (b > 1_000_000_000) return 'The largest supported target is 1000 MB.'
  return null
}

interface Props {
  settings: CompressSettings
  onChange: (s: CompressSettings) => void
  pageCount: number
  paperLabel: string
  originalSize: number
  mergedSize: number
  busy: boolean
  onBack: () => void
  onCreate: () => void
}

export function FinishStep({ settings, onChange, pageCount, paperLabel, originalSize, mergedSize, busy, onBack, onCreate }: Props) {
  const [touched, setTouched] = useState(false)
  const error = touched ? validateTarget(settings) : null
  const set = (p: Partial<CompressSettings>) => onChange({ ...settings, ...p })

  const targetBytes = settings.enabled && !validateTarget(settings) ? toBytes(Number(settings.value), settings.unit) : null
  const scale = Math.max(originalSize, mergedSize, targetBytes ?? 0, 1)
  const pct = (n: number) => `${Math.max(1.5, Math.min(100, (n / scale) * 100))}%`

  return (
    <section className="finish">
      <div>
        <div className="head-block">
          <h1>Compress and name your PDF</h1>
          <p>Set the size you need and we will get as close as quality allows. The result page always shows the real file size.</p>
        </div>

        <div className="section">
          <header>
            <h2 id="compress-title">Compress Output</h2>
            <button type="button" className="switch" role="switch" aria-checked={settings.enabled} aria-labelledby="compress-title" onClick={() => set({ enabled: !settings.enabled })} />
          </header>
          <fieldset disabled={!settings.enabled} className={`compress-fields ${settings.enabled ? '' : 'off'}`}>
            <label className="field-label" htmlFor="target-size">Required output size</label>
            <div className="size-input">
              <input
                id="target-size" inputMode="decimal" value={settings.value} aria-invalid={!!error} aria-describedby="target-help"
                onChange={(e) => set({ value: e.target.value })} onBlur={() => setTouched(true)}
              />
              <div className="seg" role="radiogroup" aria-label="Unit">
                {(['KB', 'MB'] as Unit[]).map((u) => (
                  <button key={u} type="button" role="radio" aria-checked={settings.unit === u} className={settings.unit === u ? 'on' : ''} onClick={() => set({ unit: u })}>{u}</button>
                ))}
              </div>
            </div>
            <div className="chips">
              {CHIPS.map(([v, u]) => (
                <button key={v + u} type="button" className={`chip-btn ${settings.value === v && settings.unit === u ? 'on' : ''}`} onClick={() => set({ value: v, unit: u })}>{v} {u}</button>
              ))}
            </div>
            {error && <p className="field-error" role="alert">{error}</p>}
            <p id="target-help" className="hint">A target, not a guarantee. 1 KB = 1,000 bytes and 1 MB = 1,000,000 bytes. If it cannot be reached we show the real size and what to try.</p>
          </fieldset>
        </div>

        <div className="section">
          <header><h2>Compression mode</h2></header>
          <fieldset disabled={!settings.enabled} className={`compress-fields ${settings.enabled ? '' : 'off'}`}>
            <div className="mode-list" role="radiogroup" aria-label="Compression mode">
              {MODES.map(([m, title, desc, Icon]) => (
                <button key={m} type="button" role="radio" aria-checked={settings.mode === m} className={`mode ${settings.mode === m ? 'on' : ''}`} onClick={() => set({ mode: m })}>
                  <Icon size={18} /><span><strong>{title}</strong><small>{desc}</small></span>
                </button>
              ))}
            </div>
          </fieldset>
        </div>
      </div>

      <aside className="summary">
        <div className="summary-body">
          <h3>Your PDF</h3>
          <label className="field-label" htmlFor="filename">File name</label>
          <div className="name-input">
            <input id="filename" value={settings.filename} maxLength={80} onChange={(e) => set({ filename: e.target.value })} />
            <span>.pdf</span>
          </div>
          <dl className="facts">
            <div><dt>Pages</dt><dd className="mono">{pageCount}</dd></div>
            <div><dt>Paper size</dt><dd>{paperLabel}</dd></div>
          </dl>
          <div className="ladder" aria-label="Size comparison">
            <div className="ladder-row"><div className="lab"><span>Uploaded files</span><b>{formatBytes(originalSize)}</b></div><div className="ladder-track"><div className="ladder-fill" style={{ width: pct(originalSize) }} /></div></div>
            <div className="ladder-row"><div className="lab"><span>Merged so far</span><b>{formatBytes(mergedSize)}</b></div><div className="ladder-track"><div className="ladder-fill" style={{ width: pct(mergedSize) }} /></div></div>
            {targetBytes != null && <div className="ladder-row target"><div className="lab"><span>Your target</span><b>{formatBytes(targetBytes)}</b></div><div className="ladder-track"><div className="ladder-fill" style={{ width: pct(targetBytes) }} /></div></div>}
          </div>
        </div>
        <div className="summary-foot">
          <button className="btn" onClick={onBack} disabled={busy}>Back</button>
          <button className="btn btn-primary" disabled={busy} onClick={() => { setTouched(true); if (!validateTarget(settings)) onCreate() }}>
            {busy ? <><Loader2 size={16} className="spin" /> Starting…</> : 'Create PDF'}
          </button>
        </div>
      </aside>
    </section>
  )
}
