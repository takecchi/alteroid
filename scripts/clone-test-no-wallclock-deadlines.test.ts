import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * **`clone.test.ts` 系（旧・単一ファイル）へ壁時計の打ち切りが足し戻されたら落ちる門**
 * （issue #1220）。
 *
 * ## なぜこの歯が要るのか
 *
 * #1220 は「待ちが**実時間のポーリングに賭けている**」という穴で、2026-09-12 に
 * `main` の CI を落とした（`3ca6397`。誰も気づかず、直した PR も無かった）。
 * 直し方は決まっていて、**諦める条件を時間で持たない**ことである
 * （`clone-test-harness.ts` の `waitFor` の doc に経緯が在る）。
 *
 * ⚠️ **既に在る偽タイマーの歯（「⭐ waitFor は壁時計で諦めない」）は、これを
 * 測っていない。** あちらが測るのは「いま在る待ちが時計を進めずに解けること」で、
 * **件数が増えることは測れない。** 65 箇所を 0 にしても、次の PR が1箇所
 * 足し戻せば静かに元へ戻る —— そのとき赤くなるものが無かった。ここがそれである。
 *
 * ## 測る範囲（issue #1744 で1本 → 25本へ分割された）
 *
 * 元は `packages/core/src/clone.test.ts` 1本だけを見ていた。#1744（負債2
 * 「テストは分かれていない」）で、その1本を**挙動を変えずに** 24本の
 * `clone-*.test.ts` と共有ハーネス `clone-test-harness.ts` へ分割したので、
 * ここも同じ範囲を保つために `TARGET_FILES` へ分割後の全ファイルを列挙する形に
 * 変えた。**列挙は `journal-store-with-contract-registry.test.ts` の
 * `KNOWN_IMPLEMENTATIONS` と同じ作法**（自動走査ではなく登録制） —— この分割群は
 * 命名規則（`clone-*.test.ts`）だけでは「元 `clone.test.ts` 由来か、他の Issue が
 * 独立に足した `Clone` 関連の器のテストか」を区別できない（実例: `clone-notices.test.ts`
 * 等は #1359 等が別クラスの単体試験として先に足したもので、非同期の待ち合わせを
 * 持たず対象外）。**他のテストへ広げていない**——#1220 が名指ししたのは
 * 「`createClone` を実際に走らせて `waitFor` 系で待ち合わせる統合寄りの試験」で
 * あり、その系譜が分割後にどこへ行ったかだけを追う（広げるなら、広げる側が
 * 「どのファイルのどの形が禁止か」を自分で決めること）。
 *
 * **この列挙は分割時点のスナップショットである。** 次にこの群からさらに
 * ファイルを分けたり、新しい `clone-*.test.ts` をこの系譜に足す PR は、
 * ここも一緒に更新すること（更新を忘れても、既存の分割ファイルは変わらず
 * 測り続ける——ここが赤くなるのは「新しく増えた分」を見落としたときだけ）。
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

/**
 * 元 `clone.test.ts`（issue #1744 の分割後）の系譜一式。共有ハーネス1本 +
 * 分割された24本。`packages/core/src/` からの相対パスで列挙する。
 *
 * **`clone-handle-order.test.ts` は分割由来ではなく、この列挙を自分の意思で
 * 広げた1本目である**（#1744 続き）。`createClone` を実際に走らせて
 * `clone-test-harness.ts` の `waitFor` で待ち合わせる、この系譜と同じ形の
 * 統合寄りの試験なので、ここへ足す（この節の doc の「広げるなら、広げる側が
 * 『どのファイルのどの形が禁止か』を自分で決めること」に対する回答）。
 *
 * **`clone-pump-redelivery-hitb-order.test.ts` も同じ理由で2本目として足す**
 * （#1744 続き。`#noteRedeliveryPredicateHitB` の位置の characterization）。
 * `createClone` を実際に走らせ、`clone-test-harness.ts` の `waitFor` で
 * 待ち合わせる同じ形である。
 */
const TARGET_RELATIVE_PATHS: readonly string[] = [
  'clone-test-harness.ts',
  'clone-handle-order.test.ts',
  'clone-pump-redelivery-hitb-order.test.ts',
  'clone-core-loop.test.ts',
  'clone-manager-confirmation-and-shutdown.test.ts',
  'clone-self-status-and-memory-cause.test.ts',
  'clone-autonomy.test.ts',
  'clone-memory-and-commitment-fixes.test.ts',
  'clone-turn-failure-trace.test.ts',
  'clone-quota-fold.test.ts',
  'clone-thinking-and-turn-accept.test.ts',
  'clone-consumption-ledger.test.ts',
  'clone-precompact-and-distill-tail.test.ts',
  'clone-grave-pickup-startup.test.ts',
  'clone-turn-usage.test.ts',
  'clone-inbox-flow-journal.test.ts',
  'clone-token-pool-notice.test.ts',
  'clone-quota-hold.test.ts',
  'clone-usage-window.test.ts',
  'clone-sdk-error-and-pending.test.ts',
  'clone-turn-queue.test.ts',
  'clone-manager-report-batching.test.ts',
  'clone-interrupt-and-ledger.test.ts',
  'clone-credentials.test.ts',
  'clone-usage-observation-and-recycle.test.ts',
  'clone-distill-timing.test.ts',
  'clone-summary-reindex-and-tail.test.ts',
];

const TARGET_FILES: readonly string[] = TARGET_RELATIVE_PATHS.map((relative) =>
  fileURLToPath(new URL(`../packages/core/src/${relative}`, import.meta.url)),
);

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
  /**
   * ファイルごとに読んでコメントを落とし、`{ relative, code }` の一覧として
   * 保つ（`journal-store-with-contract-registry.test.ts` の一覧と同じく、
   * 違反が見つかったときにどのファイルかを名指しできるようにするため——
   * 1本の巨大な文字列へ結合すると「どこにあるか」が消える）。
   */
  const files = TARGET_RELATIVE_PATHS.map((relative, i) => ({
    relative,
    code: stripComments(readFileSync(TARGET_FILES[i]!, 'utf8')),
  }));

  /**
   * **空虚に緑にならないことを先に測る。** コメントを落とす処理が壊れて中身を
   * 全部食べたら、下の3本は「違反0件」で緑になる。⟹ 落とした後にも本体が
   * 残っていることを、この歯が守っている当の待ちの名前（共有ハーネス側に在る）で
   * 確かめる。行数は分割後の全ファイル合計で見る（元は1本で1000行超だった）。
   */
  it('走査の対象が空虚でない（コメントを落としても本体が残っている）', () => {
    const combined = files.map((f) => f.code).join('\n');
    expect(combined).toContain('async function waitFor(');
    expect(combined).toContain('async function waitForExpect(');
    expect(combined.split('\n').length).toBeGreaterThan(1000);
  });

  for (const ban of BANS) {
    it(`${ban.what}を持たない`, () => {
      const hits = files.flatMap((f) =>
        [...f.code.matchAll(ban.pattern)].map((match) => `${f.relative}: ${match[0]}`),
      );
      expect(
        hits,
        `分割後の clone.test.ts 系（packages/core/src/clone-*.test.ts と ` +
          `clone-test-harness.ts）に${ban.what}が ${hits.length} 件ある。` +
          '⟹ 実時間のポーリングに賭ける形が戻っている（#1220 が 2026-09-12 に ' +
          '`main` の CI を落とした形そのもの）。' +
          `⛔ 「3000 を大きくする」で直さないこと —— 確率を下げるだけで同じ賭けが残る。${ban.instead}。`,
      ).toEqual([]);
    });
  }
});
