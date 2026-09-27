import { describe, expect, it } from 'vitest';

import {
  evaluatePrGreen,
  pickLatestRunPerWorkflow,
  // @ts-expect-error -- 素の .mjs（型宣言を持たない build 用スクリプト）を読む
} from './check-pr-green-core.mjs';

/**
 * 15回目の横断レビュー。PR #1778（Issue #1761 の直し）が、鍵を
 * `updated_at`（完了時刻）から `run_started_at`（実行開始時刻）へ
 * 変えたことで開く側の穴を「塞いだ」と主張しているが、**縮めただけで
 * 塞いではいない**ことを確かめる再現テスト。
 *
 * `effectiveTimestamp` は rerun された run（`run_attempt` が2以上）には
 * `run_started_at` を、それ以外の run には `created_at` を使う
 * （`scripts/check-pr-green-core.mjs`）。これは PR #1778 の doc が言う
 * とおり「rerun の完了を待たない」ので #1761 の具体形（rerun の完了に
 * 22分かかり、その間に生まれた別 run の created_at を追い越す）は防ぐ。
 *
 * しかし **`run_started_at` 自体も、キューで待った分だけ `created_at` から
 * 遅れうる**（GitHub Actions のセルフホスト・共有ランナーが混雑している
 * ときに実在する。`AGENTS.md`「時刻の扱い」と同じ形——器の時計を信じても
 * 待ち行列の長さまでは保証しない）。 ⟹ 「rerun の実行開始」対「別 run の
 * created_at」という比較そのものが、#1761 と同じ形の窓を**縮めて**
 * 持ち越しているだけであり、rerun がキューで長く待たされれば同じ開く側の
 * 穴が別の窓幅で再現する。
 *
 * ## 具体形
 *
 * - run A（id=500、rerun）: 最初に作られたのは `created_at=10:00:00Z`。
 *   1回目の attempt が失敗し、`gh run rerun` された（`run_attempt=2`）。
 *   ランナー混雑でキューに並び、実際に走り始めたのは
 *   `run_started_at=10:35:00Z`（35分待ち）。そこから1分で完了し
 *   `success`（`updated_at=10:36:00Z`）。
 * - run B（id=501、rerun ではない）: run A の rerun が要求された**あと**、
 *   しかし run A の rerun が実際に走り始める**前**（`created_at=10:20:00Z`）
 *   に作られた別の run（`run_attempt=1`）。同じ sha に対する、rerun とは
 *   無関係などこかの再トリガ（draft→ready のレース等、#1748/#1761 と同じ
 *   前提）。`ci` job は `failure` で完了した（`updated_at=10:22:00Z`）——
 *   run A の rerun が走り始めるより前に、run B は既に失敗という結論を
 *   出し切っている。
 *
 * run B は run A の rerun 開始（10:35:00Z）より**前**に作られ、**前**に
 * 完了している（10:22:00Z）。にもかかわらず、鍵が `run_started_at` の
 * ため run A（`10:35:00Z`）が run B の `created_at`（`10:20:00Z`）を
 * 追い越し、`pickLatestRunPerWorkflow` は run A だけを残す。結果
 * `evaluatePrGreen` は run B の `failure` を見ずに `green` を返す——
 * 実際には run B が経ってなお解消していない失敗が在るのに、である。
 *
 * これは #1761 と同じ「緑でないものを緑と言う」（開く側）の欠陥で、
 * PR #1778 は窓を「rerun の完了を待つ間（分〜数十分）」から「rerun が
 * キューで待たされる間（同じく分〜数十分になりうる）」へ**移しただけ**
 * である。
 */
describe('PR #1778 の残存する open-side の疑い（rerun の run_started_at 自体がキュー待ちで遅れる）', () => {
  it('rerun がキューで長く待たされ、別run（失敗）の作成日時を追い越すと green になる', () => {
    const queuedRerun = {
      id: 500,
      name: 'CI',
      event: 'pull_request',
      run_attempt: 2,
      created_at: '2026-09-20T10:00:00Z',
      run_started_at: '2026-09-20T10:35:00Z',
      updated_at: '2026-09-20T10:36:00Z',
      status: 'completed',
      conclusion: 'success',
    };
    const earlierGenuineFailure = {
      id: 501,
      name: 'CI',
      event: 'pull_request',
      run_attempt: 1,
      created_at: '2026-09-20T10:20:00Z',
      updated_at: '2026-09-20T10:22:00Z',
      status: 'completed',
      conclusion: 'failure',
    };

    // 前提: 別 run（failure）は rerun の実行開始よりずっと前に作られ、
    // かつ rerun が走り始めるより前に既に完了している。
    expect(Date.parse(earlierGenuineFailure.created_at)).toBeLessThan(
      Date.parse(queuedRerun.run_started_at),
    );
    expect(Date.parse(earlierGenuineFailure.updated_at)).toBeLessThan(
      Date.parse(queuedRerun.run_started_at),
    );
    // 前提: それでも created_at で見れば、別 run のほうが rerun の
    // 「最初の」created_at より後——つまり rerun より新しい世代の
    // トリガである（#1748/#1761 と同じ前提の形）。
    expect(Date.parse(earlierGenuineFailure.created_at)).toBeGreaterThan(
      Date.parse(queuedRerun.created_at),
    );

    const latest = pickLatestRunPerWorkflow([queuedRerun, earlierGenuineFailure]);

    const jobsByRunId = {
      500: [{ name: 'ci', status: 'completed', conclusion: 'success' }],
      501: [{ name: 'ci', status: 'completed', conclusion: 'failure' }],
    };
    const result = evaluatePrGreen(latest, jobsByRunId);

    // 本来の期待: 別 run の failure は rerun の開始より前に確定して
    // いるのだから、隠されてはならない（green と言ってはならない）。
    // PR #1778 の実装では queuedRerun が「最新」に選ばれてしまい、
    // ここが赤くなる。
    expect(result.verdict).not.toBe('green');
  });
});
