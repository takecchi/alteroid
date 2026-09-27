import { spawnSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

import { mutateCliChildEnv } from './mutate-cli-child-env.js';

/**
 * 歯: 親の環境に偽の機微変数が在っても子には届かない（#1854）。
 *
 * `scripts/mutate-*.test.ts` の5ファイルが、`mutate.mjs` を子として起こす
 * ときにこの関数を経由するようになった（`grep -Fn -- 'mutateCliChildEnv('
 * scripts/mutate-*.test.ts` で当たる）。ここでは共有ヘルパーそのものだけを
 * 測る——各呼び出し側で同じ歯を繰り返さない。
 *
 * 併せて、絞った環境（`PATH` だけ）でも `node` 自身を子として起こせることを
 * 確かめる——`PATH` を落としすぎて `mutate.mjs` が一切起動できなくなる方向の
 * 回帰も、この1本で拾う。
 */
describe('mutateCliChildEnv', () => {
  it('偽の機微変数は子に渡らない。PATH だけは効いて node を起動できる', () => {
    const before = process.env.FAKE_SECRET_FOR_TEST;
    process.env.FAKE_SECRET_FOR_TEST = 'not-a-real-value';
    try {
      const result = spawnSync(
        'node',
        ['-e', 'process.stdout.write(JSON.stringify(process.env.FAKE_SECRET_FOR_TEST ?? null))'],
        { encoding: 'utf8', env: mutateCliChildEnv() },
      );
      expect(result.status).toBe(0);
      expect(result.stdout).toBe('null');
    } finally {
      if (before === undefined) delete process.env.FAKE_SECRET_FOR_TEST;
      else process.env.FAKE_SECRET_FOR_TEST = before;
    }
  });
});
