import { readFileSync } from 'node:fs';

import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

// 枠が実際に16本になることと、子へ受け継がれないことは、ビルドした入口を本物の node で動かして数えた（PR の報告）。
// ここでは、環境変数の扱い（自分が置いた値は消す・人間の値は触らない）と、入口の最初の import であることを固定する。
describe('threadpool-size（#4890）', () => {
  it('未設定・空のときは枠を決めた後に環境変数を消す（子へ受け継がせない）', async () => {
    vi.stubEnv('UV_THREADPOOL_SIZE', undefined);
    vi.resetModules();
    await import('./threadpool-size.js');
    expect(process.env.UV_THREADPOOL_SIZE).toBeUndefined();

    vi.stubEnv('UV_THREADPOOL_SIZE', '');
    vi.resetModules();
    await import('./threadpool-size.js');
    expect(process.env.UV_THREADPOOL_SIZE).toBeUndefined();
  });

  it('人間が置いた値は消さず、変えない', async () => {
    vi.stubEnv('UV_THREADPOOL_SIZE', '8');
    vi.resetModules();
    await import('./threadpool-size.js');
    expect(process.env.UV_THREADPOOL_SIZE).toBe('8');
  });

  it('自前のモジュールを import しない（先に評価させるため、他のモジュールを連れてこない）', () => {
    const source = readFileSync(new URL('./threadpool-size.ts', import.meta.url), 'utf8');
    const imports = [...source.matchAll(/^import .* from '(.*)';$/gm)].map((m) => m[1]);
    expect(imports).toEqual(['node:fs']);
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
