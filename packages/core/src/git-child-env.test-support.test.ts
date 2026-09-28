import { describe, expect, it } from 'vitest';

import { gitChildEnv } from './git-child-env.test-support.js';

/**
 * `gitChildEnv()`（#1854）の単体の歯。
 *
 * **測るのは「親の `process.env` を丸ごと継承しない」ことそのもの。**
 * `execFileSync('git', …)` を実際に起こして確かめる歯は `write-canon.test.ts`
 * の側が持つ（本物の git を通す）ので、ここでは軽い口——組み立てた env
 * オブジェクトを直接検査する。
 */
describe('gitChildEnv', () => {
  it('親の process.env に置いた偽の値を継承しない', () => {
    process.env.ALTEROID_TEST_FAKE_1854_GIT = 'not-a-real-value';
    try {
      const env = gitChildEnv();
      expect(env.ALTEROID_TEST_FAKE_1854_GIT).toBeUndefined();
    } finally {
      delete process.env.ALTEROID_TEST_FAKE_1854_GIT;
    }
  });

  it('PATH と HOME だけを持つ（それ以外の鍵は一切無い）', () => {
    const env = gitChildEnv();
    expect(Object.keys(env).sort()).toEqual(['HOME', 'PATH']);
  });

  it('HOME は本物の process.env.HOME ではない（偽の一時ディレクトリ）', () => {
    const env = gitChildEnv();
    expect(env.HOME).not.toBe(process.env.HOME);
    expect(env.HOME).toBeTruthy();
  });

  it('PATH は本物の process.env.PATH をそのまま渡す（git 自身を解決するため）', () => {
    const env = gitChildEnv();
    expect(env.PATH).toBe(process.env.PATH ?? '');
  });

  it('呼び出しのたびに新しい一時ディレクトリを作り直さない（同じ HOME を返す）', () => {
    const a = gitChildEnv();
    const b = gitChildEnv();
    expect(a.HOME).toBe(b.HOME);
  });
});
