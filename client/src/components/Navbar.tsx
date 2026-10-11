import { Check, Layers, Moon, ShieldCheck, Sun } from 'lucide-react'
import { PoweredBy } from './PoweredBy'

const STEPS = ['Upload', 'Edit pages', 'Compress']

export function Navbar({ retentionMinutes, current, theme, onTheme }: { retentionMinutes: number; current: number; theme: 'light' | 'dark'; onTheme: () => void }) {
  return (
    <header className="bar">
      <div className="brand-wrap">
        <a className="brand" href="/" aria-label="MergeAnyFile home">
          <span className="brand-mark"><Layers size={15} strokeWidth={2.4} /></span>
          <span>MergeAnyFile</span>
        </a>
        <span className="brand-divider" aria-hidden />
        <PoweredBy className="powered-bar" />
      </div>
      <ol className="track" aria-label="Progress">
        {STEPS.map((label, i) => (
          <li key={label} className={i < current ? 'done' : i === current ? 'active' : ''} aria-current={i === current ? 'step' : undefined}>
            <span className="step-dot">{i < current ? <Check size={11} strokeWidth={3} /> : i + 1}</span>
            <span className="step-label">{label}</span>
          </li>
        ))}
      </ol>
      <div className="bar-right">
        <span className="privacy-pill" title={`Files are deleted ${retentionMinutes} minutes after your last activity`}>
          <ShieldCheck size={14} /> <span>Auto-deleted after {retentionMinutes} min</span>
        </span>
        <button className="icon-btn" onClick={onTheme} aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}>
          {theme === 'dark' ? <Sun size={17} /> : <Moon size={17} />}
        </button>
      </div>
    </header>
  )
}
