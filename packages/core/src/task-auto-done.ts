import { taskFromCommitment } from './commitment-task-migration.js';
import { compareIsoInstant } from './iso-instant.js';
import type { Commitment, InboxEvent, Task } from './schema.js';
import type { Stores } from './store.js';

// 人間の依頼を Task として積む（#5469 P5 の自動起票）と、起点の会話へ返答したターンの終わりに queued の task を自動で done にする（自動 done）。
// 純関数と、Task ストア・日誌への書き込みだけを置く。いつ呼ぶかは clone.ts（`#commit` と `turn_ended`）。

/** 台帳へ開く行（`commitmentFor`）と同じ合図から、同じ id の Task を作る。human_message だけが起点の会話を持つ（human_answer の会話 id は承認の側にあり、task の起点ではない）。 */
export function taskFromHumanIntake(entry: Commitment, event: InboxEvent, now: string): Task {
  // id・source・title・body・status・置き場所は P7a の移行（`taskFromCommitment`）と同じ規則を使う:
  // id が元の台帳の行と同じなので、移行が `existed` で二重に作らず、自動起票も移行済みの行を二重に作らない
  const task = taskFromCommitment(entry, now);
  return event.type === 'human_message'
    ? { ...task, originConversationId: event.conversationId }
    : task;
}

/** 返答の経路。日誌に「どの返答で閉じたか」として残す。 */
export type TurnReplyVia =
  /** このターン自身の返答（人間の発言で起きたターンが、その会話へ返した） */
  | 'turn_reply'
  /** `conversation_post` で別の会話へ書いた */
  | 'conversation_post';

/**
 * 1ターンの間に起きた「会話への返答」と「委譲」の控え。ターンの始まりで作り直し、終わりで `autoCloseRepliedTasks` に渡す。
 * 数えない返答: `ask_human`（返答ではなく問い。task は人間の答え待ちになるべきで、閉じる理由にならない）、
 * 機構が自分で書く一行（安全分類器の拒否・畳み直しの通知。`Clone#journal` へ直接書き、このターンの返答として積まれない）。
 */
export interface TurnReplyTrace {
  /** ターンの始まりの時刻（ISO）。これより後に届いた task は、このターンの入力に入っていないので閉じない。 */
  readonly startedAt: string;
  /** 返答した会話 id → その経路（同じ会話へ複数回返したら、先の経路を残す）。 */
  readonly replied: ReadonlyMap<string, TurnReplyVia>;
  /** このターンで起こした委譲（`manager_start`）の起点の会話 id。起点が無い委譲は入れない。 */
  readonly delegatedOriginConversationIds: ReadonlySet<string>;
}

/**
 * このターンで、その task に結び付く委譲を起こしたか。
 * いまは `Job.conversationId`（委譲の起点の会話）と task の `originConversationId` の一致で見る。
 * P3（#5482）で `Job.taskId` が入ったら、ここだけを `task.id` との一致へ置き換える（この関数が唯一の判定点）。
 * 会話の一致だと、同じ会話の別の task のために起こした委譲でも「結び付いた」と数えて閉じない側へ倒れる（閉じ損ねる向き。勝手に閉じるより安全）。
 */
export function turnDelegatedForTask(task: Task, trace: TurnReplyTrace): boolean {
  return (
    task.originConversationId !== undefined &&
    trace.delegatedOriginConversationIds.has(task.originConversationId)
  );
}

/**
 * 閉じる対象。次をすべて満たす task だけ:
 * - status が queued（waiting / needs_decision は、器が勝手に閉じない。外の返事待ち・判断待ちを返答で終わりにしない）
 * - 起点の会話があり、そこへこのターンが返答した
 * - 「続く」の印（`keep`）が無い
 * - このターンで、その task に結び付く委譲を起こしていない（`turnDelegatedForTask`）
 * - ターンの始まりより前に届いている（返答の最中に届いた task は、返答の宛先になっていない）
 */
export function selectTasksToAutoClose(tasks: readonly Task[], trace: TurnReplyTrace): Task[] {
  return tasks.filter(
    (task) =>
      task.status === 'queued' &&
      task.keep !== true &&
      task.originConversationId !== undefined &&
      trace.replied.has(task.originConversationId) &&
      compareIsoInstant(task.createdAt, trace.startedAt) <= 0 &&
      !turnDelegatedForTask(task, trace),
  );
}

export function autoCloseReason(conversationId: string): string {
  return `起点の会話へ返答したので自動で閉じた（会話 ${conversationId}）。人間・クローンが否定するなら task_set_status で queued に開き直すこと`;
}

export interface AutoCloseOutcome {
  readonly closed: readonly Task[];
  /** 閉じられなかった・日誌を書けなかったもの（id と、例外の型名。本文は載せない）。 */
  readonly failed: readonly { readonly id: string; readonly step: 'close' | 'journal' }[];
}

/**
 * 返答のターンの終わりに呼ぶ。開いている task を読み、`selectTasksToAutoClose` が選んだものを `done`（`closedBy: 'daemon'`）にして、閉じたことを日誌へ残す。
 * 日誌には id と title だけを書く（本文は逐語で書かない。全文は task に在る）。
 * 閉じてから日誌を書く（`task_set_status` の閉じる側と同じ向き。開き直せる操作で、日誌が書けなかった回は `failed` に数えて呼び側が stderr へ残す）。
 * 判定と書き込みのあいだに別の手で状態が変わっていたら（`setStatus` が `changed` を返さない）何も書かない。
 */
export async function autoCloseRepliedTasks(
  stores: Pick<Stores, 'tasks' | 'journal'>,
  trace: TurnReplyTrace,
  now: string,
): Promise<AutoCloseOutcome> {
  if (trace.replied.size === 0) return { closed: [], failed: [] };
  const { entries } = await stores.tasks.list();
  const closed: Task[] = [];
  const failed: { id: string; step: 'close' | 'journal' }[] = [];
  for (const task of selectTasksToAutoClose(entries, trace)) {
    const conversationId = task.originConversationId;
    const via = conversationId === undefined ? undefined : trace.replied.get(conversationId);
    if (conversationId === undefined || via === undefined) continue;
    const reason = autoCloseReason(conversationId);
    let result;
    try {
      result = await stores.tasks.setStatus(task.id, 'done', { reason, by: 'daemon', at: now });
    } catch {
      failed.push({ id: task.id, step: 'close' });
      continue;
    }
    if (result.kind !== 'changed') continue;
    closed.push(result.task);
    try {
      await stores.journal.append({
        type: 'decision',
        decision: `task を自動で done にした（${task.id}: ${task.title}）: 起点の会話 ${conversationId} へ返答したターンが終わった`,
        grounds:
          `返答の経路: ${via === 'turn_reply' ? 'そのターン自身の返答' : 'conversation_post'}。` +
          'queued で、「続く」の印が無く、そのターンで結び付く委譲も起こしていないため（#5469 P5）。本文は書かない（task_list id で読める）',
      });
    } catch {
      failed.push({ id: task.id, step: 'journal' });
    }
  }
  return { closed, failed };
}
