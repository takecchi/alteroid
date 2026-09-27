import { describe, expect, it } from 'vitest';

import {
  evaluatePrGreen,
  pickLatestRunPerWorkflow,
  // @ts-expect-error -- 素の .mjs（型宣言を持たない build 用スクリプト）を読む
} from './check-pr-green-core.mjs';

/**
 * 14回目の横断レビュー。PR #1761（Issue #1748）の直しが「開く側」へ
 * 倒れる形が無いかを確かめる再現テスト。
 *
 * PR #1761 は `effectiveTimestamp(run)` を導入し、`run_attempt` が2以上
 * （rerun された run）のときだけ `created_at` の代わりに `updated_at` を
 * 世代選びの鍵にする（`scripts/check-pr-green-core.mjs`）。
 *
 * これは「同じ run を rerun した」場合には正しいが、**同じ sha・同じ
 * workflow 名・同じ event を持つ「別の run」同士を比べるときに、
 * 比べる時刻の基準（`created_at` と `updated_at`）が run ごとに違う**
 * という問題を作る。rerun された run の `updated_at` は「rerun が完了
 * した時刻」まで動く（#1748 の実測では22分後）ので、その間に生まれた
 * 別の run（rerun されていない、genuinely 新しい世代）の `created_at`
 * を追い越しうる。
 *
 * ## 具体形
 *
 * - run A（id=500）: 最初に作られた run（`created_at=10:00:00Z`）。
 *   一度 `cancelled` になり、あとから rerun された（`run_attempt=2`、
 *   `updated_at=10:40:00Z` で `success`）。
 * - run B（id=501）: run A の**あと**（`created_at=10:20:00Z`）に
 *   作られた別の run（`run_attempt=1`）。`ci` job が `failure` で終わった
 *   （`updated_at=10:20:30Z`）——これが実際には最新の世代の失敗である。
 *
 * run A の rerun が完了した時刻（10:40:00Z）は run B の `created_at`
 * （10:20:00Z）より後なので、`effectiveTimestamp` で比べると run A が
 * 「最新」に選ばれる。`pickLatestRunPerWorkflow` は同じ
 * `name + event` の鍵につき1本しか残さないので、run B の failure は
 * 評価から完全に消え、`evaluatePrGreen` は `green` を返す——
 * 実際には最新世代の `ci` が failure なのに、である。
 *
 * これは「緑でないものを緑と言う」（開く側）の欠陥で、#1748 が塞いだ
 * 「緑を NG と言う」（閉じる側）とは逆向きである。
 */
describe('PR #1761 の open-side の疑い（rerun の updated_at が別 run の created_at を追い越す）', () => {
  it('古い run を rerun して成功させると、あとから作られた別 run の failure より新しく見えて green になる', () => {
    const rerunnedOldRun = {
      id: 500,
      name: 'CI',
      event: 'pull_request',
      run_attempt: 2,
      created_at: '2026-09-20T10:00:00Z',
      updated_at: '2026-09-20T10:40:00Z',
      status: 'completed',
      conclusion: 'success',
    };
    const genuinelyNewerFailure = {
      id: 501,
      name: 'CI',
      event: 'pull_request',
      run_attempt: 1,
      created_at: '2026-09-20T10:20:00Z',
      updated_at: '2026-09-20T10:20:30Z',
      status: 'completed',
      conclusion: 'failure',
    };

    // 前提: run B（failure）は run A（rerun 前）より後に作られている
    // （created_at で見て、本当に新しい世代である）。
    expect(Date.parse(genuinelyNewerFailure.created_at)).toBeGreaterThan(
      Date.parse(rerunnedOldRun.created_at),
    );

    const latest = pickLatestRunPerWorkflow([rerunnedOldRun, genuinelyNewerFailure]);

    // 選ばれるのは1本だけ（同じ name+event の鍵）。
    expect(latest).toHaveLength(1);

    const jobsByRunId = {
      500: [{ name: 'ci', status: 'completed', conclusion: 'success' }],
      501: [{ name: 'ci', status: 'completed', conclusion: 'failure' }],
    };

    const result = evaluatePrGreen(latest, jobsByRunId);

    // ここが本来の期待（あるべき姿）: 最新世代の failure が見えるので red。
    // 直っていなければ green になり、この assertion が赤くなる。
    expect(result.verdict).not.toBe('green');
  });
});
