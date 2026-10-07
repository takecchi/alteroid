import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { makeTempDirSync } from '../vitest.tmpdir.js';

import {
  buildCensusOutputPath,
  buildCensusReporterArgs,
  decideJudgementCategory,
  HarnessError,
  isCensusAvailable,
  loadCensus,
  requireCensusAgreesWithTextFailures,
  requireDeclaredNamesExistInCensus,
  requireDeclaredTeethActuallyPassed,
  ROOT,
  // @ts-expect-error -- 素の .mjs（型宣言を持たない変異試験ハーネス）を読む
} from '../.claude/skills/mutation-testing/mutate-core.mjs';

function writeCensusFile(content: string): string {
  const p = path.join(makeTempDirSync('census-test-'), 'census.json');
  fs.writeFileSync(p, content);
  return p;
}

describe('mutate-core: buildCensusOutputPath / buildCensusReporterArgs（#993 段2）', () => {
  it('呼ぶたびに違うパスを作る（前回の残骸を今回の結果として読まないため）', () => {
    const a = buildCensusOutputPath();
    const b = buildCensusOutputPath();
    expect(a).not.toBe(b);
    // os.tmpdir() の下に置き ROOT の直下には置かない: census の一時ファイルが git status に紛れ込まないため。
    expect(a.startsWith(os.tmpdir())).toBe(true);
  });

  it('既定レポータを落とさず、JSON レポータを併用する引数を作る', () => {
    const args = buildCensusReporterArgs('/tmp/x.json');
    expect(args).toEqual(['--reporter=default', '--reporter=json', '--outputFile=/tmp/x.json']);
  });
});

describe('mutate-core: isCensusAvailable', () => {
  it('available: true かつ byName が Map なら true', () => {
    expect(isCensusAvailable({ available: true, byName: new Map() })).toBe(true);
  });

  it('available: false なら false', () => {
    expect(isCensusAvailable({ available: false, reason: 'x' })).toBe(false);
  });

  it('undefined / null / 形が違うオブジェクトも false（判定できないという3つ目の状態を緑にしない）', () => {
    expect(isCensusAvailable(undefined)).toBe(false);
    expect(isCensusAvailable(null)).toBe(false);
    expect(isCensusAvailable({ available: true, byName: {} })).toBe(false);
    expect(isCensusAvailable('census')).toBe(false);
  });
});

describe('mutate-core: loadCensus（census が「取れない」を緑にしない）', () => {
  it('⭐ ファイルが無ければ available: false（vitest 自身の起動失敗を模す）', () => {
    const missingPath = path.join(os.tmpdir(), `census-does-not-exist-${Date.now()}.json`);
    const census = loadCensus(missingPath);
    expect(census.available).toBe(false);
    expect(census.reason).toContain('census ファイルが読めない');
  });

  it('⭐ JSON として壊れていれば available: false', () => {
    const p = writeCensusFile('{this is not valid json');
    const census = loadCensus(p);
    expect(census.available).toBe(false);
    expect(census.reason).toContain('壊れていて読めない');
  });

  it('⭐ 形が想定と違えば（testResults が配列でない）available: false', () => {
    const p = writeCensusFile(JSON.stringify({ success: true }));
    const census = loadCensus(p);
    expect(census.available).toBe(false);
    expect(census.reason).toContain('testResults が配列でない');
  });

  it('⭐ testResults[].name が文字列でない要素があれば available: false', () => {
    const p = writeCensusFile(
      JSON.stringify({ testResults: [{ name: 123, assertionResults: [] }] }),
    );
    const census = loadCensus(p);
    expect(census.available).toBe(false);
    expect(census.reason).toContain('name が文字列でない');
  });

  it('本物の vitest JSON レポータの形（assertionResults 有り）から、FAIL 行と同じ形の名前を作る', () => {
    const file = path.join(ROOT, 'packages/core/src/__census-demo.test.ts');
    const p = writeCensusFile(
      JSON.stringify({
        testResults: [
          {
            name: file,
            assertionResults: [
              {
                ancestorTitles: ['外', '内'],
                title: '赤の歯',
                fullName: '外 内 赤の歯',
                status: 'failed',
              },
              {
                ancestorTitles: ['外', '内'],
                title: '緑の歯',
                fullName: '外 内 緑の歯',
                status: 'passed',
              },
            ],
          },
        ],
      }),
    );
    const census = loadCensus(p);
    expect(census.available).toBe(true);
    expect(census.byName.get('packages/core/src/__census-demo.test.ts > 外 > 内 > 赤の歯')).toBe(
      'failed',
    );
    expect(census.byName.get('packages/core/src/__census-demo.test.ts > 外 > 内 > 緑の歯')).toBe(
      'passed',
    );
  });

  it('⭐ スイートの読み込み自体が失敗したファイル（assertionResults が空）は `<file> [ <file> ]` の形で載せる', () => {
    const file = path.join(ROOT, 'packages/core/src/__census-load-failure.test.ts');
    const p = writeCensusFile(
      JSON.stringify({
        testResults: [
          {
            name: file,
            assertionResults: [],
            status: 'failed',
            message: "Cannot find module './generated/canon.js'",
          },
        ],
      }),
    );
    const census = loadCensus(p);
    expect(census.available).toBe(true);
    expect(
      census.byName.get(
        'packages/core/src/__census-load-failure.test.ts [ packages/core/src/__census-load-failure.test.ts ]',
      ),
    ).toBe('failed');
  });
});

describe('mutate-core: requireCensusAgreesWithTextFailures（交差検算。新設, #993 段2）', () => {
  it('census が無ければ判定を出さない（fail-closed）', () => {
    expect(() =>
      requireCensusAgreesWithTextFailures(['a.test.ts > s > t'], undefined, 'test'),
    ).toThrow(HarnessError);
    expect(() =>
      requireCensusAgreesWithTextFailures(
        ['a.test.ts > s > t'],
        { available: false, reason: 'x' },
        'test',
      ),
    ).toThrow(/census が取れていない/);
  });

  it('一致していれば何も投げない', () => {
    const census = { available: true, byName: new Map([['a.test.ts > s > t', 'failed']]) };
    expect(() =>
      requireCensusAgreesWithTextFailures(['a.test.ts > s > t'], census, 'test'),
    ).not.toThrow();
  });

  it('⭐ テキストにしか無い名前が在れば投げる（テキスト解析が census より広い）', () => {
    const census = { available: true, byName: new Map() };
    expect(() =>
      requireCensusAgreesWithTextFailures(['a.test.ts > s > t'], census, 'test'),
    ).toThrow(/テキストにしか無い/);
  });

  it('⭐ census にしか無い名前が在れば投げる（census が広い）', () => {
    const census = { available: true, byName: new Map([['a.test.ts > s > t', 'failed']]) };
    expect(() => requireCensusAgreesWithTextFailures([], census, 'test')).toThrow(
      /census にしか無い/,
    );
  });
});

describe('mutate-core: requireDeclaredNamesExistInCensus（門6。#993 段2 の本体）', () => {
  it('census が無ければ判定を出さない（fail-closed）', () => {
    expect(() => requireDeclaredNamesExistInCensus(new Set(['a']), undefined, 'test')).toThrow(
      HarnessError,
    );
  });

  it('宣言した名前が census に実在すれば何も投げない', () => {
    const census = { available: true, byName: new Map([['a.test.ts > s > t', 'passed']]) };
    expect(() =>
      requireDeclaredNamesExistInCensus(new Set(['a.test.ts > s > t']), census, 'test'),
    ).not.toThrow();
  });

  it('⭐ 実在しない名前を宣言すると、その名前を列挙して投げる（打ち間違いの検出そのもの）', () => {
    const census = { available: true, byName: new Map([['a.test.ts > s > t', 'passed']]) };
    let message = '';
    try {
      requireDeclaredNamesExistInCensus(
        new Set(['typo.test.ts > x > y']),
        census,
        'decideJudgementCategory',
      );
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('実在しない名前が1本ある');
    expect(message).toContain('typo.test.ts > x > y');
    expect(message).toContain('#993 段2');
  });
});

describe('mutate-core: requireDeclaredTeethActuallyPassed（身代わりの実測化。#993 段2）', () => {
  it('census 上で passed なら何も投げない', () => {
    const census = { available: true, byName: new Map([['a.test.ts > s > t', 'passed']]) };
    expect(() =>
      requireDeclaredTeethActuallyPassed(new Set(['a.test.ts > s > t']), census, 'test'),
    ).not.toThrow();
  });

  it('⭐ census 上で failed なら投げる（狙いの歯が実は落ちていた）', () => {
    const census = { available: true, byName: new Map([['a.test.ts > s > t', 'failed']]) };
    expect(() =>
      requireDeclaredTeethActuallyPassed(new Set(['a.test.ts > s > t']), census, 'test'),
    ).toThrow(/実際にこの走行で落ちなかったこと/);
  });

  it('⭐⭐ census 上で skipped / todo なら投げる（黙って passed 扱いにしない）', () => {
    for (const status of ['skipped', 'todo', 'pending']) {
      const census = { available: true, byName: new Map([['a.test.ts > s > t', status]]) };
      expect(() =>
        requireDeclaredTeethActuallyPassed(new Set(['a.test.ts > s > t']), census, 'test'),
      ).toThrow(HarnessError);
    }
  });
});

describe('mutate-core: decideJudgementCategory に census を通した端から端まで（#993 段2）', () => {
  const NOT_CHECKED = { artifactState: 'not-checked' };
  const EMPTY_SCAFFOLD_CONTROL = {
    measured: true,
    failedNames: [] as string[],
    namesTrustworthy: true,
    scope: '全件',
    extraArgs: [] as string[],
  };
  const RAW_ONE_FAILURE = [
    '⎯⎯⎯ Failed Tests 1 ⎯⎯⎯',
    '',
    ' FAIL  a.test.ts > s > t',
    '',
    ' Test Files  1 failed (1)',
    '      Tests  1 failed (1)',
  ].join('\n');

  it('⭐⭐ 門6: census がまったく無い testResult では、赤い歯 + mustFail でも判定を出さない', () => {
    const testResult = {
      exitCode: 1,
      raw: RAW_ONE_FAILURE,
      filesLine: 'Test Files  1 failed (1)',
      testsLine: 'Tests  1 failed (1)',
    };
    expect(() =>
      decideJudgementCategory(NOT_CHECKED, testResult, EMPTY_SCAFFOLD_CONTROL, [
        'a.test.ts > s > t',
      ]),
    ).toThrow(/census が取れていない/);
  });

  it('⭐⭐ 門6: mustFail が census に実在しない打ち間違いは「身代わり」ではなく HarnessError', () => {
    const testResult = {
      exitCode: 1,
      raw: RAW_ONE_FAILURE,
      filesLine: 'Test Files  1 failed (1)',
      testsLine: 'Tests  1 failed (1)',
      census: { available: true, byName: new Map([['a.test.ts > s > t', 'failed']]) },
    };
    let message = '';
    try {
      decideJudgementCategory(NOT_CHECKED, testResult, EMPTY_SCAFFOLD_CONTROL, [
        'a.test.ts > typo > 実在しない',
      ]);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('実在しない名前が1本ある');
    expect(message).not.toContain('身代わり —');
  });

  it('正しい名前を宣言し、census 上でも failed なら「検出」', () => {
    const testResult = {
      exitCode: 1,
      raw: RAW_ONE_FAILURE,
      filesLine: 'Test Files  1 failed (1)',
      testsLine: 'Tests  1 failed (1)',
      census: { available: true, byName: new Map([['a.test.ts > s > t', 'failed']]) },
    };
    expect(
      decideJudgementCategory(NOT_CHECKED, testResult, EMPTY_SCAFFOLD_CONTROL, [
        'a.test.ts > s > t',
      ]),
    ).toBe('検出');
  });

  it('⭐ 別の実在する歯（census 上 passed）を宣言し、census 上でも passed なら「身代わり」', () => {
    const testResult = {
      exitCode: 1,
      raw: RAW_ONE_FAILURE,
      filesLine: 'Test Files  1 failed (1)',
      testsLine: 'Tests  1 failed (1)',
      census: {
        available: true,
        byName: new Map([
          ['a.test.ts > s > t', 'failed'],
          ['b.test.ts > u > v', 'passed'],
        ]),
      },
    };
    expect(
      decideJudgementCategory(NOT_CHECKED, testResult, EMPTY_SCAFFOLD_CONTROL, [
        'b.test.ts > u > v',
      ]),
    ).toBe('身代わり');
  });

  it('⭐⭐ 実在するが passed でない（skipped）歯を「身代わり」の宣言に使うと判定を出さない', () => {
    const testResult = {
      exitCode: 1,
      raw: RAW_ONE_FAILURE,
      filesLine: 'Test Files  1 failed (1)',
      testsLine: 'Tests  1 failed (1)',
      census: {
        available: true,
        byName: new Map([
          ['a.test.ts > s > t', 'failed'],
          ['b.test.ts > u > v', 'skipped'],
        ]),
      },
    };
    expect(() =>
      decideJudgementCategory(NOT_CHECKED, testResult, EMPTY_SCAFFOLD_CONTROL, [
        'b.test.ts > u > v',
      ]),
    ).toThrow(/実際にこの走行で落ちなかったこと/);
  });
});
