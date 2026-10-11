// Mirrors server/src/layout.ts so thumbnails preview exactly what the server will produce.
export type Paper = 'original' | 'a4' | 'a3'
export type Orient = 'auto' | 'portrait' | 'landscape'
export type Rotation = 0 | 90 | 180 | 270

const PAPER_PORTRAIT: Record<'a4' | 'a3', [number, number]> = { a4: [595.276, 841.89], a3: [841.89, 1190.551] }

export function targetSize(vw: number, vh: number, paper: Paper, orientation: Orient): [number, number] {
  let [tw, th] = paper === 'original' ? [vw, vh] : PAPER_PORTRAIT[paper]
  if (orientation === 'portrait' && tw > th) [tw, th] = [th, tw]
  else if (orientation === 'landscape' && th > tw) [tw, th] = [th, tw]
  else if (orientation === 'auto' && paper !== 'original' && vw > vh && th > tw) [tw, th] = [th, tw]
  return [tw, th]
}
