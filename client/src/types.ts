import type { Orient, Rotation } from './layout'

export interface PageItem {
  key: string
  src: number // index into the merged PDF (0-based)
  rotation: Rotation // user rotation, clockwise
  orientation: Orient
  selected: boolean
}
