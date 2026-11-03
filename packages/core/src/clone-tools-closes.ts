// `manager_send` / `journal_write` の `closes`（task を done にする任意引数）の部品。
// 2つの族（journal・manager）が共有する。`tools.ts` を import しない（一方向）。

import { z } from 'zod';
import { appendJournalOrThrow, JournalNotRecordedError, text } from './clone-tools-common.js';
import type { ToolText } from './clone-tools-common.js';
import { reasonOf } from './dropped-record.js';
import type { Task } from './schema.js';
import { UnreadableTaskError } from './store.js';
import type { Stores } from './store.js';
import { taskStatusChangeEntry } from './task-tools.js';
import {
  describeArrayLengthViolation,
  describeBlankViolation,
  describeStringLengthViolation,
} from './tool-arg-checks.js';

// `manager_send` / `journal_write` の任意引数 `closes` の上限: 1回の呼びで片付く行の数として十分で、引数が肥大しない大きさ
const CLOSES_MAX = 5;

// 説明文は2道具で同じ1文にする（道具定義は毎ターン読み直されるため、長くしない）
export const CLOSES_SCHEMA = z
  .array(z.object({ id: z.string(), reason: z.string() }))
  .optional()
  .describe('任意。この呼びで片付いた task を、id と理由で done にする（返事だけでは閉じない）');

// 件数と各 reason の形は、本来の作業の前に丸ごと検査する（`task_set_status` の reason と同じ検査）
export function describeClosesViolation(
  closes: readonly { id: string; reason: string }[] | undefined,
) {
  const lengthError = describeArrayLengthViolation('closes', closes, { max: CLOSES_MAX });
  if (lengthError !== null) return `${lengthError}何もしていない。`;
  for (const [index, entry] of (closes ?? []).entries()) {
    const reasonError =
      describeStringLengthViolation(`closes[${index}].reason`, entry.reason, { min: 1 }) ??
      describeBlankViolation(`closes[${index}].reason`, entry.reason);
    if (reasonError !== null) return `${reasonError}何もしていない。`;
  }
  return null;
}

// `closes` の1件分: Task を done にする。`task_set_status` と同じ作法（遷移は `setStatus` が持ち、日誌は `taskStatusChangeEntry`）
// `via`: どの呼びで閉じたか。日誌の grounds にそのまま書く
async function closeTaskBody(
  stores: Stores,
  id: string,
  reason: string,
  via: string = 'task_set_status',
): Promise<string> {
  const reasonError =
    describeStringLengthViolation('reason', reason, { min: 1 }) ??
    describeBlankViolation('reason', reason);
  if (reasonError !== null) return reasonError;
  const unreadableNote = `task ${id} は読めない形で入っている。読めない形のまま書き直さないので、閉じていない。`;
  let existing: Task | null;
  try {
    existing = await stores.tasks.get(id);
  } catch (error) {
    if (error instanceof UnreadableTaskError) return unreadableNote;
    throw error;
  }
  if (existing === null) {
    return `task ${id} は無い（task_list で実在する id を確かめること）。`;
  }
  if (existing.closedAt !== undefined) {
    return `${id} は既に ${existing.closedAt} に閉じてある（${existing.closedReason ?? '理由の記録なし'}）。`;
  }
  // 閉じたかどうかは `setStatus` の戻り値に任せる: 直前の `get` の後に他の経路が先に閉じていると、実際には閉じていないのに日誌へ書くことになるため
  let result;
  try {
    result = await stores.tasks.setStatus(id, 'done', {
      reason,
      by: 'clone',
      at: new Date().toISOString(),
    });
  } catch (error) {
    if (error instanceof UnreadableTaskError) return unreadableNote;
    throw error;
  }
  if (result.kind === 'not-found') {
    return `task ${id} は無い（確かめた直後に消えていた）。この呼びでは閉じていない。`;
  }
  if (result.kind === 'unchanged') return `${id} は既に done。`;
  if (result.kind === 'rejected') {
    return `${id} は ${result.from} から done へは移せない（閉じた件から戻せるのは queued だけ）。この呼びでは閉じていない。`;
  }
  // 自分で閉じたことは日誌に残す（`task_set_status` と同じ行）
  await appendJournalOrThrow(
    'task_set_status',
    stores.journal,
    taskStatusChangeEntry(id, result.before, 'done', reason, via),
    'act-completed',
  );
  return `${id} を done にした。`;
}

// `closes` 付きの呼びの仕上げ: 本来の作業が通ったときだけ閉じ、閉じた id ごとの結果を各1行で応答の末尾へ足す。
// 閉じる側の失敗（日誌が書けない等）は本来の作業を失敗にしない: 作業は済んでいるため、その行の結果として言う
export async function finishWithCloses(
  stores: Stores,
  res: ToolText,
  closes: readonly { id: string; reason: string }[] | undefined,
  workDone: boolean,
  via: 'manager_send' | 'journal_write',
): Promise<ToolText & { isError?: boolean }> {
  if (closes === undefined || closes.length === 0) return res;
  const head = res.content[0]?.text ?? '';
  if (!workDone) {
    return text(`${head}\n本来の作業が通っていないので、closes の行は1行も閉じていない。`);
  }
  const lines: string[] = [];
  let failed = false;
  for (const entry of closes) {
    try {
      lines.push(
        `closes ${entry.id}: ${await closeTaskBody(stores, entry.id, entry.reason, `${via} の closes`)}`,
      );
    } catch (error) {
      // 単独の `task_set_status` は日誌が書けないと `isError` で返る。ここも握り潰して成功の1行にせず、`isError` で合図する
      // （本来の作業の結果は先頭に残す: 作業は済んでいるので、応答ごと失敗に見えて同じ送信をやり直されないため）
      failed = true;
      lines.push(
        error instanceof JournalNotRecordedError
          ? `closes ${entry.id}: **task は done にしている**が、日誌に残せていない（既に閉じているので、閉じ直す呼びは要らない）。` +
              '人間が後から読めるよう、journal_write で閉じたことを書き残すこと。'
          : `closes ${entry.id}: 閉じる処理が失敗した（${reasonOf(error)}）。閉じたかどうかは task_list で確かめること。`,
      );
    }
  }
  const body = text(`${head}\n${lines.join('\n')}`);
  return failed ? { ...body, isError: true } : body;
}
