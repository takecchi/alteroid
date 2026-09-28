import { describe, expect, it } from 'vitest';

// prettier-ignore
// @ts-expect-error -- 素の .mjs（型宣言を持たない build 用スクリプト）を読む
import { findEnvPassthroughHits, classifyChildProcessCallEnv, maskCommentsAndStrings } from './check-no-env-passthrough-core.mjs';

/**
 * 領域D 4周目点検・確かめ用（コミットしない）。
 * `check-no-env-passthrough-core.mjs` の3形検出（`findEnvPassthroughHits`）に、
 * doc に明記された既存の限界（変数経由・shorthand）とは別の、正規表現の
 * 構造そのものに由来する見落としが無いかを確かめる。
 *
 * **期待は「1件以上ヒットする」（丸ごと渡しを検出できる）。ヒット0件の行が、
 * 実際に見落とし＝疑いが確かめられた形である。**
 */
describe('round4-probe: findEnvPassthroughHits の見落とし（疑い）', () => {
  it('Object.assign の引数に、丸括弧を含む式が process.env より前に在る形', () => {
    const content = `
      import { execFileSync } from 'node:child_process';
      function run() {
        execFileSync('gh', ['pr', 'view'], { env: Object.assign(getBase(), process.env) });
      }
    `;
    const hits = findEnvPassthroughHits([{ path: 'fake.test.ts', content }]);
    expect(hits.length).toBeGreaterThan(0);
  });

  it('スプレッドが括弧で包んだ process.env を展開する形 ...(process.env)', () => {
    const content = `
      function run() {
        return { ...(process.env), FOO: '1' };
      }
    `;
    const hits = findEnvPassthroughHits([{ path: 'fake2.test.ts', content }]);
    expect(hits.length).toBeGreaterThan(0);
  });

  it('計算プロパティ名の文字列キー ["env"]: process.env', () => {
    const content = `
      function run() {
        return { ['env']: process.env };
      }
    `;
    const hits = findEnvPassthroughHits([{ path: 'fake3.test.ts', content }]);
    expect(hits.length).toBeGreaterThan(0);
  });

  it('（対照）通常の env: process.env は検出される', () => {
    const content = `
      function run() {
        return { env: process.env };
      }
    `;
    const hits = findEnvPassthroughHits([{ path: 'fake4.test.ts', content }]);
    expect(hits.length).toBeGreaterThan(0);
  });
});

/**
 * `classifyChildProcessCallEnv`（env オプション省略の検査）側の疑い。
 * ここは3つ目の状態 `undeterminable` が在るので、doc が言う「変数渡しは
 * undeterminable で握りつぶす」設計そのものは疑わない。疑うのは、
 * オブジェクトリテラルの中に process.env の丸渡しが**入れ子で**在る形
 * （`classifyOptionsObjectLiteral` が見るのはトップレベルのプロパティだけ）。
 */
describe('round4-probe: classifyChildProcessCallEnv の見落とし（疑い）', () => {
  it('options オブジェクトの env が、ネストした spread を経由する形は has-env と判定される想定を確認する', () => {
    // env: { ...process.env } のようにトップレベルに env キーが在れば
    // has-env になるはず（violation にはならない=正しい side）。これは
    // 対照であって疑いではない。
    const kind = 'spawn';
    const args = ['"gh"', '["pr","view"]', '{ env: { ...process.env } }'];
    expect(classifyChildProcessCallEnv(kind, args)).toBe('has-env');
  });
});
