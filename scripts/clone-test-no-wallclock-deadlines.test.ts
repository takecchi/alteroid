import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * **`packages/core/src/clone.test.ts` へ壁時計の打ち切りが足し戻されたら落ちる門**
 * （issue #1220）。
 *
 * ## なぜこの歯が要るのか
 *
 * #1220 は「待ちが**実時間のポーリングに賭けている**」という穴で、2026-09-12 に
 * `main` の CI を落とした（`3ca6397`。誰も気づかず、直した PR も無かった）。
 * 直し方は決まっていて、**諦める条件を時間で持たない**ことである
 * （`clone.test.ts` の `waitFor` の doc に経緯が在る）。
 *
 * ⚠️ **既に在る偽タイマーの歯（「⭐ waitFor は壁時計で諦めない」）は、これを
 * 測っていない。** あちらが測るのは「いま在る待ちが時計を進めずに解けること」で、
 * **件数が増えることは測れない。** 65 箇所を 0 にしても、次の PR が1箇所
 * 足し戻せば静かに元へ戻る —— そのとき赤くなるものが無かった。ここがそれである。
 *
 * ## 測る範囲は `clone.test.ts` 1本だけである
 *
 * **他のテストへ広げていない。** 明示のタイムアウトが正しい歯は他に在りうるし、
 * #1220 が名指ししたのはこのファイルだからである（広げるなら、広げる側が
 * 「どのファイルのどの形が禁止か」を自分で決めること）。
 *
 * ## 何を禁止するか（3つ）
 *
 * 1. `expect.poll` そのもの —— **option を書かなくても既定の 1000ms で諦める。**
 *    ⟹ `timeout:` だけを禁止すると、`await expect.poll(G).toBe(true)` が
 *    素通りする（同じ賭けを、より短い予算で、より静かに続ける形）
 * 2. `timeout:` の option（`expect.poll(..., { timeout: 3000 })` の形）
 * 3. 経過時間の比較（`Date.now() - started > BUDGET` の形）
 * 4. `..._BUDGET_MS` の定数（かつての `RELEASE_WAIT_BUDGET_MS`）
 *
 * ⭕ **`it(name, fn, 15_000)` の明示のタイムアウトは禁止していない。** あれは
 * vitest の testTimeout であって「ポーリングの打ち切り」ではない。#1220 が
 * 名指しした賭けは前者ではなく後者である（`waitFor` の doc の「いま残っている
 * 締め切りは何か」）。
 *
 * ## コメントは見ない
 *
 * 禁止する形そのものが**経緯として doc に書いてある**ので、素朴に走査すると
 * この歯は自分が守っている文章で落ちる。⟹ ブロックコメントと行頭の `//` を
 * 落としてから測る。**`grep` は使わない**（`AGENTS.md`「静かに失敗する道具」）。
 */

const TARGET = fileURLToPath(new URL('../packages/core/src/clone.test.ts', import.meta.url));

/**
 * コメントを落とす。
 *
 * - ブロックコメント（`/* ... *\/`、JSDoc を含む）は全部落とす
 * - `//` は**行頭（空白を除いて先頭）のときだけ**落とす。行末に付いた `//` まで
 *   落とすと、同じ行に在るコードごと視野から消えて**取りこぼす側**へ倒れる
 */
function stripComments(source: string): string {
  const withoutBlocks = source.replace(/\/\*[\s\S]*?\*\//g, '');
  return withoutBlocks
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n');
}

interface Ban {
  readonly what: string;
  readonly pattern: RegExp;
  readonly instead: string;
}

const BANS: readonly Ban[] = [
  {
    what: 'ポーリングそのもの（`expect.poll`）',
    pattern: /\.poll\(/g,
    instead:
      '`waitForExpect(() => expect(...).toBe(...), "<ラベル>")` へ寄せること（' +
      '`timeout:` を書かなくても既定の 1000ms で諦めるので、option の有無では逃げられない）',
  },
  {
    what: 'ポーリングの打ち切り（`timeout:` の option）',
    pattern: /timeout:\s*\d/g,
    instead: '`waitForExpect(() => expect(...).toBe(...), "<ラベル>")` へ寄せること',
  },
  {
    what: '経過時間の比較（`Date.now() - <開始> > <予算>` の形）',
    pattern: /Date\.now\(\)\s*-\s*[A-Za-z_$][\w$]*\s*[<>]/g,
    instead: '`waitFor(() => <条件>, "<ラベル>")` へ寄せること',
  },
  {
    what: '待ちの予算の定数（`..._BUDGET_MS`）',
    pattern: /[A-Za-z_$][\w$]*_BUDGET_MS/g,
    instead: '予算そのものを持たないこと（諦める条件はテストの寿命であって時間ではない）',
  },
];

describe('clone.test.ts に壁時計の打ち切りを足し戻さない（#1220）', () => {
  const raw = readFileSync(TARGET, 'utf8');
  const code = stripComments(raw);

  /**
   * **空虚に緑にならないことを先に測る。** コメントを落とす処理が壊れて中身を
   * 全部食べたら、下の3本は「違反0件」で緑になる。⟹ 落とした後にも本体が
   * 残っていることを、この歯が守っている当の待ちの名前で確かめる。
   */
  it('走査の対象が空虚でない（コメントを落としても本体が残っている）', () => {
    expect(code).toContain('async function waitFor(');
    expect(code).toContain('async function waitForExpect(');
    expect(code.split('\n').length).toBeGreaterThan(1000);
  });

  for (const ban of BANS) {
    it(`${ban.what}を持たない`, () => {
      const hits = [...code.matchAll(ban.pattern)].map((match) => match[0]);
      expect(
        hits,
        `packages/core/src/clone.test.ts に${ban.what}が ${hits.length} 件ある。` +
          '⟹ 実時間のポーリングに賭ける形が戻っている（#1220 が 2026-09-12 に ' +
          '`main` の CI を落とした形そのもの）。' +
          `⛔ 「3000 を大きくする」で直さないこと —— 確率を下げるだけで同じ賭けが残る。${ban.instead}。`,
      ).toEqual([]);
    });
  }
});
