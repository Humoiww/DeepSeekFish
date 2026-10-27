import fs from 'node:fs';
import path from 'node:path';
import { FishError } from './types.js';

/** Reject links/reparse-point junctions in EVERY existing ancestor, including the root. */
export function noLinks(absolute: string): void {
  const resolved = path.resolve(absolute);
  const parts = resolved.slice(path.parse(resolved).root.length).split(path.sep).filter(Boolean);
  let current = path.parse(resolved).root;
  for (const part of parts) {
    current = path.join(current, part);
    if (!fs.existsSync(current) && !fs.lstatSync(current, { throwIfNoEntry: false })) break;
    const st = fs.lstatSync(current);
    if (st.isSymbolicLink()) throw new FishError('PATH_LINK_REJECTED');
    if (path.resolve(fs.realpathSync.native(current)).toLowerCase() !== current.toLowerCase()) {
      throw new FishError('PATH_CANONICAL_MISMATCH');
    }
  }
}
export function safePath(root: string, relative: string): string {
  if (!relative || relative.includes('\0') || relative.includes('\\') || relative.includes(':') ||
      path.isAbsolute(relative) || path.win32.isAbsolute(relative) || relative.split('/').some(x => x === '..' || x === '.' || /[. ]$/.test(x) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(x))) {
    throw new FishError('PATH_TRAVERSAL');
  }
  noLinks(root);
  const result = path.resolve(root, relative);
  const rel = path.relative(fs.realpathSync(root), result);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new FishError('PATH_OUTSIDE_ROOT');
  noLinks(result);
  return result;
}
export function makeDir(root: string, relative: string): string {
  const p = safePath(root, relative);
  fs.mkdirSync(p, { recursive: true });
  noLinks(p);
  return p;
}
export function writePrivate(root: string, relative: string, contents: string): void {
  const p = safePath(root, relative);
  if (fs.existsSync(p) && fs.lstatSync(p).nlink !== 1) throw new FishError('PATH_HARDLINK');
  fs.writeFileSync(p, contents, { mode: 0o600 });
}
