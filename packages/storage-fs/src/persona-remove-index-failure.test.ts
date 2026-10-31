import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { captureStderr } from '@alteroid/core';
import { beforeEach, describe, expect, it } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';

import { createFsStores, initWorkspace } from './index.js';

// 実体を消したあとに索引の更新が失敗しても、`remove` は投げない（実体は消えているので、投げると呼び手が「消していない」と取り違える）
describe('fs の persona.remove: 実体を消したあとの索引の失敗', () => {
  let root: string;
  let stores: ReturnType<typeof createFsStores>;
  const indexPath = () => join(root, 'memory', '.index.json');
  const docPath = () => join(root, 'memory', 'values.md');

  async function exists(path: string): Promise<boolean> {
    return stat(path).then(
      () => true,
      () => false,
    );
  }

  beforeEach(async () => {
    root = await makeTempDir('alteroid-test-');
    stores = createFsStores(root);
    await initWorkspace(root);
    await stores.persona.write('values', '# 価値観\n\nV1\n');
  });

  it('索引の読み・書きが失敗する（索引のパスがディレクトリ）とき、実体は消え、remove は投げない', async () => {
    // 読めないので組み直しに入り、その書き込みが失敗する
    await rm(indexPath(), { force: true });
    await mkdir(indexPath());

    const lines = await captureStderr(async () => {
      await expect(stores.persona.remove('values')).resolves.toBeUndefined();
    });

    expect(await exists(docPath())).toBe(false);
    // 握り潰さず跡は残す
    expect(lines.join('')).toContain('記憶の削除後の索引の更新を記録できませんでした（slug=values）');
  });

  it('rm 自体が失敗したとき（実体がディレクトリ）は、今までどおり投げる', async () => {
    await rm(docPath());
    await mkdir(join(docPath(), 'child'), { recursive: true });

    await expect(stores.persona.remove('values')).rejects.toThrow();

    expect(await exists(docPath())).toBe(true);
  });

  it('索引が壊れているだけ（JSON として読めない）でも、remove は投げず、実体は消える', async () => {
    await writeFile(indexPath(), '{broken');

    await expect(stores.persona.remove('values')).resolves.toBeUndefined();

    expect(await exists(docPath())).toBe(false);
    expect(await readFile(indexPath(), 'utf8')).not.toBe('{broken');
  });
});
