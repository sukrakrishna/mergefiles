import { ZEPTY } from '../brand'

export function PoweredBy({ className = '' }: { className?: string }) {
  return (
    <span className={`powered ${className}`.trim()}>
      Powered by <a href={ZEPTY.url} target="_blank" rel="noopener noreferrer">{ZEPTY.name}</a>
    </span>
  )
}
