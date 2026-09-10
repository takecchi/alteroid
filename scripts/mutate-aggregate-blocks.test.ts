import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

// @ts-expect-error -- 素の .mjs（型宣言を持たない変異試験ハーネス）を読む
import {
  assertAggregateBlocksUnambiguous,
  countAggregateBlocks,
  decideJudgementCategory,
  HarnessError,
  parseAggregateLines,
  ROOT,
} from '../.claude/skills/mutation-testing/mutate-core.mjs';

/**
 * `.claude/skills/mutation-testing/mutate-core.mjs` の `parseAggregateLines` が
 * 「複合スクリプト（`vitest run && pnpm -r --if-present run test && …`）で vitest の
 * 集計ブロックが複数出たとき、最初のブロック（＝変異と無関係なことがある）だけを
 * 見て判定してしまう」欠陥の歯。
 *
 * **欠陥の機構**: 元の実装は `/^\s*Test Files\s+.+$/m`（`/g` 無し）で `.match()` して
 * いたため、`.match()` は**必ず最初の1件**を返していた。単一ブロックしか出ない
 * alteroid 自身（`scripts/test.mjs` が `spawn('vitest', ['run', ...])` で vitest を
 * 1回しか起こさない。`grep -Fn -- "spawn('vitest'" scripts/test.mjs`）では踏まない
 * が、測定対象の repo の `test` スクリプトが複合コマンドだと、無関係な最初のブロック
 * だけを見て「生存」（歯が在るのに無いと言う）または「検出」（歯が無いのに在ると
 * 言う）を静かに出す。実測（別 repo・mnemora）: 8アサーションが赤なのに「生存」と
 * 判定された。
 *
 * **直し方は「最後のブロックを採る」だけではない。** 複数ブロックが在ったという
 * 事実そのものを、件数として持ち回ったうえで、複数在れば判定を拒む
 * （`assertAggregateBlocksUnambiguous`）。`/g` を足して最後を採るだけの直し方だと、
 * 「複数在った」という事実が出力から消え、最初のブロックが無関係な理由で赤くても
 * 最後のブロックだけを見て静かに「生存」と言ってしまう——直したかった欠陥の別形が
 * 残る。
 *
 * **判定の入口は3箇所ある**（`grep -Fn -- 'testsRanCleanly' .claude/skills/mutation-testing/*.mjs`
 * で確認できる）: `mutate-core.mjs` の `decideJudgementCategory` / `mutate.mjs` の
 * `cmdBaseline` / `mutate.mjs` の `cmdRun`（run の先頭の baseline 確認）。3箇所とも
 * 同じ共有ヘルパー `assertAggregateBlocksUnambiguous` を呼ぶ形にして塞いだ。
 * `decideJudgementCategory` はここで直接ユニットテストする。`cmdBaseline` /
 * `cmdRun` は CLI として子プロセスで実際に起動し、`pnpm` を偽物に差し替えて
 * 複数ブロックの出力を与え、拒否（exit 1 かつ拒否メッセージ）を確認する
 * （下の `describe('mutate.mjs CLI …')`）。
 */

const SINGLE_BLOCK_ALL_PASSED = [
  ' RUN  v4.1.10 /tmp/probe',
  '',
  ' Test Files  1 passed (1)',
  '      Tests  11 passed (11)',
  '   Start at  06:44:56',
  '   Duration  201ms',
].join('\n');

/**
 * **⚠️ 失敗の見出しと `FAIL` 行を持たせてある。** 判定は集計行の `failed` の
 * 文字だけでは出せなくなった（`decideJudgementCategory` の門4。いまの門番号
 * では、後から挟んだ「Errors 行」の門2で繰り下がった —— 落ちた歯の
 * 名前を判定に使えなければ拒む。理由と実測は `SKILL.md`「足場の印そのものが
 * 歯を赤くする（偽の『検出』）」）。**集計行だけを持つ赤のフィクスチャは
 * 「判定を出せない」へ倒れる**ので、名前が取れる形（本物の vitest の出力と
 * 同じ形）へ寄せた。**この歯の主張（単一ブロックなら判定できる）は1文字も
 * 変えていない** —— 名前が取れない赤を門4 が拒むことは
 * `scripts/mutate-scaffold-control.test.ts` が別に測る。
 */
const SINGLE_BLOCK_WITH_FAILURE = [
  ' RUN  v4.1.10 /tmp/probe',
  '',
  '⎯⎯⎯ Failed Tests 1 ⎯⎯⎯',
  '',
  ' FAIL  probe.test.ts > 単一ブロック > 1本だけ落ちた',
  '',
  ' Test Files  1 failed (1)',
  '      Tests  1 failed | 10 passed (11)',
  '   Start at  06:44:56',
  '   Duration  201ms',
].join('\n');

/** 足場対照の代わり（この歯は `decideJudgementCategory` を純関数として測る）。
 * **差し引く集合は空**にしてある —— 集計ブロックの数え方を測るのに差し引きを
 * 混ぜない。 */
const EMPTY_SCAFFOLD_CONTROL = {
  measured: true,
  failedNames: [] as string[],
  namesTrustworthy: true,
  scope: '全件',
  extraArgs: [] as string[],
};

/** 紛らわしい行（`Files` / `Tests` を含むが集計行の形ではない）。
 * `scripts/mutate-core-strip-ansi.test.ts` の DECOY_OUTPUT と同じ狙い——
 * 探す語を緩めていないことと、件数の数え方がこれを1ブロックとして誤カウント
 * しないことを、両方確かめる。 */
const DECOY_LINES = ['Files changed: 3', 'Tests: none'];

/** 複合スクリプト（`vitest run && pnpm -r --if-present run test && …`）が
 * 出す2ブロックの生ログを模したもの。1本目は変異と無関係な理由で赤い
 * （もし旧実装のように最初のブロックだけを見れば「検出」になる）。2本目
 * （最後）は緑（もし新実装が「最後を無条件に採用」するだけなら「生存」に
 * なる——だからこのテストは「最後を採る」ではなく「複数在ったら拒む」を
 * 確かめる）。 */
const MULTI_BLOCK_FIRST_RED_LAST_GREEN = [
  ' RUN  v4.1.10 /tmp/probe (workspace package A)',
  '',
  ' Test Files  1 failed (1)',
  '      Tests  8 failed | 2 passed (10)',
  '   Start at  06:44:56',
  '   Duration  120ms',
  '',
  ...DECOY_LINES,
  '',
  ' RUN  v4.1.10 /tmp/probe (workspace package B)',
  '',
  ' Test Files  5 passed (5)',
  '      Tests  42 passed (42)',
  '   Start at  06:44:58',
  '   Duration  300ms',
].join('\n');

/**
 * **出所**: 本物の vitest 5.0.0 を複合スクリプト（`vitest run tests-a && vitest run
 * tests-b --maxWorkers=4`）で走らせ、`tests-b/mul.test.js` に本物の変異（`mul.js` の
 * `*` → `+`）を当てて採取した生ログの vitest 出力部分（harness 自身の拒否メッセージは
 * 含めない——`SINGLE_BLOCK_ALL_PASSED` 等の既存フィクスチャと同じ選び方に揃えた）。
 *
 * **なぜこのフィクスチャが要るか。** 上の `MULTI_BLOCK_FIRST_RED_LAST_GREEN` は
 * 「最初が赤・最後が緑」の1方向しか持たない。`assertAggregateBlocksUnambiguous` は
 * ブロックの**件数**だけで拒否を決め、中身（どちらが赤でどちらが緑か）を見ないので、
 * 現状の実装ではどちらの向きでも同じ分岐（拒否）を通る。**だから1方向しか無いこと自体は
 * 直ちに穴ではない。** ただし「最後のブロックが `failed` を名乗るときは、どうせ判定は
 * 『検出』になるのだから拒まなくてよい」という、もっともらしい劣化（`blockCount <= 1`
 * の判定に「最後が failed なら return」を足す形）を手で当てて確かめたところ、
 * 既存の5ファイルは1つも赤くならなかった（段0の実測）。この劣化は「最初が緑・最後が
 * 赤」のときにだけ黙って通る——既存フィクスチャの唯一の方向（最初が赤・最後が緑）は
 * この劣化を一度も踏まない。**⟹ 逆方向の固定入力が無いことは実在する穴だった。**
 * このフィクスチャはその逆方向を埋める。
 *
 * **変えた場所は1箇所だけ——2本の `RUN` 行にある絶対パスを `/tmp/probe` に置換した**
 * （元は `/home/worker/mgr-f9b32deb/w1/scratch`。既存フィクスチャの `/tmp/probe` という
 * 流儀に揃えた）。**それ以外は1文字も変えていない** — 2ブロックの並び、`Test Files` /
 * `Tests` 行の値、`Failed Tests` の見出し、スタックトレース、`[ELIFECYCLE]` 行を含め、
 * 採取した生ログのままである。
 */
const MULTI_BLOCK_FIRST_GREEN_LAST_RED = [
  ' RUN  v5.0.0 /tmp/probe',
  '',
  '',
  ' Test Files  1 passed (1)',
  '      Tests  1 passed (1)',
  '   Start at  08:24:19',
  '   Duration  182ms (transform 64%, import 22%, worker 8%, tests 5%)',
  '',
  '',
  ' RUN  v5.0.0 /tmp/probe',
  '',
  ' ❯ tests-b/mul.test.js (1 test | 1 failed) 9ms',
  '   ❯ mul (1)',
  '     × multiplies two numbers 7ms',
  '',
  ' Test Files  1 failed (1)',
  '      Tests  1 failed (1)',
  '   Start at  08:24:20',
  '   Duration  202ms (transform 69%, import 16%, tests 10%, worker 5%)',
  '',
  '$ vitest run tests-a && vitest run tests-b --maxWorkers=4',
  '',
  '⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯',
  '',
  ' FAIL  tests-b/mul.test.js > mul > multiplies two numbers',
  'AssertionError: expected 5 to be 6 // Object.is equality',
  '',
  '- Expected',
  '+ Received',
  '',
  '- 6',
  '+ 5',
  '',
  ' ❯ tests-b/mul.test.js:6:23',
  "      4| describe('mul', () => {",
  "      5|   it('multiplies two numbers', () => {",
  '      6|     expect(mul(2, 3)).toBe(6);',
  '       |                       ^',
  '      7|   });',
  '      8| });',
  '',
  '⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯',
  '',
  '[ELIFECYCLE] Test failed. See above for more details.',
].join('\n');

describe('mutate-core: parseAggregateLines は複数ブロックで「最後」を返す', () => {
  it('単一ブロックはこれまでどおり読める（回帰）', () => {
    const { filesLine, testsLine } = parseAggregateLines(SINGLE_BLOCK_ALL_PASSED);
    expect(filesLine).toBe('Test Files  1 passed (1)');
    expect(testsLine).toBe('Tests  11 passed (11)');
  });

  it('複数ブロックのとき、最初ではなく最後のブロックを返す', () => {
    const { filesLine, testsLine } = parseAggregateLines(MULTI_BLOCK_FIRST_RED_LAST_GREEN);
    // 最初のブロック（赤）の値ではないことを明示的に確かめる。
    expect(filesLine).not.toBe('Test Files  1 failed (1)');
    expect(testsLine).not.toBe('Tests  8 failed | 2 passed (10)');
    // 最後のブロック（緑）の値であること。
    expect(filesLine).toBe('Test Files  5 passed (5)');
    expect(testsLine).toBe('Tests  42 passed (42)');
  });

  /**
   * 逆向き（最初が緑・最後が赤）。本物の vitest ログ（`MULTI_BLOCK_FIRST_GREEN_LAST_RED`
   * の doc に出所がある）を使う。`MULTI_BLOCK_FIRST_RED_LAST_GREEN` の歯と対にして、
   * どちらの向きでも「最初ではなく最後」が返ることを確かめる——向きが逆なら値も逆に
   * 検算されるので、この歯だけが「たまたま最後が来た」を見逃さない。
   */
  it('複数ブロックのとき、向きが逆（最初が緑・最後が赤）でも最後のブロックを返す', () => {
    const { filesLine, testsLine } = parseAggregateLines(MULTI_BLOCK_FIRST_GREEN_LAST_RED);
    // 最初のブロック（緑）の値ではないことを明示的に確かめる。
    expect(filesLine).not.toBe('Test Files  1 passed (1)');
    expect(testsLine).not.toBe('Tests  1 passed (1)');
    // 最後のブロック（赤）の値であること。
    expect(filesLine).toBe('Test Files  1 failed (1)');
    expect(testsLine).toBe('Tests  1 failed (1)');
  });
});

describe('mutate-core: countAggregateBlocks の件数の数え方', () => {
  it('単一ブロックは1個（紛らわしい行が在っても増えない）', () => {
    const raw = [SINGLE_BLOCK_ALL_PASSED, ...DECOY_LINES].join('\n');
    const { filesMatches, testsMatches } = countAggregateBlocks(raw);
    expect(filesMatches).toHaveLength(1);
    expect(testsMatches).toHaveLength(1);
  });

  it('2ブロックは2個と数える', () => {
    const { filesMatches, testsMatches } = countAggregateBlocks(MULTI_BLOCK_FIRST_RED_LAST_GREEN);
    expect(filesMatches).toHaveLength(2);
    expect(testsMatches).toHaveLength(2);
    // 実値も持ち回っていること（拒否メッセージが最初/最後の実値を引用するため）。
    expect(filesMatches[0]).toBe('Test Files  1 failed (1)');
    expect(filesMatches.at(-1)).toBe('Test Files  5 passed (5)');
  });

  /** 逆向き（最初が緑・最後が赤、本物の vitest ログ）でも件数と実値の数え方が同じであること。 */
  it('2ブロックは向きが逆でも2個と数える（本物の vitest ログ）', () => {
    const { filesMatches, testsMatches } = countAggregateBlocks(MULTI_BLOCK_FIRST_GREEN_LAST_RED);
    expect(filesMatches).toHaveLength(2);
    expect(testsMatches).toHaveLength(2);
    expect(filesMatches[0]).toBe('Test Files  1 passed (1)');
    expect(filesMatches.at(-1)).toBe('Test Files  1 failed (1)');
  });

  it('集計行が1つも無ければ0個', () => {
    const { filesMatches, testsMatches } = countAggregateBlocks('Error: write EPIPE');
    expect(filesMatches).toHaveLength(0);
    expect(testsMatches).toHaveLength(0);
  });
});

describe('mutate-core: assertAggregateBlocksUnambiguous', () => {
  it('単一ブロックでは何も投げない', () => {
    expect(() => assertAggregateBlocksUnambiguous(SINGLE_BLOCK_ALL_PASSED, 'test')).not.toThrow();
  });

  it('複数ブロックでは HarnessError を投げ、拒否メッセージに「なぜ」と「次に何を」が入っている', () => {
    let caught: unknown;
    try {
      assertAggregateBlocksUnambiguous(MULTI_BLOCK_FIRST_RED_LAST_GREEN, 'decideJudgementCategory');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(HarnessError);
    const message = (caught as Error).message;
    // 「なぜ拒むか」——複合スクリプトで複数ブロックが出ること、片方を採ると
    // 偽の判定を静かに作ること。鍵となる部分文字列だけを名指しする
    // （変更検知器にしない — 文言をまるごと固定しない）。
    expect(message).toContain('複合コマンド');
    expect(message).toContain('偽の「生存」');
    expect(message).toContain('偽の「検出」');
    // 「次に何をやればいいか」——生ログのどこを見るか、この repo の test スクリプトが
    // vitest を1回だけ起こす形か確認する手順。
    expect(message).toContain('次にやること');
    expect(message).toContain('Test Files');
    expect(message).toContain("spawn('vitest'");
    // 件数と、呼び出し元のラベルが入っている。
    expect(message).toContain('decideJudgementCategory');
    expect(message).toContain('2個');
  });

  /**
   * 逆向き（最初が緑・最後が赤、本物の vitest ログ）でも拒む。
   *
   * **この歯が塞ぐ具体的な劣化**: 「最後のブロックが `failed` を名乗るなら、どうせ
   * 判定は『検出』になるのだから拒まなくてよい」——`if (blockCount <= 1) return;` を
   * 「最後が failed でも return」へ緩める形。この劣化は `MULTI_BLOCK_FIRST_RED_LAST_GREEN`
   * （最後は緑）では一度も分岐に入らないので、あの歯だけでは検出できない（段0で実測
   * 済み）。最後が赤いこのフィクスチャでだけ、緩めた分岐が発火して黙って通ってしまう。
   */
  it('複数ブロックでは、向きが逆（最初が緑・最後が赤）でも HarnessError を投げる（本物の vitest ログ）', () => {
    expect(() =>
      assertAggregateBlocksUnambiguous(MULTI_BLOCK_FIRST_GREEN_LAST_RED, 'decideJudgementCategory'),
    ).toThrow(HarnessError);
  });
});

describe('mutate-core: decideJudgementCategory（判定の入口1/3）', () => {
  const artifactResultNotChecked = { artifactState: 'not-checked' };

  it('⭐ 単一ブロックのときは、これまでどおり判定できる（生存）', () => {
    const category = decideJudgementCategory(artifactResultNotChecked, {
      raw: SINGLE_BLOCK_ALL_PASSED,
      ...parseAggregateLines(SINGLE_BLOCK_ALL_PASSED),
    });
    expect(category).toBe('生存');
  });

  it('⭐ 単一ブロックのときは、これまでどおり判定できる（検出）', () => {
    const category = decideJudgementCategory(
      artifactResultNotChecked,
      {
        raw: SINGLE_BLOCK_WITH_FAILURE,
        ...parseAggregateLines(SINGLE_BLOCK_WITH_FAILURE),
      },
      // 赤い歯が在るときの判定には足場対照が要る（門4）。ここは差し引く
      // 集合が空の対照を渡す——測っているのは集計ブロックの側である。
      EMPTY_SCAFFOLD_CONTROL,
    );
    expect(category).toBe('検出');
  });

  it('複数ブロックのときは判定を拒む（HarnessError）', () => {
    expect(() =>
      decideJudgementCategory(artifactResultNotChecked, {
        raw: MULTI_BLOCK_FIRST_RED_LAST_GREEN,
        ...parseAggregateLines(MULTI_BLOCK_FIRST_RED_LAST_GREEN),
      }),
    ).toThrow(HarnessError);
  });

  /**
   * 逆向き（最初が緑・最後が赤、本物の vitest ログ）でも判定を拒む。
   *
   * **これが本題である。** もし `assertAggregateBlocksUnambiguous` が「最後が failed
   * なら拒まない」へ緩んでいたら、この呼び出しは `testsAllPassed=false` のまま門4
   * （足場対照。いまの門番号——後から挟んだ「Errors 行」の門2で繰り下がった）へ進み、`artifactResultNotChecked` と合わせて**偽の「検出」**を返す
   * ——変異と無関係な後続ブロックの赤を、あたかも歯が変異を捕まえたかのように報告する。
   * `MULTI_BLOCK_FIRST_RED_LAST_GREEN` を使う直上の歯は、最後が緑なのでこの劣化の
   * 分岐を一度も踏まない（段0で実測済み）。
   */
  it('複数ブロックのときは、向きが逆（最初が緑・最後が赤）でも判定を拒む（本物の vitest ログ）', () => {
    // ⚠️ EMPTY_SCAFFOLD_CONTROL を渡し、門4（足場対照が無い）を先に踏まないように
    // する。渡さないと「足場対照が取れていない」という無関係な理由で必ず HarnessError
    // になり、この歯は門1（集計ブロックの複数性）を1文字も検証しないまま緑になる
    // ——実際、最初にこの歯を scaffoldControl 無しで書いたところ、劣化を当てても
    // 門4 のおかげで緑のまま落ちず、この歯自体が穴だった（自己検証で発見）。
    let caught: unknown;
    try {
      decideJudgementCategory(
        artifactResultNotChecked,
        {
          raw: MULTI_BLOCK_FIRST_GREEN_LAST_RED,
          ...parseAggregateLines(MULTI_BLOCK_FIRST_GREEN_LAST_RED),
        },
        EMPTY_SCAFFOLD_CONTROL,
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(HarnessError);
    // 門1（集計ブロックの複数性）で拒んだことを、メッセージで確かめる
    // ——門4（足場対照）の拒否メッセージと取り違えないため。
    expect((caught as Error).message).toContain('複数');
    expect((caught as Error).message).toContain('decideJudgementCategory');
  });

  it('複数ブロックのとき、拒否は「集計行が見つからない」エラーとは別のメッセージである', () => {
    // #444 以前からある別の拒否理由（集計行そのものが無い）と混ざらないこと。
    // 混ざると「複数在るのに『無い』と言う」——AGENTS.md が最も嫌う「『無い』の
    // 種類を潰す」形になる。
    let message = '';
    try {
      decideJudgementCategory(artifactResultNotChecked, {
        raw: MULTI_BLOCK_FIRST_RED_LAST_GREEN,
        ...parseAggregateLines(MULTI_BLOCK_FIRST_RED_LAST_GREEN),
      });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).not.toContain('集計行（Test Files / Tests）が見つからない');
    expect(message).toContain('複数');
  });
});

/**
 * `mutate.mjs` の CLI 層（`cmdBaseline` / `cmdRun`）を子プロセスとして実際に
 * 起動し、`pnpm` を偽物へ差し替えて複数ブロックの出力を返させる。
 *
 * **なぜここだけ子プロセスか。** `mutate.mjs` はモジュール末尾で無条件に
 * `main()` を呼ぶ（`readMaxWorkers` の doc に理由がある）ため、素の `import`
 * では `process.argv` 次第で `process.exit()` が起きてテストプロセスを巻き込む。
 * 子プロセスとして起動すれば、exit code とメッセージだけを安全に観測できる。
 *
 * **`pnpm` を差し替える理由。** `cmdBaseline` / `cmdRun` は実際に
 * `spawnSync('pnpm', [...])` を起こす（`mutate-core.mjs` の `runTests`）。本物の
 * `pnpm test` を複数ブロックの出力に誘導する手段が無いので、`PATH` の先頭に
 * 偽の `pnpm` 実行ファイルを置き、複数ブロックのテキストをそのまま stdout へ
 * 書かせて exit 0 で終わらせる。
 */
describe('mutate.mjs CLI: baseline / run の先頭 baseline 確認（判定の入口2,3/3）', () => {
  const MUTATE_JS = fileURLToPath(
    new URL('../.claude/skills/mutation-testing/mutate.mjs', import.meta.url),
  );
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeFakePnpmDir(outputText: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-pnpm-'));
    tempDirs.push(dir);
    const scriptPath = path.join(dir, 'pnpm');
    const content = `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(outputText)});\nprocess.exit(0);\n`;
    fs.writeFileSync(scriptPath, content, { mode: 0o755 });
    return dir;
  }

  function runCli(
    args: string[],
    fakePnpmOutput: string,
  ): { status: number | null; stdout: string; stderr: string } {
    const fakeDir = makeFakePnpmDir(fakePnpmOutput);
    const env = { ...process.env, PATH: `${fakeDir}:${process.env.PATH ?? ''}` };
    try {
      const stdout = execFileSync('node', [MUTATE_JS, ...args], {
        cwd: ROOT,
        encoding: 'utf8',
        env,
      });
      return { status: 0, stdout, stderr: '' };
    } catch (err) {
      const e = err as { status: number | null; stdout?: string; stderr?: string };
      return { status: e.status, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
    }
  }

  it('baseline: 複数ブロックのとき exit 1 で拒否し、生ログが判定より前に出る', () => {
    const result = runCli(['baseline'], MULTI_BLOCK_FIRST_RED_LAST_GREEN);
    expect(result.status).toBe(1);
    // 生ログ（1本目・2本目の実値）が拒否メッセージより前に出ていること
    // （歯7「加工前の証跡」——判定を拒む経路でも生ログを先に出す）。
    const rawIdx = result.stdout.indexOf('Test Files  1 failed (1)');
    const refusalIdx = result.stdout.indexOf('判定を拒む');
    expect(rawIdx).toBeGreaterThanOrEqual(0);
    expect(refusalIdx).toBeGreaterThan(rawIdx);
    expect(result.stdout).toContain('baseline');
    expect(result.stdout).toContain('次にやること');
  });

  it('run: baseline 確認で複数ブロックのとき exit 1 で拒否する（run: baseline というラベル）', () => {
    const planPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mutate-plan-')), 'plan.json');
    tempDirs.push(path.dirname(planPath));
    fs.writeFileSync(planPath, '[]');
    const result = runCli(['run', '--plan', planPath], MULTI_BLOCK_FIRST_RED_LAST_GREEN);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('run: baseline');
    expect(result.stdout).toContain('次にやること');
  });
});
