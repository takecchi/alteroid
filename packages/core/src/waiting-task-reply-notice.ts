import { excerptLine } from './excerpt.js';
import type { Job, Task } from './schema.js';

// 人間の発言が届いたターンの断り書きに足す、「その会話を起点にした返事待ち（waiting）の task」の行（器は task の状態を変えない: 閉じる・戻すはクローンが決める）。
// 人間の発言は同じ会話の waiting の task を解かない（自動 done は queued だけ）ので、返事が来ても開いたまま残るのを、名乗って気づかせる。

export const WAITING_REPLY_SHOWN = 5;
export const WAITING_REPLY_TITLE_EXCERPT = 60;

/**
 * 該当した task（無ければ空）。条件: `waiting`・起点の会話が `conversationIds` のどれか・走っている委譲（running / waiting_human の Job で `Job.taskId` が一致）が結び付いていない。
 * 委譲が結び付いた task は manager の鏡（委譲の終わりに追従する）が扱うので名乗らない。
 */
export function selectWaitingReplyTasks(
  tasks: readonly Task[],
  jobs: readonly Pick<Job, 'status' | 'taskId'>[],
  conversationIds: ReadonlySet<string>,
): Task[] {
  const delegated = new Set<string>();
  for (const job of jobs) {
    if ((job.status === 'running' || job.status === 'waiting_human') && job.taskId !== undefined) {
      delegated.add(job.taskId);
    }
  }
  return tasks.filter(
    (task) =>
      task.status === 'waiting' &&
      task.originConversationId !== undefined &&
      conversationIds.has(task.originConversationId) &&
      !delegated.has(task.id),
  );
}

/** 該当が無ければ空配列（見出しも空行も出さない）。`guide` は固定の案内文（呼び手が同じ会話の2回目から畳む）。 */
export function describeWaitingReplyLines(matched: readonly Task[], guide: string): string[] {
  if (matched.length === 0) return [];
  const shown = matched
    .slice(0, WAITING_REPLY_SHOWN)
    .map((task) => `\`${task.id}\` ${excerptLine(task.title, WAITING_REPLY_TITLE_EXCERPT)}`);
  const rest = matched.length - shown.length;
  return [
    `[system] この会話を起点にした返事待ち（waiting）の task: ${shown.join(' / ')}${rest > 0 ? `（ほか ${rest} 件）` : ''}。${guide}`,
  ];
}
