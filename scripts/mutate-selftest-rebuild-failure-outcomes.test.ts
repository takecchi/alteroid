import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  assertRebuildFailureOutcomes,
  // @ts-expect-error -- 素の .mjs（型宣言を持たない変異試験ハーネス）を読む
} from '../.claude/skills/mutation-testing/mutate-selftest.mjs';

/**
 * `rebuild-failure` シナリオの戻り値に、機械の主張が付いていることの歯（#1166 / #1138）。
 *
 * **塞いでいる穴**: `scenarioRebuildFailure` は 13 個の観測値を組み立てて返すが、
 * そのうち機械が見ていたのは `statusMentionsDistStage` / `statusShowsCpAsPrimary`
 * の2つだけで、残りは `log()` に流れるだけだった。⟹ **`restore` が 0 で終わる・
 * 印が残らない・dist の変異が消えない・後始末が失敗する、のどれが起きても
 * シナリオは緑のまま通る。**
 *
 * これは #1138 が他のシナリオについて塞いだ穴と同じ形である（`assertDeliveryOutcomes`
 * の逐語: 「なぜ落とすか: 戻り値を検査しなければ、判定が化けても緑のまま残る（#1138）」）。
 * #1166 の 2026-09-23 のコメントが、`rebuild-failure` だけ取り残されていることを
 * 残件として名指ししている。
 *
 * **2層で撃つ**（`mutate-selftest-marker-guidance.test.ts` と同じ形）:
 * 純粋な層（主張の関数を直接呼ぶ）と、配線の層（シナリオ本体がその関数を
 * 実際に呼んでいること）。⛔ **前者だけだと「関数は在るが誰も呼んでいない」を
 * 見逃す。**
 *
 * ⭐ **過剰な実装も落とす。** 正しい観測値の組を渡したら投げないことを先に置く
 * ——「常に投げる」実装は、否定側の歯だけなら全部緑で通ってしまう。
 */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const SELFTEST_SRC = path.join(REPO_ROOT, '.claude/skills/mutation-testing/mutate-selftest.mjs');

/**
 * シナリオが実演しているはずの結末。**値の出どころは推測ではなくハーネスの現物である**:
 *
 * - `restoreExitCodeWasNonZero` / `markerLeftAfterFailedRebuild` /
 *   `distStillHadMutationRightAfterFailedRebuild` —— 擬似 pnpm（常に `exit 1`）で
 *   後始末を落とした直後の状態。シナリオの見出しが逐語で「後始末の build が落ちても、
 *   印が残り status が知らせることの確認」と言っている当のもの
 * - `statusExitCodeAfterFailedRebuild: 2` —— `mutate.mjs` の `cmdStatus` は、印が在って
 *   変異が当たったままのとき `process.exit(2)` で終わる
 * - `statusShowsCpAsPrimary: false` —— dist だけが問題の段階で cp 手順を主経路として
 *   出すと、次の人はソースの復元をやり直して「直った」と誤解する
 */
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
  // ⚠ `gitStatusAfterRealRestore` は主張しない —— シナリオ自身が逐語で
  // 「未追跡ファイルなので常に非空。参考のみ」と言っている。
  gitStatusAfterRealRestore: ' M packages/core/src/index.ts\n',
  fixtureContentRestoredAfterRealRestore: true,
  scaffoldRemovedOk: true,
  distCleanAfterScaffoldRemoved: true,
});

/** 主張されるべき欄と、その欄が壊れたときに入る値。 */
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

// ── 純粋な層: 主張の関数そのもの ─────────────────────────────────

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

// ── 配線の層: シナリオ本体が実際に呼んでいるか ───────────────────

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

/**
 * `distStillHadMutationRightAfterFailedRebuild` が実際に測っていたのは
 * 「dist が最初から変異を含んでいない」ことであって、「後始末の build が
 * 落ちたら dist が古いまま残る」ことではなかった（#1166 面2で実測）。
 * `scenarioRebuildFailure` は 6a（applyMutation）の後、擬似 pnpm（常に
 * exit 1）で PATH を汚す前に、本物の pnpm で一度 build して dist へ
 * 変異を届けておく必要がある——それが無いと、後始末の成否と無関係に
 * この欄は常に false になる。
 *
 * ⟹ この歯は「本物の build 呼び出しが在る」だけでなく、**それが擬似 pnpm を
 * 用意するより前に位置していること**まで見る。順序を確かめないと、
 * 「呼んではいるが手遅れ（擬似 pnpm を汚した後）」という取り違えを見逃す。
 */
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
