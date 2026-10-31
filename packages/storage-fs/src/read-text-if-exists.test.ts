import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';
import { readTextIfExists } from './atomic.js';

describe('readTextIfExists', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await makeTempDir('alteroid-read-text-if-exists-');
  });

  it('ファイルがあれば中身を返す', async () => {
    const path = join(dir, 'a.txt');
    await writeFile(path, 'こんにちは', 'utf8');
    expect(await readTextIfExists(path)).toBe('こんにちは');
  });

  it('ファイルが無ければ undefined を返す', async () => {
    expect(await readTextIfExists(join(dir, 'none.txt'))).toBeUndefined();
  });

  it('ENOENT 以外のエラーは投げ直す', async () => {
    // ディレクトリを読むと EISDIR になる
    await expect(readTextIfExists(dir)).rejects.toMatchObject({ code: 'EISDIR' });
  });
});
