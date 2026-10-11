import { AlertCircle, CheckCircle2, X } from 'lucide-react'

export interface Toast { id: number; kind: 'error' | 'success' | 'info'; text: string }

export function Toasts({ toasts, dismiss }: { toasts: Toast[]; dismiss: (id: number) => void }) {
  return (
    <div className="toasts" role="region" aria-label="Notifications">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast-${t.kind}`} role={t.kind === 'error' ? 'alert' : 'status'}>
          {t.kind === 'error' ? <AlertCircle size={18} /> : <CheckCircle2 size={18} />}
          <span>{t.text}</span>
          <button className="icon-btn" onClick={() => dismiss(t.id)} aria-label="Dismiss"><X size={16} /></button>
        </div>
      ))}
    </div>
  )
}
