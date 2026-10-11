import type { Orient, Rotation } from './layout'

export interface PageItem {
  key: string
  src: number // index into the merged PDF (0-based)
  rotation: Rotation // user rotation, clockwise
  orientation: Orient
  selected: boolean
}

/** A file the user picked that is still on its way to the server (or failed on the way). */
export interface UploadItem {
  key: string
  seq: number // pick order; keeps the merge order stable although uploads finish in any order
  name: string
  size: number
  status: 'waiting' | 'uploading' | 'failed'
  loaded: number // bytes sent so far (0..size)
  error?: string
}
