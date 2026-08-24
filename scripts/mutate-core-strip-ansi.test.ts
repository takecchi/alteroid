import { describe, expect, it } from 'vitest';

// @ts-expect-error -- 素の .mjs（型宣言を持たない変異試験ハーネス）を読む
import {
  parseAggregateLines as harnessParseAggregateLines,
  stripAnsi,
} from '../.claude/skills/mutation-testing/mutate-core.mjs';
// @ts-expect-error -- 素の .mjs（型宣言を持たない test-guard の中核）を読む
import { parseAggregateLines as guardParseAggregateLines } from './test-guard-core.mjs';

/**
 * #372: 変異試験ハーネス（`.claude/skills/mutation-testing/mutate-core.mjs`）の
 * `runTests` が、ANSI で色付けされた vitest の集計行を読めない欠陥の歯。
 *
 * **⚠️ ハーネス側でこの欠陥を実際に踏んだ観測は無い。** `spawnSync` は TTY を
 * 作らないので、多くの場合 vitest は色を落とす。Issue #372 自身が「`mutate-core.mjs`
 * が実際に色付きの出力を受け取る場面が在るかは確認していない」「根拠は静的な読み
 * だけである」と断っている。**この歯が固定しているのは「色が付いても倒れない」で
 * あって、「実際に色が付く」ではない。**
 *
 * ## フィクスチャの出所（⚠️ 本物のバイトか、組み立てた文字列か）
 *
 * **本物のバイトである。手で組み立てた文字列ではない。** 下の `COLORED_*` は
 * **vitest 4.1.10 自身の集計行フォーマッタを呼んで生成した**（この repo の
 * `node_modules` に在る `vitest/dist/chunks/utils.BS4fH3nR.js` の
 * `padSummaryTitle` と `getStateString` — `BaseReporter.reportTestSummary` が
 * `this.log(padSummaryTitle('Test Files'), getStateString(files))` の**2引数**で
 * 呼んでいるものそのもの。node の `Console.log` が引数を空白1つで連結するので、
 * 実出力では両者のあいだに空白が1つ入る）。生成に使ったコマンドは PR 本文に在る。
 *
 * **そして生成した結果は、PR #355 が `scripts/test-guard-core.test.ts` に固定して
 * いる「CI ログから採った」断片と1バイトも違わなかった**（実測で突き合わせた）。
 * つまりこのフィクスチャは、独立な2つの経路（#355 の CI ログ採取／この repo の
 * vitest のフォーマッタ呼び出し）が同じバイト列に着いたものである。
 *
 * **⚠️ 自分で vitest の CLI に色を吐かせることはできなかった。** この器では
 * `FORCE_COLOR=1` / `FORCE_COLOR=3` / `--color` / 疑似端末（`script`）のどれでも
 * vitest 4.1.10 の出力に SGR が1バイトも出なかった（`tr -dc '\033' | wc -c` が 0)。
 * 一方、同じプロセスの中で tinyrainbow 自体は色を出す状態だった（`--import` で
 * 差し込んだプローブで確認）。**この食い違いの理由は特定していない。**
 *
 * **⚠️ ただし「色が付く条件」は1つ特定できた —— GitHub Actions の CI である。**
 * この PR の CI（run `32671276901` と `32672700282` の2回で再現。**head sha ではなく
 * run id で書いてある** —— sha は rebase で動くが run は動かない。job `ci` /
 * step `Run pnpm test`）の **raw log archive** を展開すると、集計行2本に
 * **ESC(0x1B) が16個**入っている（`gh run view --log` は ESC を ^[ へ均して
 * しまうので、archive のバイトで数えた）。逐語:
 *
 *   "\u001b[2m Test Files \u001b[22m \u001b[1m\u001b[32m133 passed\u001b[39m…"
 *   "\u001b[2m      Tests \u001b[22m \u001b[1m\u001b[32m2559 passed\u001b[39m…"
 *
 * **⟹ 下のフィクスチャは、独立な3つ目の経路でも同じ形に着いた**（件数だけが違う）。
 * そして**その生バイトを ANSI 除去なしの形へ通すと両方 `null` になる** —— この歯が
 * 固定している欠陥は、**本物の出力で再現する。**
 *
 * **⚠️ それでも「ハーネスが踏んだ」ではない。** ハーネスは器の中で `spawnSync` から
 * `pnpm test` を起こすのであって、GitHub Actions の中では走らない。**測れたのは
 * 「色が付く経路が実在する」までである。**
 */

/** vitest 4.1.10 自身のフォーマッタが出した本物のバイト列（上の doc を見ること）。 */
const ESC = '\x1b';
const COLORED_FILES_LINE = `${ESC}[2m Test Files ${ESC}[22m ${ESC}[1m${ESC}[32m130 passed${ESC}[39m${ESC}[22m${ESC}[90m (130)${ESC}[39m`;
const COLORED_TESTS_LINE = `${ESC}[2m      Tests ${ESC}[22m ${ESC}[1m${ESC}[32m2493 passed${ESC}[39m${ESC}[22m${ESC}[90m (2493)${ESC}[39m`;
const COLORED_OUTPUT = [
  ` ${ESC}[32m✓${ESC}[39m scripts/mutate-max-workers.test.ts ${ESC}[2m(11 tests)${ESC}[22m`,
  '',
  COLORED_FILES_LINE,
  COLORED_TESTS_LINE,
  `${ESC}[2m   Start at ${ESC}[22m 06:44:56`,
  `${ESC}[2m   Duration ${ESC}[22m 201ms`,
].join('\n');

/** 色の付いていない出力（この器で `vitest run` を実際に打って得た形）。 */
const PLAIN_OUTPUT = [
  ' RUN  v4.1.10 /tmp/mgr-6ff7ba34/pr372',
  '',
  ' Test Files  1 passed (1)',
  '      Tests  11 passed (11)',
  '   Start at  06:44:56',
  '   Duration  201ms',
].join('\n');

/** 集計行が1つも出ないまま終わった出力（fork pool が `write EPIPE` で死ぬ形。
 * `AGENTS.md`「`pnpm test` は器が混んでいると、テスト0本のまま `exit 1` になる」）。 */
const NO_SUMMARY_OUTPUT = [
  ' RUN  v4.1.10 /tmp/mgr-6ff7ba34/pr372',
  '',
  'Error: write EPIPE',
  '    at afterWriteDispatched (node:internal/stream_base_commons:159:15)',
].join('\n');

/**
 * **集計行ではないが `Files` / `Tests` を含む行。** 探す語を緩めるとここに当たる。
 * どの行も厳密な形には当たらない —— `Files changed:` に `Test Files` は無く、
 * `Tests:` は `Tests` の直後が空白ではなく `:` だからである。
 */
const DECOY_OUTPUT = [
  ' RUN  v4.1.10 /workspace/alteroid',
  '',
  'Files changed: 3',
  'Tests: none',
  'Error: write EPIPE',
].join('\n');

describe('mutate-core: stripAnsi / parseAggregateLines (#372)', () => {
  it('色付きの生バイトでも集計行を読める（filesLine / testsLine が null にならない）', () => {
    const { filesLine, testsLine } = harnessParseAggregateLines(COLORED_OUTPUT);
    expect(filesLine).not.toBeNull();
    expect(testsLine).not.toBeNull();
    expect(filesLine).toBe('Test Files  130 passed (130)');
    expect(testsLine).toBe('Tests  2493 passed (2493)');
  });

  it('剥がした後の文字列に ANSI エスケープが1文字も残らない', () => {
    const plain = stripAnsi(COLORED_OUTPUT);
    // 「1文字も残っていない」を件数で名指しする（`toContain` の否定だと
    // 「何文字残ったか」が落ちる）。
    const escapeCount = [...plain].filter((ch) => ch === '\x1b').length;
    expect(escapeCount).toBe(0);
    // 剥がした結果が、色を付ける前の素の行そのものになっていること。
    expect(plain).toContain(' Test Files  130 passed (130)');
    expect(plain).toContain('      Tests  2493 passed (2493)');
  });

  it('返す集計行そのものにもエスケープが残らない（行の中ほどの色も剥がれている）', () => {
    const { filesLine, testsLine } = harnessParseAggregateLines(COLORED_OUTPUT);
    expect(filesLine).not.toContain('\x1b');
    expect(testsLine).not.toContain('\x1b');
  });

  it('色が付いていない入力も、これまでどおり読める（回帰）', () => {
    const { filesLine, testsLine } = harnessParseAggregateLines(PLAIN_OUTPUT);
    expect(filesLine).toBe('Test Files  1 passed (1)');
    expect(testsLine).toBe('Tests  11 passed (11)');
  });

  /**
   * **⭐ この歯がいちばん大事である。**
   *
   * ANSI を剥がすのは行頭の空白判定を助けるためだけで、探す語（`Test Files` /
   * `Tests`）は1文字も緩めていない。ここが「剥がせば何でも読める」に緩むと、
   * **「1本も走っていない」を検出する仕組みそのものが壊れる** — `runTests` →
   * `testsRanCleanly` → `decideJudgementCategory` の「判定できない」という3つ目の
   * 状態が消え、`write EPIPE` で1本も走らなかった回が「走って通った」に化ける
   * （`AGENTS.md`「『判定できない』という3つ目の状態を持つ」/ #311）。
   */
  it('集計行が本当に無い入力では、剥がしても null のままである', () => {
    expect(harnessParseAggregateLines(NO_SUMMARY_OUTPUT)).toEqual({
      filesLine: null,
      testsLine: null,
    });
  });

  it('色付きでも、集計行が無ければ null のままである', () => {
    const coloredButNoSummary = `${ESC}[31mError: write EPIPE${ESC}[39m\n${ESC}[2m   Duration ${ESC}[22m 201ms`;
    expect(harnessParseAggregateLines(coloredButNoSummary)).toEqual({
      filesLine: null,
      testsLine: null,
    });
  });

  /**
   * **⭐ 探す語そのものが緩んだときに落ちる歯。**
   *
   * **⚠️ これより上の歯だけでは、この緩みは捕まらない。実測で確かめた** ——
   * 探す語を `/^.*Files.*$/m` / `/^.*Tests.*$/m` へ緩める変異を当てたところ、
   * **リポジトリ全体（`Test Files 133 passed (133)` / `Tests 2559 passed (2559)`）で
   * 1本も落ちずに生存した。** 理由は、それまでのフィクスチャが `Files` / `Tests` を
   * 含む行を**集計行としてしか持っていない**ので、緩めても同じ行に当たって値が変わらないからである。
   *
   * ＝ doc は「探す語は1文字も緩めていない」と書いていたのに、**それを測る歯が
   * 無かった。** だから紛らわしい行を持つ入力を別に置く。
   *
   * **緩むと何が壊れるか**は直上の歯と同じ —— 「1本も走っていない」の検出
   * （`testsRanCleanly` →「判定できない」という3つ目の状態）が消える。
   */
  it('`Files` / `Tests` を含むだけの行を集計行と読まない（探す語を緩めていない）', () => {
    expect(harnessParseAggregateLines(DECOY_OUTPUT)).toEqual({
      filesLine: null,
      testsLine: null,
    });
  });

  it('紛らわしい行が先に在っても、本物の集計行のほうを読む', () => {
    // 緩めた正規表現は最初の一致（紛らわしい行）を返すので、ここで値が変わる。
    const decoyThenReal = [DECOY_OUTPUT, COLORED_FILES_LINE, COLORED_TESTS_LINE].join('\n');
    expect(harnessParseAggregateLines(decoyThenReal)).toEqual({
      filesLine: 'Test Files  130 passed (130)',
      testsLine: 'Tests  2493 passed (2493)',
    });
  });

  it('片方だけ出ている場合、出ているほうだけを読み、もう片方は null にする', () => {
    const onlyFiles = `${COLORED_FILES_LINE}\n${ESC}[2m   Duration ${ESC}[22m 201ms`;
    const { filesLine, testsLine } = harnessParseAggregateLines(onlyFiles);
    expect(filesLine).toBe('Test Files  130 passed (130)');
    expect(testsLine).toBeNull();
  });
});

/**
 * **2箇所に同じ形が在ることを見張る歯**（#372 / #355）。
 *
 * `scripts/test-guard-core.mjs`（#311 / PR #355）と
 * `.claude/skills/mutation-testing/mutate-core.mjs`（この PR）は、**同じ問題に
 * 同じ形の解を別々に持っている** — 同じ正規表現（`/\x1b\[[0-9;]*m/g` と
 * `/^\s*Test Files\s+.+$/m` / `/^\s*Tests\s+.+$/m`）・同じ関数名
 * （`stripAnsi` / `parseAggregateLines`）・同じ順序（剥がしてから match）。
 *
 * **なぜ共有の出所（片方が他方を import する形）を作らないか。** ハーネスは
 * 「**依存なし・ビルド不要**（node の組み込みモジュールだけで動く。壊れた
 * `pnpm build` の下でも使える必要があるため）」「同じディレクトリの素の `import`
 * で足しているだけで、`node_modules` には一切依存しない」を要件として持つ
 * （`SKILL.md` の逐語）。`../../../scripts/test-guard-core.mjs` を import すると、
 * **リポジトリが壊れているときにこそ使う道具**が `scripts/` の配置に結びつく。
 * 逆向き（`scripts/` から skill を import）も採らない。
 *
 * **⚠️ 跨いでいるのはこのテストだけで、ハーネスの実行時の依存は1つも増えていない。**
 * `scripts/mutate-max-workers.test.ts` が
 * `../.claude/skills/mutation-testing/mutate-core.mjs` を import しているのと
 * 同じ形である。
 *
 * ## この歯が守らないこと（⚠️ 書いておかないと過信される）
 *
 * **両方が同じように壊れる形は捕まえられない。** ここが突き合わせているのは
 * 互いだけで、**正しさの基準は外に無い。** だから「本物の色付き出力の形」を
 * 固定する歯は、**それぞれの側に別途要る**（`scripts/test-guard-core.test.ts` が
 * 自分の側に持っており、この PR で上の `describe` がこちら側に持った）。
 * **この突き合わせはその代わりにならない。**
 *
 * **そして「両側から同じ正規表現リテラルを読んで `toEqual` で比べる」形にしない**
 * （Issue #372 のコメント / `SKILL.md`「比較の両側が同じ経路で同じ値へ強制されると、
 * 比較そのものが恒真になる」。#301 の教訓）。**測っているのは実装の文字列ではなく、
 * 同じ入力を両方へ通したときの出力である。**
 */
describe('parseAggregateLines: 2箇所の実装が食い違わないこと (#372 / #355)', () => {
  it.each([
    ['色付きの生バイト', COLORED_OUTPUT],
    ['色の付いていない出力', PLAIN_OUTPUT],
    ['集計行が1つも無い出力', NO_SUMMARY_OUTPUT],
    ['空文字列', ''],
  ])('%s を両方へ通すと、同じ集計行が返る', (_name, input) => {
    expect(harnessParseAggregateLines(input)).toEqual(guardParseAggregateLines(input));
  });

  it('集計行が無い入力では、両方とも null を返す（片方だけが「何でも読める」に倒れない）', () => {
    const expected = { filesLine: null, testsLine: null };
    expect(harnessParseAggregateLines(NO_SUMMARY_OUTPUT)).toEqual(expected);
    expect(guardParseAggregateLines(NO_SUMMARY_OUTPUT)).toEqual(expected);
  });

  it('色付きの生バイトでは、両方とも本物の集計行を返す（両方 null で「一致」しない）', () => {
    const harness = harnessParseAggregateLines(COLORED_OUTPUT);
    const guard = guardParseAggregateLines(COLORED_OUTPUT);
    // 一致だけを測ると「両方 null」でも緑になる。中身も名指しする。
    expect(harness.filesLine).toBe('Test Files  130 passed (130)');
    expect(harness.testsLine).toBe('Tests  2493 passed (2493)');
    expect(guard).toEqual(harness);
  });
});
