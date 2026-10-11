import { AlertCircle, CheckCircle2, Loader2 } from 'lucide-react'
import type { JobInfo } from '../api'

/** Shows the real server-side stages. There is no percentage because the server cannot know it in advance. */
export function ProgressPanel({ job, error, onBack }: { job: JobInfo | null; error: string | null; onBack: () => void }) {
  const log = job?.log ?? []
  const running = !error && (!job || job.status === 'running')
  return (
    <section className="progress" aria-live="polite">
      <h2>{error ? 'Something went wrong' : 'Creating your PDF'}</h2>
      {running && <div className="indeterminate" role="progressbar" aria-label="Processing" />}
      <ol className="stage-list">
        {log.length === 0 && !error && <li className="current"><Loader2 size={16} className="spin" /> Starting</li>}
        {log.map((s, i) => {
          const last = i === log.length - 1
          return (
            <li key={i} className={last && running ? 'current' : 'done'}>
              {last && running ? <Loader2 size={16} className="spin" /> : <CheckCircle2 size={16} />} {s}
            </li>
          )
        })}
        {error && <li className="failed"><AlertCircle size={16} /> {error}</li>}
      </ol>
      {error && <button className="btn" onClick={onBack}>Back to settings</button>}
    </section>
  )
}
