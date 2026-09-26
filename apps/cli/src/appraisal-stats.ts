import { stdout } from 'node:process';

import { describeAppraisalStats } from '@alteroid/core';

import { createClient } from './client.js';
import { describeAuthFailure, resolveTarget } from './target.js';

/**
 * `alteroid appraisal-stats` — 評定の内訳を器の外から読む（#1620）。
 *
 * 経路は `GET /appraisal-stats` の1本だけ（`apps/daemon/src/app.ts`「経路は
 * 1本だけにする」）。クローンの道具 `appraisal_stats`（`packages/core/src/tools.ts`）
 * が同じ集計を見ている。#1278 が HTTP 面（`GET /appraisal-stats`）を作ったが、
 * 人間が読む面（CLI・Web UI）に入口が無かった——PRD「入口の等価性」を破って
 * いた（#1620）。**Web 側はここでは触らない**（担当 C の領域）。
 *
 * **文言は core（`describeAppraisalStats`）に任せ、ここで作り直さない。**
 * クローンの道具と同じ言葉・同じ数を出す——口ごとに違う言い回しで同じ状態が
 * 出ると、読む側は別の状態だと読む（`runners.ts` / `dropped.ts` と同じ判断）。
 * `journal.commitments`（引き受けた仕事＝台帳）と `journal.jobs`（委譲）を
 * 混ぜて読まない注意も、`describeAppraisalStats` の見出しにそのまま乗っている
 * ので、ここで新しく書き直さない。
 *
 * **読み取り専用。失敗の扱いは既存の読み取り系（`usage.ts` / `dropped.ts` /
 * `runners.ts` の `GET` / `permission.ts` の `permissionListCommand`）に揃える**
 * ——`!response.ok` でも例外は投げず、`stdout` へ書いて正常終了する。#1621 /
 * #1641 で変更系コマンド（POST 等、副作用のある操作）は例外を投げる形に揃えたが、
 * それはこの口の話ではない——ここは副作用の無い `GET` である。401/403 の文言
 * だけは `describeAuthFailure` に判定を委ねる（`permissionListCommand` と同じ形。
 * `/appraisal-stats` は `authenticate` だけが門で `requireOperator` を付けていない
 * ——`app.ts` の doc——ので `forbiddenKindOf` は呼ばずに丸投げしてよい）。
 */
export async function appraisalStatsCommand(): Promise<void> {
  const target = await resolveTarget();
  if (target.note !== null) {
    stdout.write(`${target.note}\n`);
    return;
  }
  const client = createClient(target.baseUrl, target.headers);
  const response = await client['appraisal-stats'].$get();
  if (!response.ok) {
    const described = describeAuthFailure(response.status, target);
    stdout.write(
      `${described ?? `評定の内訳を読めませんでした（HTTP ${String(response.status)}）`}\n`,
    );
    return;
  }
  const body = await response.json();
  stdout.write(`${describeAppraisalStats(body)}\n`);
}
