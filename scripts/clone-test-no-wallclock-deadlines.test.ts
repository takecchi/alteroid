import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
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
 * ⭐ **3. の「経過時間の比較」だけは、列挙の外にも効く走査がファイル末尾に在る**
 * （issue #2507。`packages/` と `apps/` の全 `*.test.ts(x)` を見る。例外は名指し）。
 * 以下の「列挙」の話は、残りの禁止（`expect.poll` / `timeout:` / `_BUDGET_MS`）の範囲である。
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

/**
 * **列挙の外へも効かせる走査（issue #2507）。**
 *
 * 上の3本は `TARGET_RELATIVE_PATHS` に列挙したファイルしか見ない。#1275 のあと、
 * 列挙の外（`commitment.test.ts` / `approval-answer-delivery.test.ts` /
 * `inbox-persistence.test.ts` など15ファイル）に同じ形の
 * 「`Date.now() - started > 3000` を過ぎたら throw する」正の待ちが残っていて、
 * 列挙は新しいファイルが増えるたびに外れる。⟹ `packages/` と `apps/` の
 * `*.test.ts` / `*.test.tsx` を**全部**走査して、同じ形を見る。
 *
 * ## 例外（名指し・理由付き）
 *
 * 「起きないこと」を一定時間見る**負の待ち**は、予算を外すと意味が変わる
 * （外すと永久に待つか、待ちそのものが無くなる）。残すものは**ここに名指しで**
 * 1件ずつ書く。件数も固定する（同じファイルに2件目が足されたら落ちる）。
 */
const SCAN_ROOTS: readonly string[] = ['packages', 'apps'];
const SCAN_EXCLUDE_DIRS: ReadonlySet<string> = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.react-router',
  '.vite',
]);
/**
 * 壁時計の打ち切りの形（`Date.now()` と `performance.now()`）。1本の正規表現の選択肢にして、
 * 同じ場所を2回数えない。
 *
 * - `Date.now() - <開始> >|<`（#2507 の形）
 * - `<締切> - Date.now()`（`const remaining = deadline - Date.now()`。#2537）
 * - `Date.now() <|> <締切>`、`<締切> <|> Date.now()`（`=>` と `->` は除く。#2537）
 *
 * **見ない形（限界）**: `.getTime()` / `new Date()` の比較、`const end = Date.now() + n` を作って
 * `AbortSignal.timeout` 等の別の道具へ渡す形、`expect(Date.now() - t).toBeLessThan(n)`
 * （経過の上限を測る表明で、待ちではない）。
 */
const DEADLINE_PATTERN =
  /(?:Date|performance)\.now\(\)\s*-\s*[A-Za-z_$][\w$]*\s*[<>]|[A-Za-z_$][\w$]*\s*-\s*(?:Date|performance)\.now\(\)|(?:Date|performance)\.now\(\)\s*[<>]|(?<![=-])[<>]=?\s*(?:Date|performance)\.now\(\)/g;

const NEGATIVE_WAIT_EXCEPTIONS: Readonly<Record<string, { count: number; reason: string }>> = {
  'packages/core/src/manager.test.ts': {
    count: 1,
    reason:
      '`settleAfterJournal`（負の待ち）。「日誌に一行が出ない」ことを 500ms 見てから黙って抜ける ' +
      '仕様そのものが、保証1と保証2の分離を保つ本体（その doc に在る）。予算を外すと、' +
      '変異のもとで待ちが永久に解けなくなる',
  },
  'apps/runner/src/events-stale-subscriber-handoff.test.ts': {
    count: 1,
    reason:
      '3本目の接続を 500ms 固定で読み切ってから数える（負の待ち。#2537）。「再配達が起きない' +
      '（同じ出来事が2回現れない）」を見るので、早期終了すると「まだ来ていない」と「来ない」が' +
      '区別できず、窓を外すと読み切る条件が無くなる',
  },
  'apps/daemon/src/auth.test.ts': {
    count: 1,
    reason:
      '`readForWindow`（負の待ち。#2537）。「ログアウトしていない／operator の資格の流れが、' +
      '心拍が来ても閉じないまま」を 200ms 見る対照2本。窓を外すと閉じない流れを永久に読む。' +
      '「閉じる」ことを待つ正の待ち（`readUntilEnd` / `readUntilText`）は窓を持たない',
  },
};

function walkTestFiles(absoluteDir: string, relativeDir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(absoluteDir, { withFileTypes: true })) {
    if (SCAN_EXCLUDE_DIRS.has(entry.name)) continue;
    const relative = `${relativeDir}/${entry.name}`;
    if (entry.isDirectory()) {
      found.push(...walkTestFiles(path.join(absoluteDir, entry.name), relative));
    } else if (entry.isFile() && /\.test\.tsx?$/.test(entry.name)) {
      found.push(relative);
    }
  }
  return found;
}

describe('どのテストにも壁時計の打ち切りを足さない（#2507・#2537、列挙でなく走査）', () => {
  const repoRoot = fileURLToPath(new URL('..', import.meta.url));
  const scanned = SCAN_ROOTS.flatMap((root) => walkTestFiles(path.join(repoRoot, root), root)).map(
    (relative) => ({
      relative,
      code: stripComments(readFileSync(path.join(repoRoot, relative), 'utf8')),
    }),
  );

  it('走査の対象が空虚でない（packages と apps の両方に、テストが在る）', () => {
    expect(scanned.length).toBeGreaterThan(100);
    expect(scanned.some((f) => f.relative.startsWith('packages/core/src/'))).toBe(true);
    expect(scanned.some((f) => f.relative.startsWith('apps/'))).toBe(true);
    // 形の検出器が生きている（何も拾えないと、下は空虚に緑になる）。
    expect('if (Date.now() - started > 3000) throw new Error(x);'.match(DEADLINE_PATTERN)).toEqual([
      'Date.now() - started >',
    ]);
    expect('if (Date.now() - start >= timeoutMs) return;'.match(DEADLINE_PATTERN)).toHaveLength(1);
  });

  it('deadline を先に作って比べる形も検出する（#2537）。経過の表明と `=>` は拾わない', () => {
    const found = (source: string) => source.match(DEADLINE_PATTERN) ?? [];
    expect(found('const remaining = deadline - Date.now();')).toHaveLength(1);
    expect(found('while (Date.now() < deadline) {}')).toHaveLength(1);
    expect(found('if (Date.now() > deadline) break;')).toHaveLength(1);
    expect(found('while (deadline > Date.now()) {}')).toHaveLength(1);
    expect(found('if (performance.now() - t0 > 100) throw e;')).toHaveLength(1);
    expect(found('const r = end - performance.now();')).toHaveLength(1);
    // 拾わない: 経過の上限を測る表明（待ちではない）、アロー関数、時刻を作るだけの式。
    expect(found('expect(Date.now() - started).toBeLessThan(500);')).toEqual([]);
    expect(found('const now = () => Date.now();')).toEqual([]);
    expect(found('const at = new Date(Date.now() - 1000).toISOString();')).toEqual([]);
    expect(found('const deadline = Date.now() + 500;')).toEqual([]);
  });

  it('壁時計の打ち切りの形（`Date.now() - <開始> > <予算>`・`<締切> - Date.now()` ほか）は、名指しの例外の外に無い', () => {
    const hits = scanned.flatMap((f) => {
      const n = [...f.code.matchAll(DEADLINE_PATTERN)].length;
      const allowed = NEGATIVE_WAIT_EXCEPTIONS[f.relative]?.count ?? 0;
      return n === allowed ? [] : [`${f.relative}: ${n} 件（許す件数 ${allowed}）`];
    });
    expect(
      hits,
      '壁時計の予算で諦める待ちが、名指しの例外の外に在る（または例外の件数と合わない）。' +
        '⟹ 正の待ち（条件が成り立つまで待つ）なら、予算を外して諦める条件をテストの寿命へ移すこと' +
        '（`clone-test-harness.ts` の `waitFor`。テストの外なら afterEach で進める epoch）。' +
        '⛔ 3000 を大きくする直しは、確率を下げるだけで同じ賭けが残る。' +
        '「起きないこと」を見る負の待ちなら、NEGATIVE_WAIT_EXCEPTIONS に理由付きで名指しで足す。',
    ).toEqual([]);
  });

  it('名指しの例外は、まだ実在して理由を持つ（残骸を抱えない）', () => {
    for (const [relative, exception] of Object.entries(NEGATIVE_WAIT_EXCEPTIONS)) {
      const file = scanned.find((f) => f.relative === relative);
      expect(file, `${relative} が走査の対象に無い`).toBeDefined();
      expect([...(file?.code.matchAll(DEADLINE_PATTERN) ?? [])]).toHaveLength(exception.count);
      expect(exception.reason.length).toBeGreaterThan(20);
    }
  });
});
