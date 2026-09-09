import { describe, expect, it } from 'vitest';

// @ts-expect-error -- 素の .mjs（型宣言を持たない変異試験ハーネス）を読む
import {
  assertAggregateBlocksUnambiguous as harnessAssertAggregateBlocksUnambiguous,
  HarnessError,
  parseAggregateLines as harnessParseAggregateLines,
  stripAnsi,
} from '../.claude/skills/mutation-testing/mutate-core.mjs';
// @ts-expect-error -- 素の .mjs（型宣言を持たない test-guard の中核）を読む
import { parseAggregateLines as guardParseAggregateLines } from './test-guard-core.mjs';
// @ts-expect-error -- 素の .mjs（型宣言を持たない build 用スクリプト）を読む
import { testRan as verifyTestRan } from './verify-core.mjs';

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
 * **3箇所に同じ形が在ることを見張る歯**（#372 / #355 / #392）。
 *
 * `scripts/test-guard-core.mjs`（#311 / PR #355）・
 * `.claude/skills/mutation-testing/mutate-core.mjs`（#372 / PR #374）・
 * `scripts/verify-core.mjs`（この PR。#392）は、**同じ問題に同じ形の解を
 * 別々に持っている** — 同じ正規表現（`/\x1b\[[0-9;]*m/g` と
 * `/^\s*Test Files\s+.+$/m` / `/^\s*Tests\s+.+$/m`）・同じ関数名（`stripAnsi`）・
 * 同じ順序（剥がしてから match）。**前者2つは `parseAggregateLines`（集計行
 * そのものを返す）を持つが、`verify-core.mjs` の `testRan` は真偽値しか
 * 返さない** —— インターフェースの形までは揃えていない（`verify-core.mjs`
 * 側は集計行の中身を使う先が無いので、返り値の形を変える理由が無い）。
 * だから3箇所の突き合わせは「集計行が見つかったかどうか」という共通の
 * 意味だけを比べる（下の `hasSummary`）。
 *
 * **元々は #372 / #355 の2箇所だけを見張る `describe` だった。この PR で
 * `verify-core` を3つ目として同じ `describe` へ足した** —— 別のファイル・
 * 別の `describe` として2本目の「突き合わせ」を作ると、それ自体が
 * 「同じ形が2箇所に在る」問題の再演になるため（この歯自身が禁じている形）。
 *
 * **なぜ共有の出所（他を import する形）を作らないか。** ハーネス側
 * （`.claude/skills/mutation-testing/`）は「**依存なし・ビルド不要**（node の
 * 組み込みモジュールだけで動く。壊れた `pnpm build` の下でも使える必要が
 * あるため）」「同じディレクトリの素の `import` で足しているだけで、
 * `node_modules` には一切依存しない」を要件として持つ（`SKILL.md` の逐語）。
 * `../../../scripts/*.mjs` を import すると、**リポジトリが壊れているときに
 * こそ使う道具**が `scripts/` の配置に結びつく。逆向き（`scripts/` から
 * skill を import）も、`scripts/verify-core.mjs` から `test-guard-core.mjs`
 * を import する形も採らない — 3つは意図して別々の場所に置かれた別解であり、
 * このテストが読むために依存を足してよい理由にはならない。
 *
 * **⚠️ 跨いでいるのはこのテストだけで、各ハーネス／スクリプトの実行時の
 * 依存は1つも増えていない。** `scripts/mutate-max-workers.test.ts` が
 * `../.claude/skills/mutation-testing/mutate-core.mjs` を import しているのと
 * 同じ形である。
 *
 * ## この歯が守らないこと（⚠️ 書いておかないと過信される）
 *
 * **3つとも同じように壊れる形は捕まえられない。** ここが突き合わせているのは
 * 互いだけであって、**正しさの基準はここには無い。** 3つが仲良く間違った
 * 値へ着地しても、この `describe` は緑のまま通る。**だから「本物の色付き
 * 出力の形」を固定する歯は、3つそれぞれの側に別途要る**（`scripts/
 * test-guard-core.test.ts` が自分の側に、上の `describe`（#372）が
 * `mutate-core.mjs` の側に、`scripts/verify-core.test.ts` が #392 でこの PR
 * から `verify-core.mjs` の側に、それぞれ独立に本物のバイト列を固定して
 * 持っている）。**この突き合わせはその代わりにならない。**
 *
 * **そして「3箇所から同じ正規表現リテラルを読んで `toEqual` で比べる」形に
 * しない**（Issue #372 のコメント / `SKILL.md`「比較の両側が同じ経路で同じ
 * 値へ強制されると、比較そのものが恒真になる」。#301 の教訓）。**測っている
 * のは実装の文字列ではなく、同じ入力を3つ全部へ通したときの出力である。**
 *
 * **⚠️ 意図した範囲限定の差（複数集計ブロック入力）。** 「静かに間違った答えを
 * 返す」欠陥（複合スクリプトで vitest の集計ブロックが複数出たとき、無関係な
 * 最初のブロックだけを見て判定してしまう）を塞ぐ修正で、`mutate-core.mjs` の
 * `parseAggregateLines` は「最初」ではなく「最後」のブロックを返す形に変え、
 * さらに `assertAggregateBlocksUnambiguous`（同ファイル）が「複数ブロックが
 * 在ったら判定そのものを拒む」を、`decideJudgementCategory` / `mutate.mjs` の
 * `cmdBaseline` / `cmdRun` の3箇所（＝判定の入口の全部）に足した
 * （`scripts/mutate-aggregate-blocks.test.ts`）。**この修正は `mutate-core.mjs`
 * だけに入れてあり、`scripts/test-guard-core.mjs` と `scripts/verify-core.mjs`
 * は今回の範囲外（意図して触っていない）。** ⟹ **複数ブロックを含む入力を
 * 3箇所へ通すと、結果が食い違う**（`mutate-core.mjs` は「最後のブロック」
 * を返すが `test-guard-core.mjs` は元の「最初のブロック」のままで、
 * `verify-core.mjs` の `testRan` は真偽値しか返さないのでブロック数に関わらず
 * 答えが変わらない）。**だから下の `it.each` には複数ブロックの入力を足さない**
 * ——足せば3箇所の突き合わせが意図どおり落ちる（この歯の役目は「3箇所が
 * 同じに壊れていないか」を見張ることであって、複数ブロック入力はその前提が
 * 崩れた領域である）。**⟹ この範囲限定を doc だけに書いても、doc は検査されない。
 * だから下の `describe` の名前をその範囲まで狭め、隣にもう1つ `describe` を置いて
 * 「3箇所がどう食い違うか」を歯として固定した**（`describe('複数の集計ブロックを
 * 含む入力: …')`）。
 */
describe('集計行の判定: 単一ブロック相当の入力では3箇所の実装が食い違わないこと (#372 / #355 / #392)', () => {
  /** `parseAggregateLines` の結果を、`testRan` と同じ意味（集計行が見つかったか）
   * に均す。3箇所を比べるための共通の物差しはこれだけである。 */
  const hasSummary = (result: { filesLine: string | null; testsLine: string | null }) =>
    result.filesLine !== null && result.testsLine !== null;

  it.each([
    ['色付きの生バイト', COLORED_OUTPUT],
    ['色の付いていない出力', PLAIN_OUTPUT],
    ['集計行が1つも無い出力', NO_SUMMARY_OUTPUT],
    ['紛らわしい行のみ（探す語を緩めたら当たる形）', DECOY_OUTPUT],
    ['空文字列', ''],
  ])('%s を3箇所へ通すと、同じ集計行が返る', (_name, input) => {
    const harness = harnessParseAggregateLines(input);
    const guard = guardParseAggregateLines(input);
    expect(guard).toEqual(harness);
    expect(verifyTestRan(input)).toBe(hasSummary(harness));
    expect(verifyTestRan(input)).toBe(hasSummary(guard));
  });

  it('集計行が無い入力では、3箇所とも「無い」を返す（1箇所だけが「何でも読める」に倒れない）', () => {
    const expected = { filesLine: null, testsLine: null };
    expect(harnessParseAggregateLines(NO_SUMMARY_OUTPUT)).toEqual(expected);
    expect(guardParseAggregateLines(NO_SUMMARY_OUTPUT)).toEqual(expected);
    expect(verifyTestRan(NO_SUMMARY_OUTPUT)).toBe(false);
  });

  it('色付きの生バイトでは、3箇所とも本物の集計行を認識する（全部 false/null で「一致」しない）', () => {
    const harness = harnessParseAggregateLines(COLORED_OUTPUT);
    const guard = guardParseAggregateLines(COLORED_OUTPUT);
    // 一致だけを測ると「全部 null」でも緑になる。中身も名指しする。
    expect(harness.filesLine).toBe('Test Files  130 passed (130)');
    expect(harness.testsLine).toBe('Tests  2493 passed (2493)');
    expect(guard).toEqual(harness);
    expect(verifyTestRan(COLORED_OUTPUT)).toBe(true);
  });
});

/** 複合スクリプト（`vitest run && pnpm -r --if-present run test && …`）が出す
 * 2ブロックの生ログを模したもの。1本目と2本目で件数を変え、「最初」を読んだか
 * 「最後」を読んだかが返り値そのものから分かるようにしてある（`scripts/
 * mutate-aggregate-blocks.test.ts` の `MULTI_BLOCK_FIRST_RED_LAST_GREEN` と同じ
 * 狙いだが、あちらは赤/緑の対比、こちらは最初/最後の対比が主題なのでフィクス
 * チャは別に持つ）。 */
const MULTI_BLOCK_FIRST_THEN_SECOND = [
  ' RUN  v4.1.10 /tmp/probe (workspace package A)',
  '',
  ' Test Files  1 passed (1)',
  '      Tests  3 passed (3)',
  '   Start at  06:44:56',
  '   Duration  50ms',
  '',
  ' RUN  v4.1.10 /tmp/probe (workspace package B)',
  '',
  ' Test Files  9 passed (9)',
  '      Tests  99 passed (99)',
  '   Start at  06:44:58',
  '   Duration  120ms',
].join('\n');

/**
 * **複数の集計ブロックを含む入力: 3箇所がどう食い違うかを名指しで固定する歯。**
 *
 * 直上の `describe` は名前を「単一ブロック相当の入力では」まで狭めた。狭めた
 * だけでは、その doc が書いている「複数ブロックでは3箇所が食い違う」という
 * 主張そのものは、doc の文章としてしか存在しないままになる——**doc は検査
 * されない。** この `describe` は、その食い違いを実際に3箇所へ通した値として
 * 固定する。
 *
 * **3通りの違いがある（形がそれぞれ別である。「3つが違う」と丸めない）:**
 *
 * | 実装 | 複数ブロック入力に対して |
 * | --- | --- |
 * | `mutate-core.mjs` の `parseAggregateLines` | **最後**のブロックを返す。加えて `assertAggregateBlocksUnambiguous` が判定そのものを拒む機構を持つ |
 * | `test-guard-core.mjs` の `parseAggregateLines` | **最初**のブロックを返す（`/m` のみ、`/g` 無し）——中身が harness と食い違う |
 * | `verify-core.mjs` の `testRan` | `.test()` で真偽値しか返さない——**ブロックが何個在っても答えが変わらない**。「最初/最後」の区別を持たないので、この欠陥に対して*形として*免疫が在る（到達可能性とは別の、より強い理由） |
 *
 * ## なぜ `test-guard-core.mjs` / `verify-core.mjs` を直さずに、この食い違いを固定するのか
 *
 * **この歯は「3箇所が違う」を固定する。何も書かなければ、次に読む人にはこれが
 * 「食い違いを容認している歯」に見え、直そうとした人の前に立つ。** だから
 * 「なぜ違ってよいか」をここに書く——「意図した仕様である」の一言だけでは、
 * 前提が崩れたときに誰も気づけない。
 *
 * **測った内容**: `test-guard-core.mjs` / `verify-core.mjs` の判定関数
 * （`parseAggregateLines` / `testRan` / `classifyTest`）へ、複数ブロックの入力が
 * **いまの HEAD の実装が持つ構造としては届かないことを測って確かめた**
 * （測定日 2026-09-09、`origin/main` = `a77562a`〔#742 直後の `1421398` から
 * #744・#741 の2本が積まれた版〕の木で当たり直した。潰した経路は7本）:
 *
 * 1. `test-guard-core.mjs` の判定関数（`parseAggregateLines`）を import している
 *    非テストファイルは `scripts/test.mjs` の1本だけ
 *    （`command grep -rln --exclude-dir=node_modules --exclude-dir=.git --
 *    "from './test-guard-core.mjs'" .` で3件——うち2件は `*.test.ts`）。
 * 2. `verify-core.mjs` の判定関数（`testRan` / `classifyTest`）を import している
 *    非テストファイルは `scripts/verify.mjs` の1本だけ（`.github/scripts/
 *    verify-for-sdk-pr.test.ts` は `STEPS` 配列だけを import しており判定関数は
 *    使っていない）。
 * 3. `scripts/test.mjs` は `spawn('vitest', ['run', ...args], …)` をループの外に
 *    1回だけ書いている（`function runVitest(args)` の中。呼び出しも `main()` から
 *    1回だけ）。
 * 4. `verify.mjs` は9門のうち `isTest: true` の1本（`pnpm test`）だけを `runTest`
 *    で捕まえ、他8門は `stdio: 'inherit'` で出力を捨てる——門の出力が連結されて
 *    判定へ渡る経路は無い。
 * 5. root + 8パッケージの `test` スクリプト9本は全部が単発の
 *    `node …/scripts/test.mjs …` で、`&&` も `;` も `pnpm -r` も1つも無い
 *    （`package.json` を9本全部当たった）。
 * 6. `vitest.config.ts` に `projects` は無く、`vitest.workspace.ts` も存在せず、
 *    `reporters` の指定も無い——1回の `vitest run` が集計ブロックを2つ出す形は
 *    この repo の設定では無い。
 * 7. `.github/scripts/verify-for-sdk-pr.sh` は9門を個別ログ・個別終了コードで
 *    判定し、`verify-core.mjs` / `test-guard-core.mjs` の判定関数を一度も
 *    呼んでいない（連結ログ `verify.md` は人間が読む PR 本文の材料）。
 *
 * **⟹ だから `test-guard-core.mjs` / `verify-core.mjs` は「最初」を返す実装の
 * ままでよい。**
 *
 * **⚠️ ただし「いまは来ない」であって「来えない」の証明ではない。** 上の7本は
 * 「いまの HEAD の実装が持つ構造としては複数ブロックが来ない」までしか言って
 * いない——恒久的な性質の証明ではない。**もし将来これらに複数ブロックが届く
 * 経路ができたら、この歯はその時点で意味を失う。** そのときやることは、この
 * 歯を消すことではなく、まず到達可能性を測り直すことである（上の7本を当たり
 * 直し、経路が増えていないか確かめる）。測り直した結果いまも来ないなら歯は
 * そのまま残ってよく、来るようになっていたら `test-guard-core.mjs` /
 * `verify-core.mjs` 側を直す番になる。
 */
describe('複数の集計ブロックを含む入力: 3箇所がどう食い違うか（意図した範囲限定の差を歯で固定する）', () => {
  it('mutate-core.mjs の parseAggregateLines は最後のブロックを返す', () => {
    const { filesLine, testsLine } = harnessParseAggregateLines(MULTI_BLOCK_FIRST_THEN_SECOND);
    // 最初のブロックの値ではないこと。
    expect(filesLine).not.toBe('Test Files  1 passed (1)');
    expect(testsLine).not.toBe('Tests  3 passed (3)');
    // 最後のブロックの値であること。
    expect(filesLine).toBe('Test Files  9 passed (9)');
    expect(testsLine).toBe('Tests  99 passed (99)');
  });

  it('mutate-core.mjs は assertAggregateBlocksUnambiguous で複数ブロックの判定そのものを拒む', () => {
    expect(() =>
      harnessAssertAggregateBlocksUnambiguous(MULTI_BLOCK_FIRST_THEN_SECOND, 'test'),
    ).toThrow(HarnessError);
  });

  it('test-guard-core.mjs の parseAggregateLines は最初のブロックを返す（harness の「最後」と食い違う）', () => {
    const { filesLine, testsLine } = guardParseAggregateLines(MULTI_BLOCK_FIRST_THEN_SECOND);
    expect(filesLine).toBe('Test Files  1 passed (1)');
    expect(testsLine).toBe('Tests  3 passed (3)');
    // harness（最後を返す）と guard（最初を返す）は、同じ入力で別の値を返す。
    expect(guardParseAggregateLines(MULTI_BLOCK_FIRST_THEN_SECOND)).not.toEqual(
      harnessParseAggregateLines(MULTI_BLOCK_FIRST_THEN_SECOND),
    );
  });

  it('verify-core.mjs の testRan はブロックが何個あっても答えが変わらない（真偽値しか返さないので「最初/最後」の区別を持たない）', () => {
    expect(verifyTestRan(MULTI_BLOCK_FIRST_THEN_SECOND)).toBe(true);
    // 単一ブロック（PLAIN_OUTPUT）でも複数ブロックでも同じ true が返る
    // ——ブロック数に対して形として免疫があることを、値の一致で示す。
    expect(verifyTestRan(MULTI_BLOCK_FIRST_THEN_SECOND)).toBe(verifyTestRan(PLAIN_OUTPUT));
  });
});
