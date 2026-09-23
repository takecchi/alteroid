import { describe, expect, it } from 'vitest';

import {
  evaluateRequiredGateWorkflows,
  formatResult,
  // @ts-expect-error -- 素の .mjs（型宣言を持たない build 用スクリプト）を読む
} from './check-required-gate-workflows-core.mjs';

/**
 * **required contexts が出るジョブを載せている workflow が、GitHub 上で
 * `active` でなくなったら赤くなること（Issue #1290）。**
 *
 * ## 何が穴だったか
 *
 * 2026-09-22、`.github/workflows/pr-title.yml` が GitHub 上で `disabled_manually`
 * にされた。この workflow が出す required context（`pr-title-type`）は
 * `.github/required-status-checks.json` の宣言にも `ci.yml` 側のジョブ定義にも
 * 1文字も変化が無いまま、check-run が永久に生成されなくなった。**宣言と
 * workflow ファイルの対応を見る歯（`ci-draft-gating.test.ts`）は緑のまま、
 * protection との突き合わせ（`check:required-status-checks`）も緑のまま**——
 * どちらも「GitHub 上でその workflow が生きているか」を見ていないので、この
 * 事故を検知できなかった。
 *
 * ## ここで測るもの・測らないもの
 *
 * - **測る**: 判定（純関数）。合成した「宣言」「ジョブ→workflow ファイルの
 *   対応」「workflow の state 一覧」の組み合わせに対して、`ok` / `disabled` /
 *   `orphan` / `unreadable` の4つを正しく分けること。
 * - **⚠️ 測らない**: **本物のブランチ保護・本物の workflow の state と一致
 *   しているか。** それは `pnpm check:required-gate-workflows` 自身が手元で
 *   実際の repo に対して走ることでしか確かめられない（この歯は offline の
 *   純関数だけを見る）。
 */

interface Detail {
  context: string;
  verdict: 'ok' | 'disabled' | 'orphan';
  workflowFile?: string;
  workflowFiles?: string[];
  state?: string;
  reason: string;
}

interface Result {
  verdict: 'ok' | 'disabled' | 'orphan' | 'unreadable';
  declared: string[];
  details: Detail[];
}

describe('evaluateRequiredGateWorkflows', () => {
  it('ok: required な全 context の workflow が active', () => {
    const result = evaluateRequiredGateWorkflows({
      declaredContexts: ['ci', 'image', 'no-attribution-trailers'],
      jobToWorkflowFiles: {
        ci: ['ci.yml'],
        image: ['ci.yml'],
        'no-attribution-trailers': ['no-attribution-trailers.yml'],
      },
      workflowStates: [
        { path: 'ci.yml', state: 'active' },
        { path: 'no-attribution-trailers.yml', state: 'active' },
      ],
    }) as Result;

    expect(result.verdict).toBe('ok');
    expect(formatResult(result)).toContain('OK — required な全 context');
  });

  /**
   * **#1290 の実物そのものの形。** `pr-title.yml` が `disabled_manually` に
   * なったのに、required context（`pr-title-type`）はそのまま宣言に残っていた。
   * ここでは同じ形を、いまの3本の宣言のうち1本（`no-attribution-trailers`）が
   * `disabled_manually` になったとして固定する。
   */
  it('disabled: required な workflow が disabled_manually になっている（#1290 の実物の形）', () => {
    const result = evaluateRequiredGateWorkflows({
      declaredContexts: ['ci', 'image', 'no-attribution-trailers'],
      jobToWorkflowFiles: {
        ci: ['ci.yml'],
        image: ['ci.yml'],
        'no-attribution-trailers': ['no-attribution-trailers.yml'],
      },
      workflowStates: [
        { path: 'ci.yml', state: 'active' },
        { path: 'no-attribution-trailers.yml', state: 'disabled_manually' },
      ],
    }) as Result;

    expect(result.verdict).toBe('disabled');
    const detail = result.details.find((d) => d.context === 'no-attribution-trailers');
    expect(detail?.verdict).toBe('disabled');
    expect(detail?.workflowFile).toBe('no-attribution-trailers.yml');
    expect(detail?.state).toBe('disabled_manually');

    const text = formatResult(result);
    expect(text).toContain('NG — required な門を出す workflow が無効化されている（Issue #1290）');
    expect(text).toContain('context "no-attribution-trailers": disabled');
    expect(text).toContain('workflow=no-attribution-trailers.yml, state=disabled_manually');
    // 他の道具（check:required-status-checks）との分担を毎回の非 ok 出力に書く。
    expect(text).toContain('pnpm check:required-status-checks');
  });

  it('orphan: context に対応するジョブが .github/workflows/ のどこにも無い', () => {
    const result = evaluateRequiredGateWorkflows({
      declaredContexts: ['ci', 'ghost-job'],
      jobToWorkflowFiles: {
        ci: ['ci.yml'],
      },
      workflowStates: [{ path: 'ci.yml', state: 'active' }],
    }) as Result;

    expect(result.verdict).toBe('orphan');
    const detail = result.details.find((d) => d.context === 'ghost-job');
    expect(detail?.verdict).toBe('orphan');
    expect(detail?.reason).toContain('どこにも無い');

    const text = formatResult(result);
    expect(text).toContain('NG — required context に対応する workflow が特定できない');
    expect(text).toContain('context "ghost-job": orphan');
    // orphan の2つの可能性（消えた／まだ GitHub が知らない）を明示する。
    expect(text).toContain('GitHub がまだこの workflow を');
  });

  it('orphan: 同じジョブ名が複数の workflow に在り決められない', () => {
    const result = evaluateRequiredGateWorkflows({
      declaredContexts: ['ci'],
      jobToWorkflowFiles: {
        ci: ['ci.yml', 'other.yml'],
      },
      workflowStates: [
        { path: 'ci.yml', state: 'active' },
        { path: 'other.yml', state: 'active' },
      ],
    }) as Result;

    expect(result.verdict).toBe('orphan');
    const detail = result.details.find((d) => d.context === 'ci');
    expect(detail?.verdict).toBe('orphan');
    expect(detail?.workflowFiles).toEqual(['ci.yml', 'other.yml']);
    expect(detail?.reason).toContain('決められない');
  });

  it('orphan: 対応する workflow ファイルが GitHub の一覧に無い（新規に足したばかりの可能性）', () => {
    const result = evaluateRequiredGateWorkflows({
      declaredContexts: ['ci', 'brand-new'],
      jobToWorkflowFiles: {
        ci: ['ci.yml'],
        'brand-new': ['brand-new.yml'],
      },
      // brand-new.yml はまだ GitHub の一覧に無い（この枝で新規に足したばかり、
      // という想定）。
      workflowStates: [{ path: 'ci.yml', state: 'active' }],
    }) as Result;

    expect(result.verdict).toBe('orphan');
    const detail = result.details.find((d) => d.context === 'brand-new');
    expect(detail?.verdict).toBe('orphan');
    expect(detail?.workflowFile).toBe('brand-new.yml');
    expect(detail?.reason).toContain('GitHub の workflow 一覧に無い');
  });

  /**
   * **「読めなかった」を緑へ倒さない。** ここが `ok` に化けると、権限が無くて
   * 読めていない状態が「無効化されていない」として出力から消える——それは
   * この検査が塞ぐ穴を、検査自身の中に作り直すことになる。
   */
  it('unreadable: gh api が読めなかったら unreadable。ok にも disabled にも orphan にもしない', () => {
    const result = evaluateRequiredGateWorkflows({
      declaredContexts: ['ci', 'image'],
      jobToWorkflowFiles: { ci: ['ci.yml'], image: ['ci.yml'] },
      workflowStates: null,
    }) as Result;

    expect(result.verdict).toBe('unreadable');
    expect(result.details).toEqual([]);

    const text = formatResult(result);
    expect(text).toContain('判定できなかった');
    expect(text).toContain('これは「無効化されていない」ではない');
    // ⚠️ 素の `OK` で見ないこと —— 「OK」の2文字が別の文脈（英語の一般語）に
    // 紛れ込む余地が無いか確かめる（check-required-status-checks.test.ts と
    // 同じ防御）。
    expect(text).not.toContain('OK — ');
    expect(text.startsWith('check-required-gate-workflows: 判定できなかった')).toBe(true);
  });

  it('disabled が orphan より優先される（同じ結果に両方が混じる場合）', () => {
    const result = evaluateRequiredGateWorkflows({
      declaredContexts: ['ci', 'ghost-job', 'no-attribution-trailers'],
      jobToWorkflowFiles: {
        ci: ['ci.yml'],
        'no-attribution-trailers': ['no-attribution-trailers.yml'],
      },
      workflowStates: [
        { path: 'ci.yml', state: 'active' },
        { path: 'no-attribution-trailers.yml', state: 'disabled_manually' },
      ],
    }) as Result;

    // ghost-job は orphan、no-attribution-trailers は disabled ——
    // 全体の verdict は disabled（実害の確度が高いほうを優先する）。
    expect(result.verdict).toBe('disabled');
  });

  it('陰性対照: 全部 active なら1件も NG 行が出ない', () => {
    const result = evaluateRequiredGateWorkflows({
      declaredContexts: ['ci', 'image', 'no-attribution-trailers'],
      jobToWorkflowFiles: {
        ci: ['ci.yml'],
        image: ['ci.yml'],
        'no-attribution-trailers': ['no-attribution-trailers.yml'],
      },
      workflowStates: [
        { path: 'ci.yml', state: 'active' },
        { path: 'no-attribution-trailers.yml', state: 'active' },
      ],
    }) as Result;

    expect(result.verdict).toBe('ok');
    expect(formatResult(result)).not.toContain('NG');
  });
});
