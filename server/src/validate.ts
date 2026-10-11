import { fileTypeFromFile } from 'file-type';

export type Kind = 'pdf' | 'word' | 'excel' | 'powerpoint' | 'image';

const OOXML = (m: string) => [m, 'application/zip'];

/** Declared extension -> allowed kind and the content types (detected from magic bytes) that are acceptable. */
const RULES: Record<string, { kind: Kind; mimes: string[] }> = {
  pdf: { kind: 'pdf', mimes: ['application/pdf'] },
  docx: { kind: 'word', mimes: OOXML('application/vnd.openxmlformats-officedocument.wordprocessingml.document') },
  doc: { kind: 'word', mimes: ['application/x-cfb'] },
  xlsx: { kind: 'excel', mimes: OOXML('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') },
  xls: { kind: 'excel', mimes: ['application/x-cfb'] },
  pptx: { kind: 'powerpoint', mimes: OOXML('application/vnd.openxmlformats-officedocument.presentationml.presentation') },
  ppt: { kind: 'powerpoint', mimes: ['application/x-cfb'] },
  jpg: { kind: 'image', mimes: ['image/jpeg'] },
  jpeg: { kind: 'image', mimes: ['image/jpeg'] },
  png: { kind: 'image', mimes: ['image/png'] },
};

export const SUPPORTED_EXTENSIONS = Object.keys(RULES);

export function extensionOf(name: string): string {
  const m = /\.([A-Za-z0-9]{1,6})$/.exec(name);
  return m ? m[1].toLowerCase() : '';
}

export type Validation = { ok: true; kind: Kind; ext: string } | { ok: false; reason: string };

/** Server-side validation: the declared extension must be supported AND the file's real content must match it. */
export async function validateUpload(displayName: string, diskPath: string, size: number): Promise<Validation> {
  const ext = extensionOf(displayName);
  const rule = RULES[ext];
  if (!rule) return { ok: false, reason: `Unsupported file type${ext ? ` ".${ext}"` : ''}. Supported: PDF, DOC/DOCX, XLS/XLSX, PPT/PPTX, JPG, PNG.` };
  if (size === 0) return { ok: false, reason: 'The file is empty.' };
  let detected: string | undefined;
  try {
    detected = (await fileTypeFromFile(diskPath))?.mime;
  } catch {
    detected = undefined;
  }
  if (!detected || !rule.mimes.includes(detected)) {
    return { ok: false, reason: `The file content does not match its ".${ext}" extension, so it was rejected.` };
  }
  return { ok: true, kind: rule.kind, ext };
}
