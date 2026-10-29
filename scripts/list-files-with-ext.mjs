import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

export function listFilesWithExt(dir, ext) {
  return readdirSync(dir)
    .map((name) => join(dir, name))
    .filter((path) => statSync(path).isFile() && path.endsWith(ext));
}
