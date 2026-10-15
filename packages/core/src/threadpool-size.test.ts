import { readFileSync } from 'node:fs';

import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

// 入口の最初の import が副作用で `UV_THREADPOOL_SIZE` を置く（#4890）。libuv の枠の大きさが実際に変わることは、ビルドした入口を
// 本物の node で動かして数えた（PR の報告）。ここでは、値の置き方（無ければ 16・人間の値は触らない）と、入口の最初の import であることを固定する。
describe('threadpool-size（#4890）', () => {
  it('未設定・空のときは 16 を置く', async () => {
    vi.stubEnv('UV_THREADPOOL_SIZE', undefined);
    vi.resetModules();
    await import('./threadpool-size.js');
    expect(process.env.UV_THREADPOOL_SIZE).toBe('16');

    vi.stubEnv('UV_THREADPOOL_SIZE', '');
    vi.resetModules();
    await import('./threadpool-size.js');
    expect(process.env.UV_THREADPOOL_SIZE).toBe('16');
  });

  it('人間が置いた値は上書きしない', async () => {
    vi.stubEnv('UV_THREADPOOL_SIZE', '8');
    vi.resetModules();
    await import('./threadpool-size.js');
    expect(process.env.UV_THREADPOOL_SIZE).toBe('8');
  });

  it('何も import しない（先に評価させるため、他のモジュールを連れてこない）', () => {
    const source = readFileSync(new URL('./threadpool-size.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/^\s*import\s/m);
  });

  it.each(['../../../apps/daemon/src/index.ts', '../../../apps/runner/src/index.ts'])(
    '%s の最初の import である',
    (path) => {
      const source = readFileSync(new URL(path, import.meta.url), 'utf8');
      const firstImport = /^import .*$/m.exec(source)?.[0];
      expect(firstImport).toBe("import '@alteroid/core/threadpool-size';");
    },
  );
});
