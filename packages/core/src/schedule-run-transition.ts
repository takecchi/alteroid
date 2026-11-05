import { stripNul } from './nul-guard.js';
import { scheduledRequestSchema } from './schema.js';
import type { ScheduleSpec, ScheduledRequest } from './schema.js';

// 継続中の依頼の行が、発火と編集でどう変わるか。純関数だけを置き、インメモリと fs の器が同じものを呼ぶ。
// pg は `jsonb` の演算で同じ規則を SQL に書いている（`schedules.ts` の `claimRun` / `completeRun`）ので、規則を変えるときは3か所を揃える。
// 版の照合（`ifMatch`）・読めない行・排他は器の側が持つ。ここは「在る行から次の行を作る」ところだけ。

/**
 * 発火を引き受ける。`null` は「消された・書き換わった」で、古い本文で動かさないために何も書かない。
 * `before` は更新前の姿（前回いつ動いたかが分かる）。`updatedAt` は版の識別子なので動かさず、定期の基準 `lastScheduledRunAt` は `completeScheduledRunRow` まで進めない。
 */
export function claimScheduledRunRow(
  row: ScheduledRequest | undefined,
  expectedUpdatedAt: string,
  at: string,
  cause: 'schedule' | 'manual',
): { before: ScheduledRequest; next: ScheduledRequest } | null {
  if (row === undefined || row.updatedAt !== expectedUpdatedAt) return null;
  return { before: row, next: { ...row, lastRunAt: at, pendingRun: { at, cause } } };
}

/**
 * 引き受けた印を外す。別の発火の印が付いているなら行をそのまま返す（後から来た発火のものを消さない）。
 * 定期の発火だけが `lastScheduledRunAt` を進める: 手動の発火で進めると、再起動した瞬間に定期の予定が手動実行の時刻へずれる。
 */
export function completeScheduledRunRow(
  row: ScheduledRequest,
  at: string,
  cause: 'schedule' | 'manual',
): ScheduledRequest {
  if (row.pendingRun?.at !== at) return row;
  const rest = { ...row };
  delete rest.pendingRun;
  return cause === 'schedule' ? { ...rest, lastScheduledRunAt: at } : rest;
}

/**
 * 本文と spec を書き換えて `updatedAt` を進める。`pendingRun` / `lastRunAt` 等は行から引き継ぐ。
 * `put()` と同じく `scheduledRequestSchema` を通す（空の `request` は投げる）。
 */
export function editScheduledRequestRow(
  row: ScheduledRequest,
  changes: { readonly request: string; readonly spec: ScheduleSpec },
  updatedAt: string,
): ScheduledRequest {
  return scheduledRequestSchema.parse({
    ...row,
    request: stripNul(changes.request),
    spec: changes.spec,
    updatedAt,
  });
}
