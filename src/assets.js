// The app's own files: on disk when run from source, inside the executable when packaged.

import fs from 'node:fs';
import path from 'node:path';
import sea from 'node:sea';

export const isPackaged = sea.isSea();

const ROOT = path.join(import.meta.dirname, '..');
const packed = isPackaged ? new Set(sea.getAssetKeys()) : null;

// A file by its path from the project root, using forward slashes, or null if there's none.
export function readAsset(rel) {
  if (packed) return packed.has(rel) ? Buffer.from(sea.getAsset(rel)) : null;
  const file = path.join(ROOT, rel);
  return fs.existsSync(file) && fs.statSync(file).isFile() ? fs.readFileSync(file) : null;
}

// A file from public/, or null. Requests can't reach anything outside that folder.
export function readPublic(rel) {
  const clean = path.posix.normalize(rel.replaceAll('\\', '/'));
  if (clean.startsWith('..') || clean.startsWith('/') || path.win32.isAbsolute(clean)) return null;
  return readAsset(`public/${clean}`);
}
