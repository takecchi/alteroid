import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  assertRebuildFailureOutcomes,
  // @ts-expect-error -- 素の .mjs（型宣言を持たない変異試験ハーネス）を読む
} from '../.claude/skills/mutation-testing/mutate-selftest.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const SELFTEST_SRC = path.join(REPO_ROOT, '.claude/skills/mutation-testing/mutate-selftest.mjs');

const CORRECT_OUTCOMES = Object.freeze({
  scenario: 'rebuild-failure',
  restoreExitCodeWasNonZero: true,
  markerLeftAfterFailedRebuild: true,
  statusExitCodeAfterFailedRebuild: 2,
  statusReportedProblemAfterFailedRebuild: true,
  distStillHadMutationRightAfterFailedRebuild: true,
  statusMentionsDistStage: true,
  statusShowsCpAsPrimary: false,
  finalCleanupOk: true,
  distCleanAfterRealRestore: true,
  // `gitStatusAfterRealRestore` は主張しない: 未追跡ファイルなので常に非空で、参考のみのため。
  gitStatusAfterRealRestore: ' M packages/core/src/index.ts\n',
  fixtureContentRestoredAfterRealRestore: true,
  scaffoldRemovedOk: true,
  distCleanAfterScaffoldRemoved: true,
});

const BROKEN: ReadonlyArray<readonly [string, unknown]> = [
  ['restoreExitCodeWasNonZero', false],
  ['markerLeftAfterFailedRebuild', false],
  ['statusExitCodeAfterFailedRebuild', 0],
  ['statusReportedProblemAfterFailedRebuild', false],
  ['distStillHadMutationRightAfterFailedRebuild', false],
  ['statusMentionsDistStage', false],
  ['statusShowsCpAsPrimary', true],
  ['finalCleanupOk', false],
  ['distCleanAfterRealRestore', false],
  ['fixtureContentRestoredAfterRealRestore', false],
  ['scaffoldRemovedOk', false],
  ['distCleanAfterScaffoldRemoved', false],
];

describe('mutate-selftest: assertRebuildFailureOutcomes', () => {
  it('⭐ 正しい観測値の組では投げない（「常に投げる」過剰な実装を落とす）', () => {
    expect(() => {
      assertRebuildFailureOutcomes({ ...CORRECT_OUTCOMES });
    }).not.toThrow();
  });

  it.each(BROKEN)('欄 %s が化けたら投げ、その欄を名指しする', (key, broken) => {
    expect(() => {
      assertRebuildFailureOutcomes({ ...CORRECT_OUTCOMES, [key]: broken });
    }).toThrow(new RegExp(key));
  });

  it.each(BROKEN.map(([key]) => key))('欄 %s が測れていない（undefined）なら投げる', (key) => {
    expect(() => {
      assertRebuildFailureOutcomes({ ...CORRECT_OUTCOMES, [key]: undefined });
    }).toThrow(new RegExp(key));
  });

  it('⚠ gitStatusAfterRealRestore は主張しない（シナリオ自身が「参考のみ」と言っている）', () => {
    expect(() => {
      assertRebuildFailureOutcomes({
        ...CORRECT_OUTCOMES,
        gitStatusAfterRealRestore: 'まったく別の文字列',
      });
    }).not.toThrow();
  });
});

describe('mutate-selftest: scenarioRebuildFailure が主張を実際に呼ぶ', () => {
  it('scenarioRebuildFailure の本体に assertRebuildFailureOutcomes の呼び出しが在る', () => {
    const src = fs.readFileSync(SELFTEST_SRC, 'utf8');
    const start = src.indexOf('function scenarioRebuildFailure(');
    expect(start).toBeGreaterThan(-1);
    const next = src.indexOf('\nfunction ', start + 1);
    const body = next === -1 ? src.slice(start) : src.slice(start, next);
    expect(body).toContain('assertRebuildFailureOutcomes(');
  });
});

// 本物の build 呼び出しが擬似 pnpm を用意するより前に位置することまで見る: 順序を確かめないと、呼んではいるが手遅れ（擬似 pnpm を汚した後）という取り違えを見逃すため。
describe('mutate-selftest: scenarioRebuildFailure が擬似 pnpm より前に本物の build を挟む', () => {
  it('buildAndCheckArtifact(spec) の呼び出しが、擬似 pnpm を用意する行より前に在る', () => {
    const src = fs.readFileSync(SELFTEST_SRC, 'utf8');
    const start = src.indexOf('function scenarioRebuildFailure(');
    expect(start).toBeGreaterThan(-1);
    const next = src.indexOf('\nfunction ', start + 1);
    const body = next === -1 ? src.slice(start) : src.slice(start, next);

    const buildIndex = body.indexOf('buildAndCheckArtifact(spec)');
    const poisonIndex = body.indexOf('擬似 pnpm を用意した');
    expect(buildIndex).toBeGreaterThan(-1);
    expect(poisonIndex).toBeGreaterThan(-1);
    expect(buildIndex).toBeLessThan(poisonIndex);
  });
});
