import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { makeTempDirSync } from '../vitest.tmpdir.js';

import { gitChildEnv } from './git-child-env.js';
import { mutateCliChildEnv } from './mutate-cli-child-env.js';
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
  validateSpec,
  // @ts-expect-error -- 素の .mjs（型宣言を持たない変異試験ハーネス）を読む
} from '../.claude/skills/mutation-testing/mutate-core.mjs';

// 実 ROOT へ印を置く歯にしない: 並行して走る本物の測定を汚染するため。印の有無で赤/緑が変わる歯を模した使い捨てツリーで測る。

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const MUTATE_CLI = path.join(REPO_ROOT, '.claude/skills/mutation-testing/mutate.mjs');

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

// 固定長タプルとして宣言する: noUncheckedIndexedAccess の下でも SCAFFOLD_NAMES[0..2] を `string | undefined` ではなく `string` として扱うため。
const SCAFFOLD_NAMES: [string, string, string] = [
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

interface CensusLike {
  available: true;
  byName: Map<string, string>;
}

interface TestResultLike {
  exitCode: number;
  raw: string;
  filesLine: string | null;
  testsLine: string | null;
  census?: CensusLike;
}

// census の `failed` はテキスト由来の落ちた歯の集合と一致させる: 交差検算が食い違って誤爆しないようにするため。
function testResultFrom(raw: string, extraPassedNames: string[] = []): TestResultLike {
  const filesLine = /^\s*Test Files\s+.+$/m.exec(raw)?.[0].trim() ?? null;
  const testsLine = /^\s*Tests\s+.+$/m.exec(raw)?.[0].trim() ?? null;
  const byName = new Map<string, string>();
  for (const n of parseFailedTestNames(raw)) byName.set(n, 'failed');
  for (const n of extraPassedNames) byName.set(n, 'passed');
  return {
    exitCode: filesLine?.includes('failed') ? 1 : 0,
    raw,
    filesLine,
    testsLine,
    census: { available: true, byName },
  };
}

const ALL_PASSED = testResultFrom(
  [' Test Files  223 passed (223)', '      Tests  5180 passed (5180)'].join('\n'),
);

const NOT_CHECKED = { artifactState: 'not-checked' };

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
    expect(t.names).toEqual(['a.test.ts > s > t']);
  });

  it('FAIL 行の数と見出しの件数が食い違えば使えない（テストの出力に紛れた偽の FAIL 行）', () => {
    const raw = [
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
    expect(
      decideJudgementCategory(NOT_CHECKED, testResult, measuredControl(SCAFFOLD_NAMES), [
        REAL_SINGLE_FAILURE_NAME,
      ]),
    ).toBe('検出');
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
    expect(message).toContain('足場対照');
    expect(message).toContain('判定を出さない');
    expect(message).toContain(
      '差し引く集合が不明であることは、差し引く集合が0本であることとは違う',
    );
    expect(message).toContain('次にやること');
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
    expect(
      decideJudgementCategory(NOT_CHECKED, testResult, measuredControl([]), [
        REAL_SINGLE_FAILURE_NAME,
      ]),
    ).toBe('検出');
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

describe('mutate-core: decideJudgementCategory の門5（宣言した歯の名前で「検出」/「身代わり」を分ける。#993）', () => {
  it('⭐ 宣言した歯が落ちていれば「検出」', () => {
    const testResult = testResultFrom(
      makeRawWithFailures([...SCAFFOLD_NAMES, REAL_SINGLE_FAILURE_NAME]),
    );
    expect(
      decideJudgementCategory(NOT_CHECKED, testResult, measuredControl(SCAFFOLD_NAMES), [
        REAL_SINGLE_FAILURE_NAME,
      ]),
    ).toBe('検出');
  });

  it('⭐ 宣言した歯が落ちておらず、別の歯だけが落ちていれば「身代わり」', () => {
    const declaredName =
      'packages/core/src/excerpt.test.ts > P1 > fiveFieldViolations は非アンカーで作成/更新を見る';
    const testResult = testResultFrom(
      makeRawWithFailures([...SCAFFOLD_NAMES, REAL_SINGLE_FAILURE_NAME]),
      [declaredName],
    );
    expect(
      decideJudgementCategory(NOT_CHECKED, testResult, measuredControl(SCAFFOLD_NAMES), [
        declaredName,
      ]),
    ).toBe('身代わり');
  });

  it('🔴 狙いの歯が宣言されていなければ「検出」とも「身代わり」とも言わない', () => {
    const testResult = testResultFrom(
      makeRawWithFailures([...SCAFFOLD_NAMES, REAL_SINGLE_FAILURE_NAME]),
    );
    expect(() =>
      decideJudgementCategory(NOT_CHECKED, testResult, measuredControl(SCAFFOLD_NAMES)),
    ).toThrow(HarnessError);
    let message = '';
    try {
      decideJudgementCategory(NOT_CHECKED, testResult, measuredControl(SCAFFOLD_NAMES));
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('mustFail');
    expect(message).toContain('名前の拾い方');
    expect(message).toContain('[残った]');
    expect(message).toContain('FAIL');
  });

  it('⭐ 一方向性: すべて緑なら、何を宣言しても「生存」のまま', () => {
    expect(decideJudgementCategory(NOT_CHECKED, ALL_PASSED, undefined, ['なんでもいい名前'])).toBe(
      '生存',
    );
    expect(
      decideJudgementCategory(NOT_CHECKED, ALL_PASSED, measuredControl([]), [
        REAL_SINGLE_FAILURE_NAME,
      ]),
    ).toBe('生存');
  });

  it('⭐ 一方向性: 足場対照で落ちた歯しか落ちていなければ、それを宣言しても「生存」', () => {
    const testResult = testResultFrom(makeRawWithFailures(SCAFFOLD_NAMES));
    expect(
      decideJudgementCategory(NOT_CHECKED, testResult, measuredControl(SCAFFOLD_NAMES), [
        SCAFFOLD_NAMES[0],
      ]),
    ).toBe('生存');
  });

  it('⭐ 一方向性: 宣言しても [残った] から名前が1本も消えない（diffScaffoldFailures は mustFail を受け取らない）', () => {
    const bystanderDeclaredName = '宣言してもここには居ない歯の名前';
    const testResult = testResultFrom(
      makeRawWithFailures([...SCAFFOLD_NAMES, REAL_SINGLE_FAILURE_NAME]),
      [bystanderDeclaredName],
    );
    const control = measuredControl(SCAFFOLD_NAMES);
    const reportBeforeDeclaring = formatScaffoldSubtractionReport(testResult, control);
    expect(reportBeforeDeclaring).toContain(`[残った] ${REAL_SINGLE_FAILURE_NAME}`);

    const detected = judge(
      { id: 'm-direction-detected', mustFail: [REAL_SINGLE_FAILURE_NAME] },
      NOT_CHECKED,
      testResult,
      control,
    );
    const bystander = judge(
      { id: 'm-direction-bystander', mustFail: [bystanderDeclaredName] },
      NOT_CHECKED,
      testResult,
      control,
    );
    expect(detected.category).toBe('検出');
    expect(bystander.category).toBe('身代わり');

    const reportAfterDeclaring = formatScaffoldSubtractionReport(testResult, control);
    expect(reportAfterDeclaring).toBe(reportBeforeDeclaring);
    expect(reportAfterDeclaring).toContain(`[残った] ${REAL_SINGLE_FAILURE_NAME}`);
  });
});

describe('mutate-core: validateSpec は mustFail を必須にする（走らせる前に拒む。#993）', () => {
  it('🔴 mustFail の無い spec を拒む', () => {
    const specWithoutMustFail = {
      id: 'm-no-mustfail',
      file: 'target.txt',
      from: 'hello',
      to: 'HELLO',
      expect: 1,
      target: null,
    };
    expect(() => validateSpec(specWithoutMustFail)).toThrow(HarnessError);
    let message = '';
    try {
      validateSpec(specWithoutMustFail);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('mustFail');
    expect(message).toContain('狙いの歯');
  });

  it('空配列も、空文字列を含む配列も拒む（非空文字列が1本以上、の検査そのもの）', () => {
    const base = {
      id: 'm-x',
      file: 'target.txt',
      from: 'hello',
      to: 'HELLO',
      expect: 1,
      target: null,
    };
    expect(() => validateSpec({ ...base, mustFail: [] })).toThrow(HarnessError);
    expect(() => validateSpec({ ...base, mustFail: ['  '] })).toThrow(HarnessError);
    expect(() => validateSpec({ ...base, mustFail: [123] })).toThrow(HarnessError);
  });

  it('非空文字列が1本以上あれば通る（他のフィールドが正しい前提で）', () => {
    const base = {
      id: 'm-x',
      file: 'target.txt',
      from: 'hello',
      to: 'HELLO',
      expect: 1,
      target: null,
    };
    expect(() => validateSpec({ ...base, mustFail: ['a.test.ts > s > t'] })).not.toThrow();
  });
});

describe('mutate-core: diffScaffoldFailures（差し引きの内訳を分けて持つ）', () => {
  it('subtracted / surviving / notReproduced を分ける', () => {
    const thisRun = [SCAFFOLD_NAMES[0], SCAFFOLD_NAMES[2], REAL_SINGLE_FAILURE_NAME];
    const diff = diffScaffoldFailures(
      testResultFrom(makeRawWithFailures(thisRun)),
      measuredControl(SCAFFOLD_NAMES),
    );
    expect(diff.subtracted).toEqual([SCAFFOLD_NAMES[0], SCAFFOLD_NAMES[2]]);
    expect(diff.surviving).toEqual([REAL_SINGLE_FAILURE_NAME]);
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
    // 名前は判定行ではなく証跡の区画に出す: 禁止語検査に外の文字列を混ぜないため。
    expect(text).not.toContain(SCAFFOLD_NAMES[0]);
  });

  it('絞り込み走行の判定行は「走らなかった歯について何も言っていない」と名乗る', () => {
    const testResult = testResultFrom(makeRawWithFailures([REAL_SINGLE_FAILURE_NAME]));
    const { text } = judge(
      { id: 'm-scaffold-filtered', mustFail: [REAL_SINGLE_FAILURE_NAME] },
      NOT_CHECKED,
      testResult,
      {
        ...measuredControl([]),
        scope: '絞り込み',
        extraArgs: ['profile.test'],
      },
    );
    expect(text).toContain('走行範囲: 絞り込み');
    expect(text).toContain('走らなかった歯について何も言っていない');
  });

  it('🔴 #348 の回帰: 絞り込みの文字列に pass が入っていても判定行を作れる', () => {
    const testResult = testResultFrom(makeRawWithFailures([REAL_SINGLE_FAILURE_NAME]));
    expect(() =>
      judge(
        { id: 'm-guard-bypass', mustFail: [REAL_SINGLE_FAILURE_NAME] },
        NOT_CHECKED,
        testResult,
        {
          ...measuredControl([]),
          scope: '絞り込み',
          extraArgs: ['guard-bypass.test'],
        },
      ),
    ).not.toThrow();
  });
});

describe('mutate-core: 足場対照の印は自分が暫定物であることを名乗る', () => {
  it('stage が scaffold-control で、消してよい条件が中身に書いてある', () => {
    const marker = buildScaffoldControlMarker();
    expect(marker.stage).toBe(SCAFFOLD_CONTROL_STAGE);
    expect(marker.note).toContain('ソースは1バイトも変わっていない');
    expect(marker.howToClear).toContain('rm MUTATION-IN-PROGRESS.json');
    for (const key of ['file', 'md5Pre', 'originalContent', 'backupPath', 'headBefore']) {
      expect(Object.keys(marker)).toContain(key);
    }
  });
});

// census が言う真偽は judge する側と同じ2つの判定から作る: ずれると、このフィクスチャ自身が交差検算に食い違いとして拒まれるため。
// 常に `passed` の3本目の歯（OTHER_TOOTH）を持つ: 持たないと、「身代わり」を測る CLI テストが宣言できる実在の名前を持てないため。
const FAKE_PNPM_BODY = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const markerHere = fs.existsSync('MUTATION-IN-PROGRESS.json');
const target = fs.existsSync('target.txt') ? fs.readFileSync('target.txt', 'utf8') : '';
const failed = [];
if (markerHere) failed.push('fake/scaffold.test.ts > 足場の歯 > 印が置かれていると落ちる');
if (target.includes('HELLO')) failed.push('fake/real.test.ts > 本物の歯 > hello が大文字になっていると落ちる');
const TOTAL = 12;

const outputArg = process.argv.find((a) => a.startsWith('--outputFile='));
if (outputArg) {
  const outputPath = outputArg.slice('--outputFile='.length);
  const census = {
    testResults: [
      {
        name: path.join(process.cwd(), 'fake/scaffold.test.ts'),
        assertionResults: [
          {
            ancestorTitles: ['足場の歯'],
            title: '印が置かれていると落ちる',
            fullName: '足場の歯 印が置かれていると落ちる',
            status: markerHere ? 'failed' : 'passed',
          },
        ],
      },
      {
        name: path.join(process.cwd(), 'fake/real.test.ts'),
        assertionResults: [
          {
            ancestorTitles: ['本物の歯'],
            title: 'hello が大文字になっていると落ちる',
            fullName: '本物の歯 hello が大文字になっていると落ちる',
            status: target.includes('HELLO') ? 'failed' : 'passed',
          },
        ],
      },
      {
        name: path.join(process.cwd(), 'fake/other.test.ts'),
        assertionResults: [
          {
            ancestorTitles: ['別の歯'],
            title: 'これは変異にもマーカーにも反応せず常に通る（正しく宣言できる狙いの歯）',
            fullName: '別の歯 これは変異にもマーカーにも反応せず常に通る（正しく宣言できる狙いの歯）',
            status: 'passed',
          },
        ],
      },
    ],
    success: failed.length === 0,
    numTotalTests: 3,
    numFailedTests: failed.length,
  };
  fs.writeFileSync(outputPath, JSON.stringify(census));
}

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
const OTHER_TOOTH =
  'fake/other.test.ts > 別の歯 > これは変異にもマーカーにも反応せず常に通る（正しく宣言できる狙いの歯）';

describe('mutate.mjs run: 足場の赤を差し引いて判定する（端から端まで）', () => {
  function makeTmpGitRepo(): string {
    const dir = makeTempDirSync('mutate-scaffold-control-');
    execFileSync('git', ['init', '-q'], { cwd: dir, env: gitChildEnv() });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], {
      cwd: dir,
      env: gitChildEnv(),
    });
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: dir, env: gitChildEnv() });
    fs.writeFileSync(path.join(dir, 'target.txt'), 'hello world\n');
    execFileSync('git', ['add', 'target.txt'], { cwd: dir, env: gitChildEnv() });
    execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir, env: gitChildEnv() });
    return dir;
  }

  function makeFakePnpmDir(): string {
    const dir = makeTempDirSync('fake-pnpm-scaffold-');
    fs.writeFileSync(path.join(dir, 'pnpm'), FAKE_PNPM_BODY, { mode: 0o755 });
    return dir;
  }

  function buildRunPlanEnv(fakeDir: string): NodeJS.ProcessEnv {
    const base = mutateCliChildEnv();
    return { ...base, PATH: `${fakeDir}:${base.PATH ?? ''}` };
  }

  function runPlan(root: string, plan: unknown[]) {
    const planPath = path.join(root, 'plan.json');
    fs.writeFileSync(planPath, JSON.stringify(plan));
    const fakeDir = makeFakePnpmDir();
    const result = spawnSync('node', [MUTATE_CLI, 'run', '--plan', planPath, '--root', root], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: buildRunPlanEnv(fakeDir),
    });
    return { status: result.status, out: (result.stdout ?? '') + (result.stderr ?? '') };
  }

  it('親の process.env にある偽の値は、子へ渡す env に含まれない（#1854）', () => {
    const key = 'ALTEROID_TEST_FAKE_1854';
    const before = process.env[key];
    process.env[key] = 'not-a-real-value';
    try {
      const env = buildRunPlanEnv(makeFakePnpmDir());
      expect(env).not.toHaveProperty(key);
    } finally {
      if (before === undefined) delete process.env[key];
      else process.env[key] = before;
    }
  });

  it('⭐ 印だけで赤くなる歯しか落ちなければ「生存」と判定し、差し引いた名前を列挙する', () => {
    const root = makeTmpGitRepo();
    const { status, out } = runPlan(root, [
      {
        id: 'm-world-upcase',
        file: 'target.txt',
        from: 'world',
        to: 'WORLD',
        expect: 1,
        target: null,
        mustFail: [REAL_TOOTH],
      },
    ]);
    expect(status).toBe(0);
    expect(out).toContain('変異 m-world-upcase: 生存');
    expect(out).toContain(`[差し引いた] ${SCAFFOLD_TOOTH}`);
    expect(out).toContain('走行範囲: 全件');
    expect(out).toContain('差し引いた足場の赤 1本');
    expect(out).toContain('残った赤 0本');
    expect(out).toContain('--- 足場対照 生ログ ここから ---');
    expect(out).toContain(`[対照] ${SCAFFOLD_TOOTH}`);
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
        mustFail: [REAL_TOOTH],
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

  it('⭐ --root が symlink を挟んでいても（macOS の /var → /private/var）、census の名前がテキストと揃い「検出」と判定する（#4399）', () => {
    const realRoot = makeTmpGitRepo();
    const root = path.join(makeTempDirSync('mutate-scaffold-link-'), 'root');
    fs.symlinkSync(realRoot, root);
    const { status, out } = runPlan(root, [
      {
        id: 'm-hello-upcase',
        file: 'target.txt',
        from: 'hello',
        to: 'HELLO',
        expect: 1,
        target: null,
        mustFail: [REAL_TOOTH],
      },
    ]);
    expect(status).toBe(0);
    expect(out).toContain('変異 m-hello-upcase: 検出');
    expect(out).toContain(`[残った] ${REAL_TOOTH}`);
  });

  it('⭐ CLI 統合: 宣言した歯とは別の歯だけが落ちれば「身代わり」（#993 の本体）', () => {
    const root = makeTmpGitRepo();
    const { status, out } = runPlan(root, [
      {
        id: 'm-hello-upcase-bystander',
        file: 'target.txt',
        from: 'hello',
        to: 'HELLO',
        expect: 1,
        target: null,
        mustFail: [OTHER_TOOTH],
      },
    ]);
    expect(status).toBe(0);
    expect(out).toContain('変異 m-hello-upcase-bystander: 身代わり');
    expect(out).toContain(`[宣言] ${OTHER_TOOTH}`);
    expect(out).toContain('census 上の状態: "passed"');
    expect(out).toContain('次にやること: 証跡の [残った] と [宣言] を読む');
    expect(out).toContain(`[差し引いた] ${SCAFFOLD_TOOTH}`);
    expect(out).toContain(`[残った] ${REAL_TOOTH}`);
    expect(fs.existsSync(path.join(root, 'MUTATION-IN-PROGRESS.json'))).toBe(false);
  });

  it('⭐⭐ CLI 統合: 門6（新設, #993 段2）— mustFail の打ち間違いは HarnessError で、「身代わり」ではない', () => {
    const root = makeTmpGitRepo();
    const typoName = 'fake/typo.test.ts > 打ち間違えた describe > 打ち間違えた it（実在しない）';
    const { status, out } = runPlan(root, [
      {
        id: 'm-hello-upcase-typo',
        file: 'target.txt',
        from: 'hello',
        to: 'HELLO',
        expect: 1,
        target: null,
        mustFail: [typoName],
      },
    ]);
    expect(status).toBe(0);
    // 語の有無ではなく判定の言い回し（`変異 <id>: 身代わり`）の有無で見る: エラー本文が説明のために「身代わり」という語を使うのは正当なため。
    expect(out).not.toContain('変異 m-hello-upcase-typo: 身代わり');
    expect(out).not.toContain('変異 m-hello-upcase-typo: 検出');
    expect(out).toContain('判定を出せない');
    expect(out).toContain('実在しない名前が1本ある');
    expect(out).toContain(typoName);
    expect(out).toContain('#993 段2');
    expect(out).toContain('変異 m-hello-upcase-typo: judge-error');
    expect(fs.existsSync(path.join(root, 'MUTATION-IN-PROGRESS.json'))).toBe(false);
    expect(fs.readFileSync(path.join(root, 'target.txt'), 'utf8')).toBe('hello world\n');
  });

  it('🔴 spec に「既知の失敗」を宣言する項目を書いても無視される（人が宣言できる形が無い）', () => {
    const root = makeTmpGitRepo();
    // 差し引く集合は実測（`measureScaffoldControl`）だけから作り、spec の項目を無視する: 宣言にすると広さを人が握り、狭く宣言すると印に起因する赤が「検出」に化けるため。
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
        mustFail: [REAL_TOOTH],
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
    // 印の中身は本物の生成側（`buildScaffoldControlMarker`）から作る: フィクスチャを手書きすると、生成側が変わっても気づけないため。
    execFileSync(
      'node',
      [
        '--input-type=module',
        '-e',
        `import { setRootOverride, writeMarkerFile, buildScaffoldControlMarker } from ${JSON.stringify(coreUrl)};\n` +
          `setRootOverride(${JSON.stringify(root)});\n` +
          'writeMarkerFile(buildScaffoldControlMarker());\n',
      ],
      { encoding: 'utf8', env: mutateCliChildEnv() },
    );
    expect(fs.existsSync(path.join(root, 'MUTATION-IN-PROGRESS.json'))).toBe(true);

    const statusResult = spawnSync('node', [MUTATE_CLI, 'status', '--root', root], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: mutateCliChildEnv(),
    });
    expect(statusResult.status).toBe(2);
    const statusOut = (statusResult.stdout ?? '') + (statusResult.stderr ?? '');
    expect(statusOut).toContain('足場対照');
    expect(statusOut).toContain('ソースは1バイトも変わっていない');
    expect(statusOut).toContain('rm MUTATION-IN-PROGRESS.json');
    expect(statusOut).not.toContain('段階: ソースが変異したまま');

    const restoreResult = spawnSync('node', [MUTATE_CLI, 'restore', '--root', root], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: mutateCliChildEnv(),
    });
    expect(restoreResult.status).toBe(1);
    const restoreOut = (restoreResult.stdout ?? '') + (restoreResult.stderr ?? '');
    expect(restoreOut).toContain('足場対照');
    expect(restoreOut).toContain('復元する対象が無い');
    expect(fs.existsSync(path.join(root, 'MUTATION-IN-PROGRESS.json'))).toBe(true);
  });
});
