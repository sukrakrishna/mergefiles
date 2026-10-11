/** Decimal units everywhere (1 KB = 1000 bytes), matching the server. */
export function formatBytes(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 1 : 2)} MB`
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)} KB`
  return `${n} B`
}

export type Unit = 'KB' | 'MB'
export const toBytes = (value: number, unit: Unit) => Math.round(value * (unit === 'MB' ? 1_000_000 : 1000))

export const KIND_LABEL: Record<string, string> = { pdf: 'PDF', word: 'Word', excel: 'Excel', powerpoint: 'PowerPoint', image: 'Image' }
