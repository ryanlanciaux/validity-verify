import { lstatSync, realpathSync, readFileSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

/** A regular file beneath a trusted root, with no symlink in its relative path. */
export function containedFile(root: string, path: string): string | null {
  try {
    const rel = relative(resolve(root), resolve(path));
    if (!rel || isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) return null;
    let current = realpathSync(root);
    const parts = rel.split(sep);
    for (let i = 0; i < parts.length; i++) {
      current = resolve(current, parts[i]!);
      const stat = lstatSync(current);
      if (stat.isSymbolicLink() || (i === parts.length - 1 ? !stat.isFile() : !stat.isDirectory()))
        return null;
    }
    return current;
  } catch {
    return null;
  }
}

/** ponytail: PNG type sniff, not full decoding; use an image decoder if pixel validity is required. */
export function readContainedPng(root: string, path: string): Buffer | null {
  const file = containedFile(root, path);
  if (!file) return null;
  try {
    const bytes = readFileSync(file);
    if (
      bytes.length < 57 ||
      !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
      bytes.readUInt32BE(8) !== 13 ||
      bytes.toString('ascii', 12, 16) !== 'IHDR' ||
      bytes.readUInt32BE(16) === 0 ||
      bytes.readUInt32BE(20) === 0 ||
      !bytes.subarray(-12).equals(Buffer.from([0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130]))
    )
      return null;
    return bytes;
  } catch {
    return null;
  }
}
