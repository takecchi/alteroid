import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { opensTuiByDefault } from './launch.js';

// 出所の考え方: takecchi/codiva（MIT）`tests/entry-shim.test.ts`
const source = readFileSync(fileURLToPath(new URL('./launch.ts', import.meta.url)), 'utf8');
const code = source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line.length > 0);

describe('launch.ts のソース', () => {
  it('static import を持たない（巻き上げられて NODE_ENV の代入より先に評価されるため）', () => {
    expect(code.filter((line) => /^import\s+(?!\()/.test(line))).toEqual([]);
  });

  it('NODE_ENV の代入が動的 import より前にある。既存の値は上書きしない', () => {
    const assign = code.findIndex((line) => /process\.env\.NODE_ENV \?\?=/.test(line));
    const dynamic = code.findIndex((line) => line.includes("import('./main.js')"));
    expect(assign).toBeGreaterThanOrEqual(0);
    expect(dynamic).toBeGreaterThan(assign);
  });
});

describe('launchTui の NODE_ENV', () => {
  const saved = process.env.NODE_ENV;
  let seenAtEvaluation: string | undefined;
  const runTui = vi.fn(() => Promise.resolve());

  beforeEach(() => {
    vi.resetModules();
    runTui.mockClear();
    seenAtEvaluation = 'unset-by-test';
    vi.doMock('./main.js', () => {
      seenAtEvaluation = process.env.NODE_ENV;
      return { runTui };
    });
  });

  afterEach(() => {
    vi.doUnmock('./main.js');
    if (saved === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = saved;
  });

  it('未設定なら、評価の間だけ production にして、終わったら未設定へ戻す（子プロセスへ漏らさない）', async () => {
    delete process.env.NODE_ENV;
    const { launchTui } = await import('./launch.js');
    await launchTui();
    expect(seenAtEvaluation).toBe('production');
    expect(Object.prototype.hasOwnProperty.call(process.env, 'NODE_ENV')).toBe(false);
    expect(runTui).toHaveBeenCalledOnce();
  });

  it('本体を動かしている間も、CLI の NODE_ENV は変わっていない', async () => {
    delete process.env.NODE_ENV;
    let during: string | undefined = 'unset-by-test';
    runTui.mockImplementationOnce(() => {
      during = process.env.NODE_ENV;
      return Promise.resolve();
    });
    const { launchTui } = await import('./launch.js');
    await launchTui();
    expect(during).toBeUndefined();
  });

  it('既に入っている値は尊重し、そのまま残す', async () => {
    process.env.NODE_ENV = 'development';
    const { launchTui } = await import('./launch.js');
    await launchTui();
    expect(seenAtEvaluation).toBe('development');
    expect(process.env.NODE_ENV).toBe('development');
  });

  it('評価が失敗しても NODE_ENV は戻る', async () => {
    delete process.env.NODE_ENV;
    vi.doMock('./main.js', () => {
      throw new Error('評価に失敗');
    });
    const { launchTui } = await import('./launch.js');
    await expect(launchTui()).rejects.toThrow();
    expect(Object.prototype.hasOwnProperty.call(process.env, 'NODE_ENV')).toBe(false);
  });
});

describe('opensTuiByDefault（引数なしで起動したとき）', () => {
  const tty = { isTTY: true };

  it('引数なし かつ stdin/stdout がともに TTY のときだけ開く', () => {
    expect(opensTuiByDefault([], tty, tty)).toBe(true);
  });

  it('どちらかが TTY でなければ従来どおり（パイプ・リダイレクト・スクリプト）', () => {
    expect(opensTuiByDefault([], { isTTY: false }, tty)).toBe(false);
    expect(opensTuiByDefault([], tty, { isTTY: false })).toBe(false);
    expect(opensTuiByDefault([], {}, {})).toBe(false);
  });

  it('引数があれば（サブコマンドも --help も）開かない', () => {
    expect(opensTuiByDefault(['chat'], tty, tty)).toBe(false);
    expect(opensTuiByDefault(['--help'], tty, tty)).toBe(false);
    expect(opensTuiByDefault(['tui'], tty, tty)).toBe(false);
  });
});
