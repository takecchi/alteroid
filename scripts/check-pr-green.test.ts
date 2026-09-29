import { describe, expect, it } from 'vitest';

import {
  evaluatePrGreen,
  filterRunsByEvent,
  formatVerdict,
  isFullCommitSha,
  pickLatestRunPerWorkflow,
  // @ts-expect-error -- 素の .mjs（型宣言を持たない build 用スクリプト）を読む
} from './check-pr-green-core.mjs';

/**
 * `check-pr-green` の歯（Issue #933）。
 *
 * 本物の `gh api` は叩かない —— 合成した応答で判定だけを確かめる
 * （`check-required-status-checks.test.ts` と同じ理由。手元は offline で
 * ありうるし、CI から見た本物の GitHub 状態は時間とともに変わる）。
 *
 * 下の「実測を写した固定値」は、`gh api
 * repos/takecchi/alteroid/commits/1e619f43858160fb5d9a6b1895d236e35d4771cf/check-runs`
 * および `gh api repos/takecchi/alteroid/actions/runs?head_sha=...` /
 * `gh api repos/takecchi/alteroid/actions/runs/<id>/jobs` を実行して得た
 * 本物の応答から必要な欄だけを抜いたものである（観測 2026-09-15、PR #932）。
 */

describe('pickLatestRunPerWorkflow', () => {
  it('#933 の実例: draft世代とready世代が同居しても、created_atで新しいほうを選ぶ', () => {
    // 実測: draft run 34743503505（06:44:48作成、conclusion=skipped）と
    // ready run 34743508004（06:44:54作成、conclusion=success）が同じ sha に同居。
    // check-runs 側の base-overlap は started_at も id も逆転していたが（Issue本文）、
    // actions/runs の created_at は run そのものの作成時刻なので逆転しない。
    const runs = [
      {
        id: 34743503505,
        name: 'CI',
        created_at: '2026-09-13T06:44:48Z',
        status: 'completed',
        conclusion: 'skipped',
      },
      {
        id: 34743508004,
        name: 'CI',
        created_at: '2026-09-13T06:44:54Z',
        status: 'completed',
        conclusion: 'success',
      },
    ];
    const latest = pickLatestRunPerWorkflow(runs);
    expect(latest).toEqual([
      {
        id: 34743508004,
        name: 'CI',
        created_at: '2026-09-13T06:44:54Z',
        status: 'completed',
        conclusion: 'success',
      },
    ]);
  });

  it('created_at が同秒でも、runの id（jobのidではない）で新しいほうを選ぶ', () => {
    const older = {
      id: 100,
      name: 'CI',
      created_at: '2026-09-13T06:44:54Z',
      status: 'completed',
      conclusion: 'skipped',
    };
    const newer = {
      id: 101,
      name: 'CI',
      created_at: '2026-09-13T06:44:54Z',
      status: 'completed',
      conclusion: 'success',
    };
    expect(pickLatestRunPerWorkflow([older, newer])).toEqual([newer]);
    expect(pickLatestRunPerWorkflow([newer, older])).toEqual([newer]);
  });

  it('Issue #1225 の実例: 同じsha に同じ名前の push run と schedule run が同居しても、pushの run を落とさない', () => {
    // 実測: gh api 'repos/takecchi/alteroid/actions/runs?head_sha=3ca63973b7dae66b48b033a962a92e19c7e73e63'
    // sha 3ca63973b7dae66b48b033a962a92e19c7e73e63 に `CI` の run が2本同居した——
    // push の run 34709221407（06:46:25作成、conclusion=failure。ci=failure）と、
    // その2分後にできた schedule の run 34709324541（06:48:26作成、
    // conclusion=success。drift運転でciを丸ごとskip）。旧実装（名前だけで
    // まとめてcreated_atの新しいほうを残す）は schedule の run が push の run を
    // 追い出し、ci=failure が評価から消えて out-of-scope に化けた。
    const runs = [
      {
        id: 34709221407,
        name: 'CI',
        event: 'push',
        created_at: '2026-09-12T17:46:25Z',
        status: 'completed',
        conclusion: 'failure',
      },
      {
        id: 34709324541,
        name: 'CI',
        event: 'schedule',
        created_at: '2026-09-12T17:48:26Z',
        status: 'completed',
        conclusion: 'success',
      },
    ];
    const latest = pickLatestRunPerWorkflow(runs);
    // 名前だけでは1本に潰されず、event が違う2本ともが残る。
    expect(latest.map((r: { id: number }) => r.id).sort((a: number, b: number) => a - b)).toEqual([
      34709221407, 34709324541,
    ]);

    // 実測: gh api repos/takecchi/alteroid/actions/runs/<id>/jobs
    const jobsByRunId = {
      34709221407: [
        { name: 'ci', status: 'completed', conclusion: 'failure' },
        { name: 'pr-origin', status: 'completed', conclusion: 'skipped' },
        { name: 'base-overlap', status: 'completed', conclusion: 'skipped' },
      ],
      34709324541: [
        { name: 'ci', status: 'completed', conclusion: 'skipped' },
        { name: 'pr-origin', status: 'completed', conclusion: 'skipped' },
        { name: 'base-overlap', status: 'completed', conclusion: 'skipped' },
      ],
    };
    const result = evaluatePrGreen(latest, jobsByRunId);
    expect(result.verdict).toBe('red');
    expect(
      result.detail.some(
        (line: string) =>
          line.includes('ci') && line.includes('failure') && line.includes('34709221407'),
      ),
    ).toBe(true);
  });

  it('別workflowの実例（Issue #933コメント、virchamate PR #564）: 複数workflowを両方とも残す', () => {
    // 実測: 同じsha に `Test Backend`（走行中）と `Guardrail Check`（success、
    // 1ジョブだけ）という別workflowの run が同居。「run を1本だけ選ぶ」直し方は
    // Guardrail Check を選んで Test Backend を丸ごと落とす（Issueコメントの実測）。
    // workflow名ごとに選べば両方が latestRuns に残り、Test Backend の未完了が
    // pending として拾える。
    const runs = [
      {
        id: 34744307932,
        name: 'Test Backend',
        created_at: '2026-09-13T07:04:06Z',
        status: 'in_progress',
        conclusion: null,
      },
      {
        id: 34744308153,
        name: 'Guardrail Check',
        created_at: '2026-09-13T07:04:07Z',
        status: 'completed',
        conclusion: 'success',
      },
    ];
    const latest = pickLatestRunPerWorkflow(runs);
    expect(latest.map((r: { name: string }) => r.name)).toEqual([
      'Guardrail Check',
      'Test Backend',
    ]);
    const testBackend = latest.find((r: { name: string }) => r.name === 'Test Backend');
    expect(testBackend?.status).toBe('in_progress');
  });

  it('#933 コメントの追加実測（PR #997、sha 5de558f6b2ca5e89ed2efac7b8d677f56cabb879）: jobの completed_at が started_at より前でも、run自身の created_at で新しいほうを選ぶ', () => {
    // 実測（観測 2026-09-15T04:40Z、UTC）: draft世代 run 34929697970 の `image`
    // job は started_at=04:40:04 completed_at=04:39:57（completed_at が7秒
    // "前"）という、started_at 単独の逆転（Issue本文）とは別の壊れ方をしていた。
    // 「started_at が駄目なら completed_at を使う」という代替案も、この実測で
    // 塞がれている —— job 側のどちらの時刻も世代の順序を決める根拠にならない。
    // この道具はそもそも job の started_at/completed_at を一度も読まない
    // （下の jobsByRunId は conclusion/status しか持たない）ので、この異常は
    // pickLatestRunPerWorkflow にも evaluatePrGreen にも一切入力されない。
    const runs = [
      {
        id: 34929697970,
        name: 'CI',
        created_at: '2026-09-15T04:39:56Z',
        status: 'completed',
        conclusion: 'skipped',
      },
      {
        id: 34929744708,
        name: 'CI',
        created_at: '2026-09-15T04:40:39Z',
        status: 'completed',
        conclusion: 'success',
      },
    ];
    const latest = pickLatestRunPerWorkflow(runs);
    expect(latest).toEqual([
      {
        id: 34929744708,
        name: 'CI',
        created_at: '2026-09-15T04:40:39Z',
        status: 'completed',
        conclusion: 'success',
      },
    ]);

    // 実測: gh api repos/takecchi/alteroid/actions/runs/34929744708/jobs
    // （新しい世代のjobsのみ。古い世代の image の completed_at<started_at は
    // ここには一切現れない —— pickLatestRunPerWorkflow の時点で run ごと
    // 落ちているため）
    const jobsByRunId = {
      34929744708: [
        { name: 'ci', status: 'completed', conclusion: 'success' },
        { name: 'base-overlap', status: 'completed', conclusion: 'success' },
        { name: 'image', status: 'completed', conclusion: 'success' },
      ],
    };
    const result = evaluatePrGreen(latest, jobsByRunId);
    expect(result.verdict).toBe('green');
  });

  it('Issue #1748 の実例: rerun が絡み結論も食い違うので、15回目の横断レビュー以降は「判定できない」（undecidable-rerun-conflict）と言う（反転）', () => {
    // ⚠️ **15回目の横断レビューでこの it() は反転した。** 以前はここで
    // 「run_started_at を鍵にすれば success（rerunSuccess）を正しく選び、
    // green になる」ことを確かめていた。しかし15回目の横断レビューで、
    // 時刻（created_at / updated_at / run_started_at のどれでも）を比べて
    // 世代を選ぶ形そのものに開く側の穴が見つかり（キューで長く待たされた
    // rerun が、別の run の created_at を追い越す。
    // `scripts/check-pr-green-1778-queued-rerun-open-side.repro.test.ts`）、
    // 方針を「rerun が絡み、かつ結論（conclusion）が食い違うときは、時刻を
    // 比べずに『判定できない』を返す」へ変えた（`pickLatestRunPerWorkflow`
    // の `hasRerunConflict` の doc）。**この標本は draftOriginSkip
    // （conclusion=skipped）と rerunSuccess（conclusion=success）で結論が
    // 食い違うので、新しい方針では `undecidable-rerun-conflict` になる。**
    // これは「緑でないのに green と言う」開く側の欠陥ではなく、「本当は
    // green と確定できるのに判定できないと言う」閉じる側の後退だが、
    // #1761 のときと同じ非対称（開く側より閉じる側に倒れるほうを選ぶ）を
    // 踏襲した結果として、意図して受け入れている（PR 本文の3点セットを
    // 見よ）。下の実測コメント自体は書き換えていない——何が起きたかの
    // 記録として、そのまま残す。
    //
    // 実測（観測 2026-09-27、sha 031bf92f62e61fc16eee3570a72c7c87ff6b2d7f）:
    // push 直後に `gh pr ready` を打ったところ、concurrency
    // （cancel-in-progress: true）が競り合い、`CI` の run が2本できた。
    //
    // gh api "repos/takecchi/alteroid/actions/runs?head_sha=031bf92f62e61fc16eee3570a72c7c87ff6b2d7f&per_page=100"
    //   --jq '.workflow_runs[] | select(.name=="CI")'
    //
    // run 36286928087（run_attempt=1、created_at=01:54:11Z、conclusion=skipped。
    // draft と評価された扱いのまま残った）と、run 36286927781（attempt 1 は
    // created_at=01:54:10Z——36286928087 より1秒早い——で cancelled。
    // `gh run rerun` した attempt 2 は success、run_started_at=02:02:08Z
    // （attempt 2 が実際に走り始めた時刻）、updated_at=02:16:15Z（完了時刻。
    // #1761 で鍵からは外した——完了を待たない run_started_at のほうを使う）。
    // rerun しても run 自身の created_at（01:54:10Z）は動かない。
    const draftOriginSkip = {
      id: 36286928087,
      name: 'CI',
      event: 'pull_request',
      run_attempt: 1,
      created_at: '2026-09-27T01:54:11Z',
      updated_at: '2026-09-27T01:54:22Z',
      status: 'completed',
      conclusion: 'skipped',
    };
    const rerunSuccess = {
      id: 36286927781,
      name: 'CI',
      event: 'pull_request',
      run_attempt: 2,
      created_at: '2026-09-27T01:54:10Z',
      run_started_at: '2026-09-27T02:02:08Z',
      updated_at: '2026-09-27T02:16:15Z',
      status: 'completed',
      conclusion: 'success',
    };

    // created_at だけを比べると draftOriginSkip（01:54:11Z）が rerunSuccess
    // （created_at は動かず 01:54:10Z のまま）より新しく見える —— これが
    // 直す前の NG の原因だった。
    expect(Date.parse(draftOriginSkip.created_at)).toBeGreaterThan(
      Date.parse(rerunSuccess.created_at),
    );
    // run_started_at（02:02:08Z）も draftOriginSkip の created_at
    // （01:54:11Z）より後なので、#1761 で updated_at から run_started_at
    // に鍵を変えても #1748 の実データは green のまま —— 実データで確認済み
    // （gh api repos/takecchi/alteroid/actions/runs/36286927781/attempts/2）。
    expect(Date.parse(rerunSuccess.run_started_at)).toBeGreaterThan(
      Date.parse(draftOriginSkip.created_at),
    );

    // 反転後: rerun（run_attempt=2）が絡み、conclusion が skipped と
    // success で食い違うので、時刻では選ばず「判定できない」の目印
    // （rerunConflict）へ畳む——どちらの run の id も選ばれない
    // （`id: null`）。
    const latest = pickLatestRunPerWorkflow([draftOriginSkip, rerunSuccess]);
    expect(latest).toHaveLength(1);
    expect(latest[0].id).toBeNull();
    expect(latest[0].rerunConflict).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: draftOriginSkip.id, conclusion: 'skipped' }),
        expect.objectContaining({ id: rerunSuccess.id, conclusion: 'success' }),
      ]),
    );
    // 渡す順序を変えても同じ結果になること（対称のはず）。
    expect(pickLatestRunPerWorkflow([rerunSuccess, draftOriginSkip])).toEqual(latest);

    // 実測: gh api repos/takecchi/alteroid/actions/runs/36286927781/attempts/2/jobs
    // ⚠️ この jobsByRunId はもう使われない——`rerunConflict` を持つ latest の
    // 要素は `id: null` なので、evaluatePrGreen は jobsByRunId を見る前に
    // undecidable-rerun-conflict を返す（下の assertion）。実測コメントは
    // 「本来ならこの run の jobs は全部 success だった」という記録として残す。
    const jobsByRunId = {
      36286927781: [
        { name: 'ci', status: 'completed', conclusion: 'success' },
        { name: 'image', status: 'completed', conclusion: 'success' },
      ],
    };
    const result = evaluatePrGreen(latest, jobsByRunId);
    expect(result.verdict).toBe('undecidable-rerun-conflict');
    // 「判定できない」の detail は、何を見れば決められるかを言う
    // （gh pr view --json mergeStateStatus と、各 run の id/attempt/結論）。
    expect(result.detail.some((line: string) => line.includes('mergeStateStatus'))).toBe(true);
    expect(result.detail.some((line: string) => line.includes(String(draftOriginSkip.id)))).toBe(
      true,
    );
    expect(result.detail.some((line: string) => line.includes(String(rerunSuccess.id)))).toBe(true);
  });

  it('Issue #1748 の変異ガード: run_attempt を無視して常に created_at で選ぶと、#1748 の標本は再び skipped（NG）に戻る', () => {
    // effectiveTimestamp の run_attempt 分岐を外す変異と同じ効果を、
    // このテスト自身の中で再現する——`newerRun` を直接は呼べないので、
    // 「rerun を無視した素朴な created_at 比較」を関数として書き下し、
    // 直した実装と挙動が違うことを確かめる（回帰の形を歯に残す）。
    const draftOriginSkip = {
      id: 36286928087,
      name: 'CI',
      created_at: '2026-09-27T01:54:11Z',
      conclusion: 'skipped',
    };
    const rerunSuccess = {
      id: 36286927781,
      name: 'CI',
      created_at: '2026-09-27T01:54:10Z',
      conclusion: 'success',
    };
    const naiveNewerByCreatedAtOnly = (a: typeof draftOriginSkip, b: typeof rerunSuccess) => {
      const ta = Date.parse(a.created_at);
      const tb = Date.parse(b.created_at);
      if (ta !== tb) return ta > tb ? a : b;
      return a.id > b.id ? a : b;
    };
    // 直す前の判定（created_at だけ）は skipped を選ぶ —— これが #1748 の NG。
    expect(naiveNewerByCreatedAtOnly(draftOriginSkip, rerunSuccess)).toEqual(draftOriginSkip);
    // 直した後（#1748 当時）の pickLatestRunPerWorkflow は同じ標本で success
    // を選んでいた。**15回目の横断レビュー以降は違う**——run_attempt を
    // 足した完全な標本（直上のテスト）は、結論（skipped/success）が食い違う
    // ので `undecidable-rerun-conflict`（判定できない）になる。ここで確かめ
    // ているのは「rerun を無視した素朴な created_at 比較が skipped を選ぶ」
    // という #1748 当時の回帰の形だけで、それ自体は変わっていない。
  });

  it('Issue #1761 の open-side の疑い（14回目の横断レビュー、wip/review14-s5 の再現テスト由来）: rerun の run_started_at が、別の genuinely 新しい run の created_at より前なら、その別 run の failure を隠さない', () => {
    // #1748 の直し（updated_at を鍵にする）は、rerun の「完了」時刻を鍵に
    // 使っていた。rerun に時間がかかると、rerun が実行中のあいだに生まれた
    // 別の genuinely 新しい run（本当に新しい世代の failure）の created_at
    // を updated_at（完了時刻）が追い越し、その failure を評価から消して
    // green と言ってしまう —— これが開く側の穴（#1761）。
    //
    // ここでは rerun の実行開始（run_started_at）が、別 run の created_at
    // より「前」のケースを固定する:
    //   - rerunnedOldRun: run_started_at=10:05:00Z に実行を始め、
    //     updated_at=10:40:00Z（35分後）に success で完了した。
    //   - genuinelyNewerFailure: created_at=10:20:00Z —— rerun の実行中
    //     （開始10:05 と完了10:40 のあいだ）に作られ、failure で終わった。
    // rerun の開始（10:05）は genuinelyNewerFailure の created_at（10:20）
    // より前なので、run_started_at を鍵にすれば genuinelyNewerFailure が
    // 正しく「新しい」と判定され、failure が評価に残る（green と言わない）。
    const rerunnedOldRun = {
      id: 500,
      name: 'CI',
      event: 'pull_request',
      run_attempt: 2,
      created_at: '2026-09-20T10:00:00Z',
      run_started_at: '2026-09-20T10:05:00Z',
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

    // 前提: rerun の実行開始は、別 run（failure）の created_at より前。
    expect(Date.parse(rerunnedOldRun.run_started_at)).toBeLessThan(
      Date.parse(genuinelyNewerFailure.created_at),
    );
    // 前提: updated_at（完了時刻）だけを鍵にすると、この前提が逆転する
    // （#1748 の直しのままだと、これが開く側の穴を生んでいた）。
    expect(Date.parse(rerunnedOldRun.updated_at)).toBeGreaterThan(
      Date.parse(genuinelyNewerFailure.created_at),
    );

    // ⚠️ 15回目の横断レビューで、この中間 assertion は反転した。以前は
    // 「run_started_at を鍵にすれば genuinelyNewerFailure（failure）が
    // 正しく選ばれる」ことを確かめていた——それ自体は正しかったが、時刻を
    // 比べて選ぶという方法そのものに開く側の穴が残っていた（rerun が
    // キューでさらに長く待たされる標本。
    // `scripts/check-pr-green-1778-queued-rerun-open-side.repro.test.ts`）。
    // いまは rerun（run_attempt=2）が絡み conclusion が success/failure で
    // 食い違うので、時刻では選ばず「判定できない」の目印へ畳む。
    const latest = pickLatestRunPerWorkflow([rerunnedOldRun, genuinelyNewerFailure]);
    expect(latest).toHaveLength(1);
    expect(latest[0].id).toBeNull();
    expect(latest[0].rerunConflict).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: rerunnedOldRun.id, conclusion: 'success' }),
        expect.objectContaining({ id: genuinelyNewerFailure.id, conclusion: 'failure' }),
      ]),
    );

    const jobsByRunId = {
      500: [{ name: 'ci', status: 'completed', conclusion: 'success' }],
      501: [{ name: 'ci', status: 'completed', conclusion: 'failure' }],
    };
    const result = evaluatePrGreen(latest, jobsByRunId);
    // この行自体は反転していない —— 直っていれば「本当は failure が
    // 隠れているのに green と言う」ことはない、という結論は変わらない。
    // 変わったのは「red になる」から「undecidable-rerun-conflict になる」
    // へ、not green の中身のほうである（下で明示する）。
    expect(result.verdict).not.toBe('green');
    expect(result.verdict).toBe('undecidable-rerun-conflict');
  });

  it('鏡像: rerun の run_started_at が、別の run の created_at より後でも、conclusion が食い違うなら15回目の横断レビュー以降は判定できない（反転）', () => {
    // ⚠️ **15回目の横断レビューでこの it() は反転した。** 以前はここで
    // 「rerun の実行開始が別 run の created_at より後なら、別 run は rerun
    // が始まる前に既に存在して完了していたことになる —— rerun はそのあとに
    // 手で起こされた、本当に新しい世代なので green と言ってよい」ことを
    // 確かめていた（#1748 の実データ、sha 031bf92 と同じ向き）。
    //
    // しかし15回目の横断レビューで、「rerun の実行開始と別 run の
    // created_at の前後関係」だけを見て世代を選ぶ形そのものに開く側の穴が
    // 見つかった（run_started_at 自身がキューで長く待たされれば、この
    // 前提が成り立っていても実際には別の run のほうが後から確定した
    // 失敗でありうる。
    // `scripts/check-pr-green-1778-queued-rerun-open-side.repro.test.ts`）。
    // ⟹ rerun が絡み conclusion が食い違う場合は、この前後関係を見ずに
    // 「判定できない」を返す方針へ変えた——**この標本のように「本来なら
    // rerun 側が正しい」場合も例外にしない**（例外にすると、時刻を比べる
    // 経路がまた復活してしまう）。直上のテストと対になる形は保つ。
    const otherRun = {
      id: 501,
      name: 'CI',
      event: 'pull_request',
      run_attempt: 1,
      created_at: '2026-09-20T10:20:00Z',
      updated_at: '2026-09-20T10:20:30Z',
      status: 'completed',
      conclusion: 'failure',
    };
    const rerunnedNewerRun = {
      id: 500,
      name: 'CI',
      event: 'pull_request',
      run_attempt: 2,
      created_at: '2026-09-20T10:00:00Z',
      run_started_at: '2026-09-20T10:25:00Z',
      updated_at: '2026-09-20T10:40:00Z',
      status: 'completed',
      conclusion: 'success',
    };

    // 前提: rerun の実行開始は、別 run（failure）の created_at より後。
    expect(Date.parse(rerunnedNewerRun.run_started_at)).toBeGreaterThan(
      Date.parse(otherRun.created_at),
    );

    const latest = pickLatestRunPerWorkflow([otherRun, rerunnedNewerRun]);
    // 反転後: conclusion が failure と success で食い違うので、rerun の
    // 実行開始が後であっても時刻では選ばず「判定できない」の目印へ畳む。
    expect(latest).toHaveLength(1);
    expect(latest[0].id).toBeNull();
    expect(latest[0].rerunConflict).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: otherRun.id, conclusion: 'failure' }),
        expect.objectContaining({ id: rerunnedNewerRun.id, conclusion: 'success' }),
      ]),
    );

    const jobsByRunId = {
      500: [{ name: 'ci', status: 'completed', conclusion: 'success' }],
      501: [{ name: 'ci', status: 'completed', conclusion: 'failure' }],
    };
    const result = evaluatePrGreen(latest, jobsByRunId);
    // 反転後: rerun の実行開始が後であっても、conclusion が食い違う以上は
    // green と言い切らない。
    expect(result.verdict).toBe('undecidable-rerun-conflict');
  });

  it('PR #1801 レビュー: rerun が絡む鍵に未完了の run が混じると、時刻では選ばず pending になる（green ではない）', () => {
    // `hasRerunConflict` は `sameKeyRuns.every(status === 'completed')` を
    // 前提に発火する。全部完了していなければ発火せず、`newerRun` /
    // `effectiveTimestamp` による時刻の比較へフォールバックしていた——
    // ここにも開く側の穴が残っていた（PR #1801 のレビューコメント）。
    //
    // - run A: rerun（run_attempt=2）がキューで長く待たされた
    //   （run_started_at=10:35:00Z）あと success で完了した。
    // - run B: A の再実行を頼んだあとに作られた、本当に新しい世代の run
    //   （run_attempt=1、created_at=10:20:00Z）。まだ in_progress——あとで
    //   failure になる予定だが、結論はまだ確定していない。
    //
    // 直す前: effectiveTimestamp(A)=run_started_at(10:35:00Z) が
    // effectiveTimestamp(B)=created_at(10:20:00Z) より後なので、newerRun は
    // A を選ぶ。B（まだ結論が出ていない）はまるごと捨てられ、
    // evaluatePrGreen([A], ...) は A の jobs がすべて success なので green を
    // 返してしまう——B がまだ走っているのに、である。
    const rerunnedQueuedRun = {
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
    const stillRunningNewerRun = {
      id: 502,
      name: 'CI',
      event: 'pull_request',
      run_attempt: 1,
      created_at: '2026-09-20T10:20:00Z',
      status: 'in_progress',
      conclusion: null,
    };

    // 前提: 直す前なら A が「新しい」と選ばれてしまう関係にあること。
    expect(Date.parse(rerunnedQueuedRun.run_started_at)).toBeGreaterThan(
      Date.parse(stillRunningNewerRun.created_at),
    );

    const latest = pickLatestRunPerWorkflow([rerunnedQueuedRun, stillRunningNewerRun]);
    // 時刻では選ばず、未完了の run（B）だけを残す——完了済みの A はこの回の
    // 判定には使わない。
    expect(latest).toHaveLength(1);
    expect(latest[0].id).toBe(stillRunningNewerRun.id);
    expect(latest[0].status).toBe('in_progress');

    const jobsByRunId = {
      500: [
        { name: 'ci', status: 'completed', conclusion: 'success' },
        { name: 'image', status: 'completed', conclusion: 'success' },
      ],
    };
    const result = evaluatePrGreen(latest, jobsByRunId);
    // B がまだ走っているので green ではなく pending —— 既存の pending の
    // 意味（待てば決まる）にそのまま乗る。undecidable-rerun-conflict では
    // ない——結論がまだ確定していないので「食い違い」とは呼べない。
    expect(result.verdict).toBe('pending');
    expect(result.verdict).not.toBe('green');
  });

  describe('Issue #2209: ジョブが1本も走っていない run を、rerun の食い違い判定より前に外す', () => {
    // teto が世代の決め方を領域 E に委ね、E が線を引いた（#2209）——同じ鍵
    // （name+event）に「ジョブが走って完了した run」が1本以上あるときだけ、
    // 「ジョブが1本も走っていない run」（jobs 全件が skipped）を比較から
    // 外す。判定は run.conclusion ではなく jobs 全件で見る。

    it('(a) Issue #2175 の実データ: draft 由来のジョブ0本 run を外すと green になる（実測 2026-09-29、sha 1e28808e5b6f2d1d0b2c39d6122ab0ab2cd61dbb）', () => {
      // 実測: gh api "repos/takecchi/alteroid/actions/runs?head_sha=1e28808e5b6f2d1d0b2c39d6122ab0ab2cd61dbb"
      // run 36563936180（run_attempt=1。draft のとき、image/ci とも skipped。
      // ci.yml は draft の pull_request では回さない）と、run 36564163120
      // （run_attempt=2。gh run rerun --failed 後、image/ci とも success）が
      // 同じ head sha・同じ name=CI・同じ event=pull_request に同居した。
      // 直す前はここで hasRerunConflict が「rerun が絡み結論が skipped と
      // success で食い違う」と判定し、undecidable-rerun-conflict になって
      // いた（#2209 本文）。
      const draftSkipped = {
        id: 36563936180,
        name: 'CI',
        event: 'pull_request',
        run_attempt: 1,
        created_at: '2026-09-29T05:57:00Z',
        status: 'completed',
        conclusion: 'skipped',
      };
      const rerunSuccess = {
        id: 36564163120,
        name: 'CI',
        event: 'pull_request',
        run_attempt: 2,
        created_at: '2026-09-29T05:40:00Z',
        run_started_at: '2026-09-29T06:10:00Z',
        status: 'completed',
        conclusion: 'success',
      };
      // 実測: gh api repos/takecchi/alteroid/actions/runs/<id>/jobs
      const jobsByRunId = {
        36563936180: [
          { name: 'image', status: 'completed', conclusion: 'skipped' },
          { name: 'ci', status: 'completed', conclusion: 'skipped' },
        ],
        36564163120: [
          { name: 'image', status: 'completed', conclusion: 'success' },
          { name: 'ci', status: 'completed', conclusion: 'success' },
        ],
      };

      const latest = pickLatestRunPerWorkflow([draftSkipped, rerunSuccess], jobsByRunId);
      // ジョブが1本も走っていない draftSkipped が外れ、rerunSuccess の1本
      // だけが残る——hasRerunConflict は2本未満で発火しない。
      expect(latest).toEqual([rerunSuccess]);

      const result = evaluatePrGreen(latest, jobsByRunId);
      expect(result.verdict).toBe('green');
    });

    it('(b) draft 由来の skip を外しても、走った run が failure なら red のまま', () => {
      const draftSkipped = {
        id: 1,
        name: 'CI',
        event: 'pull_request',
        run_attempt: 1,
        created_at: '2026-09-29T00:00:00Z',
        status: 'completed',
        conclusion: 'skipped',
      };
      const readyFailure = {
        id: 2,
        name: 'CI',
        event: 'pull_request',
        run_attempt: 1,
        created_at: '2026-09-29T00:10:00Z',
        status: 'completed',
        conclusion: 'failure',
      };
      const jobsByRunId = {
        1: [
          { name: 'image', status: 'completed', conclusion: 'skipped' },
          { name: 'ci', status: 'completed', conclusion: 'skipped' },
        ],
        2: [
          { name: 'image', status: 'completed', conclusion: 'success' },
          { name: 'ci', status: 'completed', conclusion: 'failure' },
        ],
      };
      const latest = pickLatestRunPerWorkflow([draftSkipped, readyFailure], jobsByRunId);
      expect(latest).toEqual([readyFailure]);
      const result = evaluatePrGreen(latest, jobsByRunId);
      expect(result.verdict).toBe('red');
    });

    it('(c) draft 由来の skip を外しても、走った run 同士が食い違えば undecidable-rerun-conflict のまま', () => {
      // draftSkipped（ジョブ0本）に加え、genuineFailure（rerun されていない
      // attempt1 の failure）と rerunSuccess（rerun された attempt2 の
      // success）が同居する——除外の対象は draftSkipped だけで、走った run
      // 同士の食い違いはそのまま残る。
      const draftSkipped = {
        id: 1,
        name: 'CI',
        event: 'pull_request',
        run_attempt: 1,
        created_at: '2026-09-29T00:00:00Z',
        status: 'completed',
        conclusion: 'skipped',
      };
      const genuineFailure = {
        id: 2,
        name: 'CI',
        event: 'pull_request',
        run_attempt: 1,
        created_at: '2026-09-29T00:05:00Z',
        status: 'completed',
        conclusion: 'failure',
      };
      const rerunSuccess = {
        id: 3,
        name: 'CI',
        event: 'pull_request',
        run_attempt: 2,
        created_at: '2026-09-29T00:02:00Z',
        run_started_at: '2026-09-29T00:20:00Z',
        status: 'completed',
        conclusion: 'success',
      };
      const jobsByRunId = {
        1: [{ name: 'ci', status: 'completed', conclusion: 'skipped' }],
        2: [{ name: 'ci', status: 'completed', conclusion: 'failure' }],
        3: [{ name: 'ci', status: 'completed', conclusion: 'success' }],
      };
      const latest = pickLatestRunPerWorkflow(
        [draftSkipped, genuineFailure, rerunSuccess],
        jobsByRunId,
      );
      expect(latest).toHaveLength(1);
      expect(latest[0].id).toBeNull();
      expect(latest[0].rerunConflict).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: genuineFailure.id, conclusion: 'failure' }),
          expect.objectContaining({ id: rerunSuccess.id, conclusion: 'success' }),
        ]),
      );
      // draftSkipped（ジョブが1本も走っていない）は外れているので
      // rerunConflict には現れない。
      expect(latest[0].rerunConflict.some((x: { id: number }) => x.id === draftSkipped.id)).toBe(
        false,
      );

      const result = evaluatePrGreen(latest, jobsByRunId);
      expect(result.verdict).toBe('undecidable-rerun-conflict');
    });

    it('(d) 鍵の全部がジョブの走っていない run なら、今までどおり時刻で選ぶ（除外は起きない）', () => {
      const olderAllSkipped = {
        id: 1,
        name: 'CI',
        event: 'schedule',
        run_attempt: 1,
        created_at: '2026-09-29T00:00:00Z',
        status: 'completed',
        conclusion: 'skipped',
      };
      const newerAllSkipped = {
        id: 2,
        name: 'CI',
        event: 'schedule',
        run_attempt: 1,
        created_at: '2026-09-29T00:10:00Z',
        status: 'completed',
        conclusion: 'skipped',
      };
      const jobsByRunId = {
        1: [{ name: 'ci', status: 'completed', conclusion: 'skipped' }],
        2: [{ name: 'ci', status: 'completed', conclusion: 'skipped' }],
      };
      // 除外の有無で結果が変わらないことも確かめる——鍵に「ジョブが走って
      // 完了した run」が1本も無いので、jobsByRunId を渡しても渡さなくても
      // 同じ（今までどおり newerRun の時刻比較で newerAllSkipped を選ぶ）。
      const withJobs = pickLatestRunPerWorkflow([olderAllSkipped, newerAllSkipped], jobsByRunId);
      const withoutJobs = pickLatestRunPerWorkflow([olderAllSkipped, newerAllSkipped]);
      expect(withJobs).toEqual([newerAllSkipped]);
      expect(withoutJobs).toEqual([newerAllSkipped]);
    });

    it('(e) jobs が取れなかった（jobsByRunId に無い）run は外さない —— 開く側へ倒れない', () => {
      const unknownJobsRun = {
        id: 1,
        name: 'CI',
        event: 'pull_request',
        run_attempt: 1,
        created_at: '2026-09-29T00:00:00Z',
        status: 'completed',
        conclusion: 'skipped',
      };
      const rerunSuccess = {
        id: 2,
        name: 'CI',
        event: 'pull_request',
        run_attempt: 2,
        created_at: '2026-09-29T00:05:00Z',
        run_started_at: '2026-09-29T00:20:00Z',
        status: 'completed',
        conclusion: 'success',
      };
      // unknownJobsRun（id:1）の jobs はこの jobsByRunId に無い——「取れ
      // なかった」を模している。
      const jobsByRunId = {
        2: [{ name: 'ci', status: 'completed', conclusion: 'success' }],
      };
      const latest = pickLatestRunPerWorkflow([unknownJobsRun, rerunSuccess], jobsByRunId);
      // jobs 不明の run を「全部 skipped」と決めつけて外すと、rerun が絡み
      // conclusion が食い違う（skipped vs success）ケースが green に化ける
      // ——開く側の穴になる。外さないので、食い違いのままになる。
      expect(latest).toHaveLength(1);
      expect(latest[0].id).toBeNull();
      expect(latest[0].rerunConflict).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: unknownJobsRun.id, conclusion: 'skipped' }),
          expect.objectContaining({ id: rerunSuccess.id, conclusion: 'success' }),
        ]),
      );
    });

    it('(f) jobs の一部だけが skipped の run（一部は走った）は外さない', () => {
      const partiallySkipped = {
        id: 1,
        name: 'CI',
        event: 'pull_request',
        run_attempt: 1,
        created_at: '2026-09-29T00:00:00Z',
        status: 'completed',
        conclusion: 'failure',
      };
      const rerunSuccess = {
        id: 2,
        name: 'CI',
        event: 'pull_request',
        run_attempt: 2,
        created_at: '2026-09-29T00:05:00Z',
        run_started_at: '2026-09-29T00:20:00Z',
        status: 'completed',
        conclusion: 'success',
      };
      const jobsByRunId = {
        1: [
          { name: 'image', status: 'completed', conclusion: 'skipped' },
          { name: 'ci', status: 'completed', conclusion: 'failure' },
        ],
        2: [
          { name: 'image', status: 'completed', conclusion: 'success' },
          { name: 'ci', status: 'completed', conclusion: 'success' },
        ],
      };
      const latest = pickLatestRunPerWorkflow([partiallySkipped, rerunSuccess], jobsByRunId);
      // partiallySkipped は「ジョブが1本も走っていない」わけではない（ci
      // は failure で実際に走った）ので外れない——rerun が絡み結論が
      // 食い違うままなので undecidable-rerun-conflict になる。
      expect(latest).toHaveLength(1);
      expect(latest[0].id).toBeNull();
      expect(latest[0].rerunConflict).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: partiallySkipped.id, conclusion: 'failure' }),
          expect.objectContaining({ id: rerunSuccess.id, conclusion: 'success' }),
        ]),
      );
    });
  });
});

describe('evaluatePrGreen', () => {
  const latestRuns = [
    {
      id: 34743508004,
      name: 'CI',
      created_at: '2026-09-13T06:44:54Z',
      status: 'completed',
      conclusion: 'success',
    },
  ];

  it('#933 の実例がそのまま green になる（4ジョブ、base-overlap を含めすべて success）', () => {
    // 実測: gh api repos/takecchi/alteroid/actions/runs/34743508004/jobs
    const jobsByRunId = {
      34743508004: [
        { name: 'image', status: 'completed', conclusion: 'success' },
        { name: 'base-overlap', status: 'completed', conclusion: 'success' },
        { name: 'ci', status: 'completed', conclusion: 'success' },
        { name: 'pr-origin', status: 'completed', conclusion: 'success' },
      ],
    };
    const result = evaluatePrGreen(latestRuns, jobsByRunId);
    expect(result.verdict).toBe('green');
    expect(result.detail.some((line: string) => line.includes('base-overlap'))).toBe(true);
  });

  it('run が1つも無い sha は no-runs（緑ではない）', () => {
    expect(evaluatePrGreen([], {}).verdict).toBe('no-runs');
  });

  it('最新runがまだ completed でなければ pending', () => {
    const running = [
      {
        id: 1,
        name: 'CI',
        created_at: '2026-09-15T00:00:00Z',
        status: 'in_progress',
        conclusion: null,
      },
    ];
    const result = evaluatePrGreen(running, {});
    expect(result.verdict).toBe('pending');
  });

  it('jobsが0件のrunは unmeasurable（AGENTS.mdの「ジョブ0本のrunは何も言っていない」と同じ扱い）', () => {
    const result = evaluatePrGreen(latestRuns, { 34743508004: [] });
    expect(result.verdict).toBe('unmeasurable');
  });

  it('success以外のjobが1つでもあれば red', () => {
    const jobsByRunId = {
      34743508004: [
        { name: 'image', status: 'completed', conclusion: 'success' },
        { name: 'ci', status: 'completed', conclusion: 'failure' },
      ],
    };
    const result = evaluatePrGreen(latestRuns, jobsByRunId);
    expect(result.verdict).toBe('red');
    expect(
      result.detail.some((line: string) => line.includes('ci') && line.includes('failure')),
    ).toBe(true);
  });

  it('Issue #1197 の再現: pushのrun（マージ直後のmain）で ci=success/image=success/base-overlap=skipped は out-of-scope（NGではない）', () => {
    // 実測を模した合成標本: PR #1193 マージ後の main（939e775）で
    // pnpm check:pr-green を打つと、base-overlap（pull_request 専用）が
    // skipped のまま残り、従来の判定は NG（red）に丸めていた。
    const runs = [
      {
        id: 1,
        name: 'CI',
        event: 'push',
        created_at: '2026-09-17T12:00:00Z',
        status: 'completed',
        conclusion: 'success',
      },
    ];
    const latest = pickLatestRunPerWorkflow(runs);
    const jobsByRunId = {
      1: [
        { name: 'ci', status: 'completed', conclusion: 'success' },
        { name: 'image', status: 'completed', conclusion: 'success' },
        { name: 'base-overlap', status: 'completed', conclusion: 'skipped' },
      ],
    };
    const result = evaluatePrGreen(latest, jobsByRunId);
    expect(result.verdict).toBe('out-of-scope');
    expect(result.detail.some((line: string) => line.includes('base-overlap'))).toBe(true);
  });

  it('out-of-scopeの標本にciのfailureが混じると red になる（out-of-scopeが赤を隠さない）', () => {
    const runs = [
      {
        id: 1,
        name: 'CI',
        event: 'push',
        created_at: '2026-09-17T12:00:00Z',
        status: 'completed',
        conclusion: 'failure',
      },
    ];
    const latest = pickLatestRunPerWorkflow(runs);
    const jobsByRunId = {
      1: [
        { name: 'ci', status: 'completed', conclusion: 'failure' },
        { name: 'image', status: 'completed', conclusion: 'success' },
        { name: 'base-overlap', status: 'completed', conclusion: 'skipped' },
      ],
    };
    const result = evaluatePrGreen(latest, jobsByRunId);
    expect(result.verdict).toBe('red');
  });

  it('pull_requestのrunで ci=skipped は skipped（draftのtrap。緑にもout-of-scopeにもしない）', () => {
    const runs = [
      {
        id: 1,
        name: 'CI',
        event: 'pull_request',
        created_at: '2026-09-17T12:00:00Z',
        status: 'completed',
        conclusion: 'skipped',
      },
    ];
    const latest = pickLatestRunPerWorkflow(runs);
    const jobsByRunId = {
      1: [
        { name: 'ci', status: 'completed', conclusion: 'skipped' },
        { name: 'image', status: 'completed', conclusion: 'skipped' },
        { name: 'base-overlap', status: 'completed', conclusion: 'skipped' },
      ],
    };
    const result = evaluatePrGreen(latest, jobsByRunId);
    expect(result.verdict).toBe('skipped');
  });

  it('cancelledだけが在れば cancelled（赤ではない）', () => {
    const jobsByRunId = {
      34743508004: [
        { name: 'image', status: 'completed', conclusion: 'success' },
        { name: 'ci', status: 'completed', conclusion: 'cancelled' },
      ],
    };
    const result = evaluatePrGreen(latestRuns, jobsByRunId);
    expect(result.verdict).toBe('cancelled');
  });

  it('failureとcancelledが同居すると red（cancelledがredを隠さない）', () => {
    const jobsByRunId = {
      34743508004: [
        { name: 'image', status: 'completed', conclusion: 'failure' },
        { name: 'ci', status: 'completed', conclusion: 'cancelled' },
      ],
    };
    const result = evaluatePrGreen(latestRuns, jobsByRunId);
    expect(result.verdict).toBe('red');
  });

  it('pushのrunで全jobがskippedなら unmeasurable（out-of-scopeと名乗らない。scheduleでの偽の安心を防ぐ詰め）', () => {
    const runs = [
      {
        id: 1,
        name: 'CI',
        event: 'push',
        created_at: '2026-09-17T12:00:00Z',
        status: 'completed',
        conclusion: 'skipped',
      },
    ];
    const latest = pickLatestRunPerWorkflow(runs);
    const jobsByRunId = {
      1: [
        { name: 'ci', status: 'completed', conclusion: 'skipped' },
        { name: 'image', status: 'completed', conclusion: 'skipped' },
        { name: 'base-overlap', status: 'completed', conclusion: 'skipped' },
      ],
    };
    const result = evaluatePrGreen(latest, jobsByRunId);
    expect(result.verdict).toBe('unmeasurable');
  });

  it('eventが無いrunでskippedが在れば skipped（安全側。out-of-scopeを名乗らない）', () => {
    const runs = [
      {
        id: 1,
        name: 'CI',
        // event を持たない（古い呼び出し・試験の既定を模す）
        created_at: '2026-09-17T12:00:00Z',
        status: 'completed',
        conclusion: 'success',
      },
    ];
    const latest = pickLatestRunPerWorkflow(runs);
    const jobsByRunId = {
      1: [
        { name: 'ci', status: 'completed', conclusion: 'success' },
        { name: 'base-overlap', status: 'completed', conclusion: 'skipped' },
      ],
    };
    const result = evaluatePrGreen(latest, jobsByRunId);
    expect(result.verdict).toBe('skipped');
  });

  it('鏡像ケース: 古い世代のsuccessが新しい世代のfailureに引きずられない', () => {
    // Issue #933「今回は安全側に外れたが、鏡像は古い世代のsuccessが新しい世代の
    // failureをstarted_atで追い越す」を、created_atベースの選択で再現する。
    // 古いrun（先に作られた、success）と新しいrun（後に作られた、failure）が
    // 同じworkflow名で同居しても、常に新しいほうのjobsだけを見る。
    const runs = [
      {
        id: 1,
        name: 'CI',
        created_at: '2026-09-15T00:00:00Z',
        status: 'completed',
        conclusion: 'success',
      },
      {
        id: 2,
        name: 'CI',
        created_at: '2026-09-15T00:00:10Z',
        status: 'completed',
        conclusion: 'failure',
      },
    ];
    const latest = pickLatestRunPerWorkflow(runs);
    const jobsByRunId = {
      2: [{ name: 'ci', status: 'completed', conclusion: 'failure' }],
    };
    const result = evaluatePrGreen(latest, jobsByRunId);
    expect(result.verdict).toBe('red');
  });
});

describe('formatVerdict', () => {
  it('各verdictの1行目に判定の種類が読める（静かに失敗しない）', () => {
    expect(formatVerdict('abc123', { verdict: 'green', detail: [] })).toMatch(/OK/);
    expect(formatVerdict('abc123', { verdict: 'red', detail: [] })).toMatch(/NG/);
    expect(formatVerdict('abc123', { verdict: 'pending', detail: [] })).toMatch(/保留/);
    expect(formatVerdict('abc123', { verdict: 'unmeasurable', detail: [] })).toMatch(
      /判定できなかった/,
    );
    expect(formatVerdict('abc123', { verdict: 'no-runs', detail: [] })).toMatch(/判定できなかった/);
    expect(formatVerdict('abc123', { verdict: 'cancelled', detail: [] })).toMatch(/中断された job/);
    expect(formatVerdict('abc123', { verdict: 'out-of-scope', detail: [] })).toMatch(/対象外/);
    expect(formatVerdict('abc123', { verdict: 'skipped', detail: [] })).toMatch(/draft/);
  });
});

describe('filterRunsByEvent（Issue #1207 の (3) 自己参照バグの修正）', () => {
  it('events を渡さなければ（既定）1件も落とさない —— 既存の呼び出し元の挙動を変えない', () => {
    const runs = [
      { id: 1, name: 'CI', event: 'push' },
      { id: 2, name: 'release/prod へ反映', event: 'schedule' },
      { id: 3, name: '名前無し互換', event: undefined },
    ];
    expect(filterRunsByEvent(runs, undefined)).toEqual(runs);
    expect(filterRunsByEvent(runs, null)).toEqual(runs);
  });

  it('events=["push"] を渡すと、push 以外（schedule / workflow_dispatch / workflow_run）を落とす', () => {
    const runs = [
      { id: 1, name: 'CI', event: 'push' },
      { id: 2, name: 'release/prod へ反映', event: 'schedule' },
      { id: 3, name: 'release/prod へ反映', event: 'workflow_dispatch' },
      { id: 4, name: 'main の赤を知らせる', event: 'workflow_run' },
    ];
    expect(filterRunsByEvent(runs, ['push']).map((r: { id: number }) => r.id)).toEqual([1]);
  });

  it('空配列を渡すと全部落ちる（何も許可しない、という指定として扱う）', () => {
    const runs = [{ id: 1, name: 'CI', event: 'push' }];
    expect(filterRunsByEvent(runs, [])).toEqual([]);
  });
});

describe('自己参照バグの再現と修正（Issue #1207 の (3)。実測固定値）', () => {
  // 実測（2026-09-19T21:28:57Z 観測、release-prod.yml 記録 step のログ、
  // sha fa9ec3e380fbe9dad8a3d1ad3e6c43c0639d5cb6）を写した最小構成。
  // release-prod.yml の記録 step は main HEAD の sha を judgeSha に渡すが、
  // その sha は「いま実行中の release-prod.yml 自身の run」も同じ head_sha
  // で名乗っている（schedule/workflow_dispatch は「そのとき指している
  // デフォルトブランチの先端」を head_sha に持つため）。
  const runs = [
    {
      id: 35458661938,
      name: 'CI',
      event: 'push',
      created_at: '2026-09-19T17:37:24Z',
      status: 'completed',
      conclusion: 'success',
    },
    {
      // これが「実行するたびに自分自身を理由に pending を返す」原因——
      // まさにこの記録 step を動かしている release-prod.yml 自身の run。
      id: 35470533724,
      name: 'release/prod へ反映',
      event: 'schedule',
      created_at: '2026-09-19T21:28:49Z',
      status: 'in_progress',
      conclusion: null,
    },
  ];
  const jobsByRunId = {
    35458661938: [
      { name: 'ci', status: 'completed', conclusion: 'success' },
      { name: 'image', status: 'completed', conclusion: 'success' },
      { name: 'base-overlap', status: 'completed', conclusion: 'skipped' },
    ],
  };

  it('絞らない（旧来の挙動）: 実行中の自分自身が latestRuns に混ざり、pending に化ける', () => {
    const latest = pickLatestRunPerWorkflow(filterRunsByEvent(runs, undefined));
    const result = evaluatePrGreen(latest, jobsByRunId);
    expect(result.verdict).toBe('pending');
    expect(result.detail.join('\n')).toContain('release/prod へ反映');
  });

  it('events=["push"] で絞る（修正後）: 自己参照が構造的に外れ、push の CI run だけで判定できる', () => {
    const latest = pickLatestRunPerWorkflow(filterRunsByEvent(runs, ['push']));
    const result = evaluatePrGreen(latest, jobsByRunId);
    // push の run のみ ⟹ pull_request の run が無いので out-of-scope
    // （base-overlap は pull_request 専用で設計どおり skip。ci/image は success）。
    expect(result.verdict).toBe('out-of-scope');
  });
});

describe('isFullCommitSha（略記を no-runs に化けさせないための述語。Issue #1192 の N5）', () => {
  it('40文字の16進だけを真とする（大文字も可）', () => {
    expect(isFullCommitSha('3ca63973b7dae66b48b033a962a92e19c7e73e63')).toBe(true);
    expect(isFullCommitSha('3CA63973B7DAE66B48B033A962A92E19C7E73E63')).toBe(true);
  });

  it('略記・長すぎ・非16進・sha でない型は偽', () => {
    expect(isFullCommitSha('3ca63973b7da')).toBe(false);
    expect(isFullCommitSha('f'.repeat(39))).toBe(false);
    expect(isFullCommitSha('f'.repeat(41))).toBe(false);
    expect(isFullCommitSha('g'.repeat(40))).toBe(false);
    expect(isFullCommitSha('')).toBe(false);
    expect(isFullCommitSha(undefined)).toBe(false);
    expect(isFullCommitSha(12345)).toBe(false);
  });
});
