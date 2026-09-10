import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

// @ts-expect-error -- 素の .mjs（型宣言を持たない変異試験ハーネス）を読む
import {
  buildScaffoldControlMarker,
  decideJudgementCategory,
  diffScaffoldFailures,
  extractFailedTeeth,
  failureIndicated,
  formatScaffoldSubtractionReport,
  HarnessError,
  judge,
  parseDeclaredFailureCount,
  parseFailedTestNames,
  SCAFFOLD_CONTROL_STAGE,
} from '../.claude/skills/mutation-testing/mutate-core.mjs';

/**
 * 足場（測定のために置く印）そのものが歯を赤くして、「生存」を「検出」へ
 * 化けさせる欠陥の歯。
 *
 * **欠陥の機構**: 判定は集計行の `failed` の文字しか見ていなかった。逐語は
 * `grep -Fn -- 'const noFailures = !/failed/i.test(testResult.filesLine)' .claude/skills/mutation-testing/mutate-core.mjs`。
 * 終了コードも、落ちた歯の名前も、判定に入らない。⟹ **どこか1本でも赤ければ
 * 「検出」になる。** そしてハーネスは、変異を置き忘れないための安全機構として
 * ROOT の直下へ印（`MUTATION-IN-PROGRESS.json`）を必ず置く（`applyMutation`
 * の手順6）。**その印そのものに反応して赤くなる歯が、この repo に実在する。**
 *
 * **実測（2026-09-09、base `918fa6e`、全件 `pnpm test --maxWorkers=4` を5走行）**:
 * 印を置いただけで（変異を1文字も当てずに）3本の歯が赤くなり `exit 1` になる。
 * 対照の組・集計行・赤くなった歯の名前は `SKILL.md`「足場の印そのものが歯を
 * 赤くする（偽の『検出』）」に在る。
 *
 * **直し方**: 撃つ前にハーネス自身が「印だけ・無変異」の対照を1回取り、落ちた
 * 歯の**名前**を捕まえて、対照で落ちた名前を除いた集合が空かどうかで判定する。
 * 名前が取れなければ「検出」とも「生存」とも言わずに拒む
 * （`decideJudgementCategory` の門4。いまの門番号では、後から
 * 挟んだ「Errors 行」の門2で繰り下がった）。
 *
 * **ここに置く理由（CI で走らせるため）**: `mutate-selftest.mjs` の
 * `SELFTEST_SCENARIOS` を CI から呼ぶ箇所は無い。`scripts/mutate-*.test.ts` が
 * 先例（経緯は `scripts/mutate-root-override.test.ts` の doc に在る）。
 *
 * **⚠️ この歯が測っていないこと**: 「実 ROOT で印を置くと S1〜S3 が赤くなる」
 * ことそのものは測れない —— 実 ROOT へ印を置く歯は、それ自体が並行して走る
 * 本物の測定を汚染する。代わりに、**印の有無で赤/緑が変わる歯を模した
 * 使い捨てツリー**で機構を端から端まで測る（下の CLI 統合）。
 */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const MUTATE_CLI = path.join(REPO_ROOT, '.claude/skills/mutation-testing/mutate.mjs');

/**
 * 本物の vitest 4.1.10 の出力から取った断片（2026-09-09 の全件走行。
 * `packages/core/src/profile.test.ts` の断続的な揺れが1本赤くなった回）。
 * **作り物ではない** —— 見出しの装飾文字（`⎯`）と `FAIL` 行の空白の数も
 * そのままである。
 */
const REAL_SINGLE_FAILURE = [
  ' ❯ packages/core/src/profile.test.ts (26 tests | 1 failed) 21358ms',
  '',
  '⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯',
  '',
  ' FAIL  packages/core/src/profile.test.ts > 器に置く形 > 入れ子のシェルで本文を二度読まない（無限再帰しない）',
  "AssertionError: expected '' to be '1' // Object.is equality",
  '',
  ' Test Files  1 failed | 222 passed (223)',
  '      Tests  1 failed | 5179 passed (5180)',
].join('\n');

const REAL_SINGLE_FAILURE_NAME =
  'packages/core/src/profile.test.ts > 器に置く形 > 入れ子のシェルで本文を二度読まない（無限再帰しない）';

/** 印だけ・無変異で赤くなった3本（S1・S2・S3）の実測の名前。 */
const SCAFFOLD_NAMES = [
  'scripts/mutate-aggregate-blocks.test.ts > mutate.mjs CLI: baseline / run の先頭 baseline 確認（判定の入口2,3/3） > baseline: 複数ブロックのとき exit 1 で拒否し、生ログが判定より前に出る',
  'scripts/mutate-aggregate-blocks.test.ts > mutate.mjs CLI: baseline / run の先頭 baseline 確認（判定の入口2,3/3） > run: baseline 確認で複数ブロックのとき exit 1 で拒否する（run: baseline というラベル）',
  'scripts/mutate-root-override.test.ts > mutate.mjs CLI: --root（回帰・上書き・fail-closed・実効 ROOT の出力） > 歯1: --root <path> を渡すと apply/restore が MARKER_PATH / BACKUP_DIR も含めてそのツリーを使う',
];

function makeRawWithFailures(names: string[]): string {
  return [
    `⎯⎯⎯⎯⎯⎯⎯ Failed Tests ${names.length} ⎯⎯⎯⎯⎯⎯⎯`,
    '',
    ...names.map((n) => ` FAIL  ${n}`),
    '',
    ` Test Files  ${names.length} failed | 220 passed (223)`,
    `      Tests  ${names.length} failed | 5177 passed (5180)`,
  ].join('\n');
}

interface TestResultLike {
  exitCode: number;
  raw: string;
  filesLine: string | null;
  testsLine: string | null;
}

function testResultFrom(raw: string): TestResultLike {
  const filesLine = /^\s*Test Files\s+.+$/m.exec(raw)?.[0].trim() ?? null;
  const testsLine = /^\s*Tests\s+.+$/m.exec(raw)?.[0].trim() ?? null;
  return { exitCode: filesLine?.includes('failed') ? 1 : 0, raw, filesLine, testsLine };
}

const ALL_PASSED = testResultFrom(
  [' Test Files  223 passed (223)', '      Tests  5180 passed (5180)'].join('\n'),
);

const NOT_CHECKED = { artifactState: 'not-checked' };

/** 対照が「測れた」形。`measureScaffoldControl` が返すのと同じ形を手で作る。
 * **これは判定機構の入力を合成しているだけで、運用の経路ではない** ——
 * 差し引く集合を外から渡せる口は CLI にも plan/spec にも無い（下の
 * 「宣言する項目を書いても無視される」の歯）。 */
function measuredControl(names: string[], overrides: Record<string, unknown> = {}) {
  return {
    measured: true,
    failedNames: names,
    namesTrustworthy: true,
    scope: '全件',
    extraArgs: [] as string[],
    ...overrides,
  };
}

// ── 純粋な層: 名前を取る ────────────────────────────────────────────

describe('mutate-core: parseFailedTestNames（落ちた歯の名前を取る）', () => {
  it('本物の vitest の出力から、落ちた歯の名前を取る', () => {
    expect(parseFailedTestNames(REAL_SINGLE_FAILURE)).toEqual([REAL_SINGLE_FAILURE_NAME]);
  });

  it('3本落ちた出力から3本取る（順序も保つ）', () => {
    expect(parseFailedTestNames(makeRawWithFailures(SCAFFOLD_NAMES))).toEqual(SCAFFOLD_NAMES);
  });

  it('ANSI の色付きでも取れる（CI では出力に ESC が入る実測が在る）', () => {
    const ESC = '\u001b';
    const colored = REAL_SINGLE_FAILURE.replace(
      ' FAIL  ',
      `${ESC}[41m${ESC}[1m FAIL ${ESC}[22m${ESC}[49m `,
    );
    // 色が本当に入っていること（入っていなければ、この歯は色を測っていない）。
    expect(colored).toContain(`${ESC}[41m`);
    expect(parseFailedTestNames(colored)).toEqual([REAL_SINGLE_FAILURE_NAME]);
  });

  it('落ちたものが無い出力からは0本（FAIL 行が無い）', () => {
    expect(parseFailedTestNames(ALL_PASSED.raw)).toEqual([]);
  });
});

describe('mutate-core: parseDeclaredFailureCount（見出しが宣言する件数）', () => {
  it('Failed Tests N の見出しから件数を読む', () => {
    expect(parseDeclaredFailureCount(REAL_SINGLE_FAILURE)).toBe(1);
    expect(parseDeclaredFailureCount(makeRawWithFailures(SCAFFOLD_NAMES))).toBe(3);
  });

  it('Failed Suites と Failed Tests が両方在れば合計する', () => {
    const raw = [
      '⎯⎯⎯ Failed Suites 1 ⎯⎯⎯',
      ' FAIL  a.test.ts > 取り込みに失敗',
      '⎯⎯⎯ Failed Tests 2 ⎯⎯⎯',
      ' FAIL  b.test.ts > s > t1',
      ' FAIL  b.test.ts > s > t2',
    ].join('\n');
    expect(parseDeclaredFailureCount(raw)).toBe(3);
  });

  it('見出しが無ければ null（件数を照合する相手が無い、という3つ目の状態）', () => {
    expect(parseDeclaredFailureCount(ALL_PASSED.raw)).toBeNull();
    expect(parseDeclaredFailureCount(' FAIL  a.test.ts > s > t')).toBeNull();
  });
});

describe('mutate-core: extractFailedTeeth（名前を判定に使ってよいか）', () => {
  it('件数が一致すれば使える', () => {
    const t = extractFailedTeeth(testResultFrom(makeRawWithFailures(SCAFFOLD_NAMES)));
    expect(t.trustworthy).toBe(true);
    expect(t.names).toEqual(SCAFFOLD_NAMES);
    expect(t.declared).toBe(3);
    expect(t.reason).toBeNull();
  });

  it('見出しが無ければ使えない（「取れなかった」ではなく「照合できない」）', () => {
    const raw = [
      ' FAIL  a.test.ts > s > t',
      ' Test Files  1 failed (1)',
      '      Tests  1 failed (1)',
    ].join('\n');
    const t = extractFailedTeeth(testResultFrom(raw));
    expect(t.trustworthy).toBe(false);
    expect(t.declared).toBeNull();
    expect(t.reason).toContain('照合する相手が無い');
    // 名前そのものは取れている——「取れなかった」と「取れた名前を信用して
    // よいか決められない」を、返り値の別の欄で分けて持つ。
    expect(t.names).toEqual(['a.test.ts > s > t']);
  });

  it('FAIL 行の数と見出しの件数が食い違えば使えない（テストの出力に紛れた偽の FAIL 行）', () => {
    const raw = [
      // テスト自身の標準出力に FAIL に見える行が混ざった形。
      ' FAIL  これはテストが自分で書いた行であって vitest の失敗ではない',
      '⎯⎯⎯ Failed Tests 1 ⎯⎯⎯',
      ' FAIL  a.test.ts > s > t',
      ' Test Files  1 failed (1)',
      '      Tests  1 failed (1)',
    ].join('\n');
    const t = extractFailedTeeth(testResultFrom(raw));
    expect(t.trustworthy).toBe(false);
    expect(t.names).toHaveLength(2);
    expect(t.declared).toBe(1);
    expect(t.reason).toContain('食い違う');
  });

  it('見出しは在るのに名前が0本なら使えない', () => {
    const raw = [
      '⎯⎯⎯ Failed Tests 0 ⎯⎯⎯',
      ' Test Files  1 failed (1)',
      '      Tests  1 failed (1)',
    ].join('\n');
    const t = extractFailedTeeth(testResultFrom(raw));
    expect(t.trustworthy).toBe(false);
    expect(t.reason).toContain('1本も名指しできない');
  });
});

describe('mutate-core: failureIndicated（testsAllPassed の否定ではない）', () => {
  it('failed が在れば true', () => {
    expect(failureIndicated(testResultFrom(makeRawWithFailures(SCAFFOLD_NAMES)))).toBe(true);
  });

  it('全部 passed なら false', () => {
    expect(failureIndicated(ALL_PASSED)).toBe(false);
  });

  it('failed も passed も名乗らない集計行では false（testsAllPassed も false になる側）', () => {
    const neither: TestResultLike = {
      exitCode: 1,
      raw: ' Test Files  no tests\n      Tests  no tests\n',
      filesLine: 'Test Files  no tests',
      testsLine: 'Tests  no tests',
    };
    expect(failureIndicated(neither)).toBe(false);
  });

  it('集計行が読めなければ null（判定できない）', () => {
    expect(
      failureIndicated({ exitCode: 1, raw: 'x', filesLine: null, testsLine: null }),
    ).toBeNull();
  });
});

// ── 判定を拒む門その4（当時の呼び名は「門その3」——後述の門2を間へ足したので繰り下がった） ──

describe('mutate-core: decideJudgementCategory の門4（落ちた歯の名前を判定に使えないなら判定を出さない）', () => {
  it('⭐ 足場対照で落ちた歯しか落ちていなければ「生存」（この修正が塞いだ偽の「検出」）', () => {
    const testResult = testResultFrom(makeRawWithFailures(SCAFFOLD_NAMES));
    expect(decideJudgementCategory(NOT_CHECKED, testResult, measuredControl(SCAFFOLD_NAMES))).toBe(
      '生存',
    );
  });

  it('⭐ 対照に無い歯が1本でも落ちていれば「検出」', () => {
    const testResult = testResultFrom(
      makeRawWithFailures([...SCAFFOLD_NAMES, REAL_SINGLE_FAILURE_NAME]),
    );
    expect(decideJudgementCategory(NOT_CHECKED, testResult, measuredControl(SCAFFOLD_NAMES))).toBe(
      '検出',
    );
  });

  it('🔴 対照が取れていなければ「検出」とも「生存」とも言わない', () => {
    const testResult = testResultFrom(makeRawWithFailures(SCAFFOLD_NAMES));
    expect(() => decideJudgementCategory(NOT_CHECKED, testResult, undefined)).toThrow(HarnessError);
    let message = '';
    try {
      decideJudgementCategory(NOT_CHECKED, testResult, undefined);
    } catch (err) {
      message = (err as Error).message;
    }
    // 「なぜ拒むか」——印そのものに反応する歯が実在すること。
    expect(message).toContain('足場対照');
    expect(message).toContain('判定を出さない');
    expect(message).toContain(
      '差し引く集合が不明であることは、差し引く集合が0本であることとは違う',
    );
    expect(message).toContain('次にやること');
    // 判定の文言を答えていないこと。
    expect(message).not.toContain('この歯はこの変異を捕まえた');
  });

  it('🔴 対照の名前が信用できなければ判定を出さない（対照側の照合が落ちた場合）', () => {
    const testResult = testResultFrom(makeRawWithFailures(SCAFFOLD_NAMES));
    expect(() =>
      decideJudgementCategory(
        NOT_CHECKED,
        testResult,
        measuredControl(SCAFFOLD_NAMES, { namesTrustworthy: false }),
      ),
    ).toThrow(HarnessError);
  });

  it('🔴 この走行の落ちた歯の名前が取れなければ判定を出さない', () => {
    // 集計行は failed を名乗るが、見出しも FAIL 行も無い（＝名前が取れない）。
    const raw = [' Test Files  1 failed (1)', '      Tests  1 failed (1)'].join('\n');
    let message = '';
    try {
      decideJudgementCategory(NOT_CHECKED, testResultFrom(raw), measuredControl([]));
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('落ちた歯の名前を判定に使えない');
    expect(message).toContain('判定を出さない');
    expect(message).toContain('次にやること');
  });

  it('回帰: すべて通っていれば対照なしでも「生存」（差し引く相手が無いので名前は要らない）', () => {
    expect(decideJudgementCategory(NOT_CHECKED, ALL_PASSED)).toBe('生存');
    expect(decideJudgementCategory(NOT_CHECKED, ALL_PASSED, undefined)).toBe('生存');
  });

  it('🔴 集計行が failed も passed も名乗らないときは判定を出さない（走らなかったのを検出と数えない）', () => {
    const neither: TestResultLike = {
      exitCode: 1,
      raw: ' Test Files  no tests\n      Tests  no tests\n',
      filesLine: 'Test Files  no tests',
      testsLine: 'Tests  no tests',
    };
    expect(() => decideJudgementCategory(NOT_CHECKED, neither, measuredControl([]))).toThrow(
      /failed も passed も名乗っていない/,
    );
  });

  it('差し引く集合が空の対照では、赤い歯はそのまま「検出」（差し引きが過剰でないこと）', () => {
    const testResult = testResultFrom(makeRawWithFailures([REAL_SINGLE_FAILURE_NAME]));
    expect(decideJudgementCategory(NOT_CHECKED, testResult, measuredControl([]))).toBe('検出');
  });

  it('回帰: 門1（集計ブロックが複数）は門4より先に効く', () => {
    const raw = [
      ' Test Files  1 failed (1)',
      '      Tests  1 failed (1)',
      ' Test Files  5 passed (5)',
      '      Tests  42 passed (42)',
    ].join('\n');
    expect(() =>
      decideJudgementCategory(
        NOT_CHECKED,
        {
          exitCode: 1,
          raw,
          filesLine: 'Test Files  5 passed (5)',
          testsLine: 'Tests  42 passed (42)',
        },
        measuredControl([]),
      ),
    ).toThrow(/複数/);
  });
});

describe('mutate-core: diffScaffoldFailures（差し引きの内訳を分けて持つ）', () => {
  it('subtracted / surviving / notReproduced を分ける', () => {
    // 対照では S1・S2・S3 が赤く、この走行では S1・S3 と、対照に無い1本が赤い。
    const thisRun = [SCAFFOLD_NAMES[0], SCAFFOLD_NAMES[2], REAL_SINGLE_FAILURE_NAME];
    const diff = diffScaffoldFailures(
      testResultFrom(makeRawWithFailures(thisRun)),
      measuredControl(SCAFFOLD_NAMES),
    );
    expect(diff.subtracted).toEqual([SCAFFOLD_NAMES[0], SCAFFOLD_NAMES[2]]);
    expect(diff.surviving).toEqual([REAL_SINGLE_FAILURE_NAME]);
    // 印はこの走行でも置かれているので、再現しなかった S2 は印以外の理由で
    // 対照が赤かったことになる（＝断続的な揺れの署名）。
    expect(diff.notReproduced).toEqual([SCAFFOLD_NAMES[1]]);
  });
});

describe('mutate-core: formatScaffoldSubtractionReport（差し引いた名前を黙って引かない）', () => {
  it('差し引いた名前・残った名前・再現しなかった名前を全部列挙する', () => {
    const thisRun = [SCAFFOLD_NAMES[0], REAL_SINGLE_FAILURE_NAME];
    const text = formatScaffoldSubtractionReport(
      testResultFrom(makeRawWithFailures(thisRun)),
      measuredControl(SCAFFOLD_NAMES),
    );
    expect(text).toContain(`[差し引いた] ${SCAFFOLD_NAMES[0]}`);
    expect(text).toContain(`[残った] ${REAL_SINGLE_FAILURE_NAME}`);
    expect(text).toContain(`[対照で赤かったがこの走行では赤くない] ${SCAFFOLD_NAMES[1]}`);
    // 差し引いた中に本物の検出が隠れうることを、報告の側で黙らせない。
    expect(text).toContain('本物の検出が隠れている可能性は残る');
  });
});

describe('mutate-core: judge の判定行（走行範囲を名乗る／外から来た文字列を語彙検査に混ぜない）', () => {
  it('全件走行の判定行は走行範囲と件数を名乗る（名前そのものは載せない）', () => {
    const testResult = testResultFrom(makeRawWithFailures(SCAFFOLD_NAMES));
    const { category, text } = judge(
      { id: 'm-scaffold-all-subtracted' },
      NOT_CHECKED,
      testResult,
      measuredControl(SCAFFOLD_NAMES),
    );
    expect(category).toBe('生存');
    expect(text).toContain('走行範囲: 全件');
    expect(text).toContain('差し引いた足場の赤 3本');
    expect(text).toContain('残った赤 0本');
    // 名前は判定行ではなく証跡の区画に出す（禁止語検査に外の文字列を混ぜない）。
    expect(text).not.toContain(SCAFFOLD_NAMES[0]);
  });

  it('絞り込み走行の判定行は「走らなかった歯について何も言っていない」と名乗る', () => {
    const testResult = testResultFrom(makeRawWithFailures([REAL_SINGLE_FAILURE_NAME]));
    const { text } = judge({ id: 'm-scaffold-filtered' }, NOT_CHECKED, testResult, {
      ...measuredControl([]),
      scope: '絞り込み',
      extraArgs: ['profile.test'],
    });
    expect(text).toContain('走行範囲: 絞り込み');
    expect(text).toContain('走らなかった歯について何も言っていない');
  });

  it('🔴 #348 の回帰: 絞り込みの文字列に pass が入っていても判定行を作れる', () => {
    const testResult = testResultFrom(makeRawWithFailures([REAL_SINGLE_FAILURE_NAME]));
    // `bypass` はこの repo でいちばん測りたい変異の名前（歯を迂回する変異）で
    // あり、走行の絞り込みにもそのまま現れる。判定行の禁止語検査へ外から来た
    // 文字列を混ぜると、ここで拒否される（#348 の欠陥の再生産）。
    expect(() =>
      judge({ id: 'm-guard-bypass' }, NOT_CHECKED, testResult, {
        ...measuredControl([]),
        scope: '絞り込み',
        extraArgs: ['guard-bypass.test'],
      }),
    ).not.toThrow();
  });
});

describe('mutate-core: 足場対照の印は自分が暫定物であることを名乗る', () => {
  it('stage が scaffold-control で、消してよい条件が中身に書いてある', () => {
    const marker = buildScaffoldControlMarker();
    expect(marker.stage).toBe(SCAFFOLD_CONTROL_STAGE);
    expect(marker.note).toContain('ソースは1バイトも変わっていない');
    expect(marker.howToClear).toContain('rm MUTATION-IN-PROGRESS.json');
    // `readMarkerVerified` の必須フィールドを全部持つ（印を読む側が
    // 「印そのものが壊れている」と誤読しないこと）。
    for (const key of ['file', 'md5Pre', 'originalContent', 'backupPath', 'headBefore']) {
      expect(Object.keys(marker)).toContain(key);
    }
  });
});

// ── CLI 統合: 印の有無で赤/緑が変わる歯を、使い捨てツリーで端から端まで ──
//
// **なぜ実 ROOT で測らないか。** 実 ROOT へ印を置く歯は、それ自体が他の歯を
// 汚染する（並行して走る本物の測定から見ると、その印は本物の中断の跡に
// 見える）。だから**印の有無で赤/緑が変わる歯を模した使い捨てツリー**で測る:
// `PATH` の先頭に偽の `pnpm` を置き、それが cwd の `MUTATION-IN-PROGRESS.json`
// と `target.txt` を読んで、vitest と同じ形の出力を作る。
//
// - 印が在る → `足場の歯` が落ちる（＝この repo の S1〜S3 の縮小模型）
// - `target.txt` に `HELLO` が在る → `本物の歯` が落ちる（＝変異に反応する歯）
//
// これで `run` の3つの走行（印なしの baseline / 足場対照 / 変異）が実際に
// 別々の結果を返す状態を作れる。**偽の `pnpm` は本物の歯の代わりであって、
// 判定の側は1文字も差し替えていない。**

const FAKE_PNPM_BODY = `#!/usr/bin/env node
const fs = require('node:fs');
const markerHere = fs.existsSync('MUTATION-IN-PROGRESS.json');
const target = fs.existsSync('target.txt') ? fs.readFileSync('target.txt', 'utf8') : '';
const failed = [];
if (markerHere) failed.push('fake/scaffold.test.ts > 足場の歯 > 印が置かれていると落ちる');
if (target.includes('HELLO')) failed.push('fake/real.test.ts > 本物の歯 > hello が大文字になっていると落ちる');
const TOTAL = 12;
if (failed.length === 0) {
  process.stdout.write(' Test Files  2 passed (2)\\n      Tests  ' + TOTAL + ' passed (' + TOTAL + ')\\n');
  process.exit(0);
}
let out = '\\u23af\\u23af\\u23af Failed Tests ' + failed.length + ' \\u23af\\u23af\\u23af\\n\\n';
for (const n of failed) out += ' FAIL  ' + n + '\\nAssertionError: 偽の pnpm が作った失敗\\n\\n';
out += ' Test Files  ' + failed.length + ' failed | ' + (2 - failed.length) + ' passed (2)\\n';
out += '      Tests  ' + failed.length + ' failed | ' + (TOTAL - failed.length) + ' passed (' + TOTAL + ')\\n';
process.stdout.write(out);
process.exit(1);
`;

const SCAFFOLD_TOOTH = 'fake/scaffold.test.ts > 足場の歯 > 印が置かれていると落ちる';
const REAL_TOOTH = 'fake/real.test.ts > 本物の歯 > hello が大文字になっていると落ちる';

describe('mutate.mjs run: 足場の赤を差し引いて判定する（端から端まで）', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeTmpGitRepo(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mutate-scaffold-control-'));
    tempDirs.push(dir);
    execFileSync('git', ['init', '-q'], { cwd: dir });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: dir });
    fs.writeFileSync(path.join(dir, 'target.txt'), 'hello world\n');
    execFileSync('git', ['add', 'target.txt'], { cwd: dir });
    execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir });
    return dir;
  }

  function makeFakePnpmDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-pnpm-scaffold-'));
    tempDirs.push(dir);
    fs.writeFileSync(path.join(dir, 'pnpm'), FAKE_PNPM_BODY, { mode: 0o755 });
    return dir;
  }

  function runPlan(root: string, plan: unknown[]) {
    const planPath = path.join(root, 'plan.json');
    fs.writeFileSync(planPath, JSON.stringify(plan));
    const fakeDir = makeFakePnpmDir();
    const result = spawnSync('node', [MUTATE_CLI, 'run', '--plan', planPath, '--root', root], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${fakeDir}:${process.env.PATH ?? ''}` },
    });
    return { status: result.status, out: (result.stdout ?? '') + (result.stderr ?? '') };
  }

  it('⭐ 印だけで赤くなる歯しか落ちなければ「生存」と判定し、差し引いた名前を列挙する', () => {
    const root = makeTmpGitRepo();
    // `world` を変える変異。偽の歯は `HELLO` にしか反応しないので、この変異に
    // 反応する歯は1本も無い（＝本当は生存）。**直す前のハーネスは、印だけで
    // 落ちた `足場の歯` を見て「検出」と答えていた。**
    const { status, out } = runPlan(root, [
      {
        id: 'm-world-upcase',
        file: 'target.txt',
        from: 'world',
        to: 'WORLD',
        expect: 1,
        target: null,
      },
    ]);
    expect(status).toBe(0);
    expect(out).toContain('変異 m-world-upcase: 生存');
    // 差し引いた名前が出力に在る（黙って引かない）。
    expect(out).toContain(`[差し引いた] ${SCAFFOLD_TOOTH}`);
    // 判定行が件数と走行範囲を名乗る。
    expect(out).toContain('走行範囲: 全件');
    expect(out).toContain('差し引いた足場の赤 1本');
    expect(out).toContain('残った赤 0本');
    // 足場対照そのものの生ログと、対照で赤くなった名前も出ている。
    expect(out).toContain('--- 足場対照 生ログ ここから ---');
    expect(out).toContain(`[対照] ${SCAFFOLD_TOOTH}`);
    // 復元も後始末も通り、印が残っていないこと。
    expect(fs.existsSync(path.join(root, 'MUTATION-IN-PROGRESS.json'))).toBe(false);
    expect(fs.readFileSync(path.join(root, 'target.txt'), 'utf8')).toBe('hello world\n');
  });

  it('⭐ 変異に反応する歯が1本落ちれば「検出」と判定し、残った名前を列挙する', () => {
    const root = makeTmpGitRepo();
    const { status, out } = runPlan(root, [
      {
        id: 'm-hello-upcase',
        file: 'target.txt',
        from: 'hello',
        to: 'HELLO',
        expect: 1,
        target: null,
      },
    ]);
    expect(status).toBe(0);
    expect(out).toContain('変異 m-hello-upcase: 検出');
    expect(out).toContain(`[差し引いた] ${SCAFFOLD_TOOTH}`);
    expect(out).toContain(`[残った] ${REAL_TOOTH}`);
    expect(out).toContain('差し引いた足場の赤 1本');
    expect(out).toContain('残った赤 1本');
    expect(fs.existsSync(path.join(root, 'MUTATION-IN-PROGRESS.json'))).toBe(false);
  });

  it('🔴 spec に「既知の失敗」を宣言する項目を書いても無視される（人が宣言できる形が無い）', () => {
    const root = makeTmpGitRepo();
    // 差し引く集合の出所は `measureScaffoldControl` の実測だけである。spec に
    // それらしい名前の項目を足しても判定は1文字も動かない —— ここが弱くなると
    // 「これは既知の失敗です」と宣言して「検出」を消せる（＝判定を甘くできる）
    // 形になる。
    const { status, out } = runPlan(root, [
      {
        id: 'm-hello-upcase-with-declared',
        file: 'target.txt',
        from: 'hello',
        to: 'HELLO',
        expect: 1,
        target: null,
        knownFailures: [REAL_TOOTH],
        allowFailures: [REAL_TOOTH],
        expectedFailures: [REAL_TOOTH],
        scaffoldFailures: [REAL_TOOTH],
      },
    ]);
    expect(status).toBe(0);
    expect(out).toContain('変異 m-hello-upcase-with-declared: 検出');
    expect(out).toContain(`[残った] ${REAL_TOOTH}`);
  });

  it('足場対照の印が残ったら、status は「変異は当たっていない」と説明し、restore は拒む', () => {
    const root = makeTmpGitRepo();
    const coreUrl = new URL('../.claude/skills/mutation-testing/mutate-core.mjs', import.meta.url)
      .href;
    // **印の中身は本物の生成側（`buildScaffoldControlMarker`）から作る。**
    // ここでフィクスチャを手書きすると、生成側が変わっても気づけない。
    execFileSync(
      'node',
      [
        '--input-type=module',
        '-e',
        `import { setRootOverride, writeMarkerFile, buildScaffoldControlMarker } from ${JSON.stringify(coreUrl)};\n` +
          `setRootOverride(${JSON.stringify(root)});\n` +
          'writeMarkerFile(buildScaffoldControlMarker());\n',
      ],
      { encoding: 'utf8' },
    );
    expect(fs.existsSync(path.join(root, 'MUTATION-IN-PROGRESS.json'))).toBe(true);

    const statusResult = spawnSync('node', [MUTATE_CLI, 'status', '--root', root], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
    expect(statusResult.status).toBe(2); // 印が在る＝非0（誰かが片付ける必要が在る）
    const statusOut = (statusResult.stdout ?? '') + (statusResult.stderr ?? '');
    expect(statusOut).toContain('足場対照');
    expect(statusOut).toContain('ソースは1バイトも変わっていない');
    expect(statusOut).toContain('rm MUTATION-IN-PROGRESS.json');
    // 変異の印と同じ説明（cp で書き戻せ）を出さないこと——書き戻す対象が無い。
    expect(statusOut).not.toContain('段階: ソースが変異したまま');

    const restoreResult = spawnSync('node', [MUTATE_CLI, 'restore', '--root', root], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
    expect(restoreResult.status).toBe(1);
    const restoreOut = (restoreResult.stdout ?? '') + (restoreResult.stderr ?? '');
    expect(restoreOut).toContain('足場対照');
    expect(restoreOut).toContain('復元する対象が無い');
    // 拒んだのだから、印は残っている（黙って消さない）。
    expect(fs.existsSync(path.join(root, 'MUTATION-IN-PROGRESS.json'))).toBe(true);
  });
});
