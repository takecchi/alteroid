import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// `timeout:` だけでなく `expect.poll` そのものを禁止する: option を書かなくても既定の 1000ms で諦め、`timeout:` だけの禁止は素通りされるため。
// `it(name, fn, 15_000)` の明示のタイムアウトは禁止しない: vitest の testTimeout であって、ポーリングの打ち切りではないため。
// コメントを落としてから走査する: 禁止する形そのものを経緯として書いたコメントで、この歯が落ちるため。
// 列挙は自動走査ではなく登録制: 命名規則だけでは、元の分割群と他の Issue が足した別の器のテストを区別できないため。

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

// `//` は行頭のときだけ落とす: 行末に付いた `//` まで落とすと、同じ行のコードごと視野から消えて取りこぼすため。
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
  // ファイルごとの一覧で保つ: 1本の巨大な文字列へ結合すると、違反が「どこにあるか」が消えるため。
  const files = TARGET_RELATIVE_PATHS.map((relative, i) => ({
    relative,
    code: stripComments(readFileSync(TARGET_FILES[i]!, 'utf8')),
  }));

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

// 例外は名指しで1件ずつ書き、件数も固定する: 「起きないこと」を一定時間見る負の待ちは予算を外すと意味が変わり、同じファイルへの2件目を見逃さないため。
const SCAN_ROOTS: readonly string[] = ['packages', 'apps'];
const SCAN_EXCLUDE_DIRS: ReadonlySet<string> = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.react-router',
  '.vite',
]);
// 1本の正規表現の選択肢にする: 同じ場所を2回数えないため。
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
