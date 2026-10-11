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

/** True when the name ends in an alphabetic extension we do not support (".txt", ".zip", ".exe").
 *  Names without an extension, or whose "extension" is just digits ("Scan 12.03"), are decided by content instead. */
export function hasUnsupportedExtension(name: string): boolean {
  const ext = extensionOf(name);
  return ext !== '' && /[a-z]/.test(ext) && !(ext in RULES);
}

/** Content type -> extension, used only when the name carries no supported extension. */
const BY_CONTENT: Record<string, string> = {
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
};

const UNSUPPORTED = 'Supported: PDF, DOC/DOCX, XLS/XLSX, PPT/PPTX, JPG, PNG.';

export type Validation = { ok: true; kind: Kind; ext: string; name: string } | { ok: false; reason: string };

async function detectMime(diskPath: string): Promise<string | undefined> {
  try {
    return (await fileTypeFromFile(diskPath))?.mime;
  } catch {
    return undefined;
  }
}

/** Server-side validation. A declared extension must be supported AND match the file's real content.
 *  Without a usable extension the type is taken from the content (magic bytes) and appended to the display name.
 *  The client's Content-Type is never consulted. */
export async function validateUpload(displayName: string, diskPath: string, size: number): Promise<Validation> {
  const ext = extensionOf(displayName);
  const rule = RULES[ext];

  if (!rule) {
    if (hasUnsupportedExtension(displayName)) return { ok: false, reason: `Unsupported file type ".${ext}". ${UNSUPPORTED}` };
    if (size === 0) return { ok: false, reason: 'The file is empty.' };
    const mime = await detectMime(diskPath);
    if (mime === 'application/x-cfb') {
      return { ok: false, reason: 'This looks like an old Office file. Rename it to end in .doc, .xls or .ppt and upload it again.' };
    }
    const detected = mime ? BY_CONTENT[mime] : undefined;
    if (!detected) return { ok: false, reason: `This file type is not supported. ${UNSUPPORTED}` };
    return { ok: true, kind: RULES[detected].kind, ext: detected, name: `${displayName}.${detected}` };
  }

  if (size === 0) return { ok: false, reason: 'The file is empty.' };
  const detected = await detectMime(diskPath);
  if (!detected || !rule.mimes.includes(detected)) {
    return { ok: false, reason: `The file content does not match its ".${ext}" extension, so it was rejected.` };
  }
  return { ok: true, kind: rule.kind, ext, name: displayName };
}
