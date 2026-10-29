import { taskFromCommitment } from './commitment-task-migration.js';
import { compareIsoInstant } from './iso-instant.js';
import type { Commitment, InboxEvent, Task } from './schema.js';
import type { Stores } from './store.js';

// 人間の依頼を Task として積む（#5469 P5 の自動起票）と、起点の会話へ返答したターンの終わりに queued の task を自動で done にする（自動 done）。
// 純関数と、Task ストア・日誌への書き込みだけを置く。いつ呼ぶかは clone.ts（`#commit` と `turn_ended`）。

/**
 * Task を作る合図は人間の発言（human_message）だけ。回答（human_answer）では作らない:
 * 回答は「問いを出した側の task」への答えであり、新しい依頼ではない（問いを出した側の task は ask_human のターンで開いたまま残り、回答を受けたターンの返答で閉じる）。
 * 回答は台帳には移行期のあいだ載る（`commitmentFor`）が、Task の元にはならない。
 */
export function opensHumanTask(event: InboxEvent): event is HumanMessageEvent {
  return event.type === 'human_message';
}

type HumanMessageEvent = Extract<InboxEvent, { type: 'human_message' }>;

/** 台帳へ開く行（`commitmentFor`）と同じ発言から、同じ id の Task を作る。起点の会話は発言の会話。 */
export function taskFromHumanIntake(
  entry: Commitment,
  event: HumanMessageEvent,
  now: string,
): Task {
  // id・source・title・body・status・置き場所は P7a の移行（`taskFromCommitment`）と同じ規則を使う:
  // id が元の台帳の行と同じなので、移行が `existed` で二重に作らず、自動起票も移行済みの行を二重に作らない
  return { ...taskFromCommitment(entry, now), originConversationId: event.conversationId };
}

/** 返答の経路。日誌に「どの返答で閉じたか」として残す。 */
export type TurnReplyVia =
  /** このターン自身の返答（人間の発言で起きたターンが、その会話へ返した） */
  | 'turn_reply'
  /** `conversation_post` で別の会話へ書いた */
  | 'conversation_post';

/**
 * 1ターンの間に起きた「会話への返答」と「委譲」の控え。ターンの始まりで作り直し、終わりで `autoCloseRepliedTasks` に渡す。
 * 数えない返答: `ask_human`（返答ではなく問い。task は人間の答え待ちになるべきで、閉じる理由にならない。問いを出した会話の task は `askedConversationIds` で閉じない）、
 * 機構が自分で書く一行（安全分類器の拒否・畳み直しの通知。`Clone#journal` へ直接書き、このターンの返答として積まれない）。
 */
export interface TurnReplyTrace {
  /** ターンの始まりの時刻（ISO）。これより後に届いた task は、このターンの入力に入っていないので閉じない。 */
  readonly startedAt: string;
  /** 返答した会話 id → その経路（同じ会話へ複数回返したら、先の経路を残す）。 */
  readonly replied: ReadonlyMap<string, TurnReplyVia>;
  /**
   * このターンが入力として読んだ人間の発言（human_message）の id（task の id と同じ）。
   * 人間の発言で起きたターンの返答（`turn_reply`）が閉じられるのは、この id の task だけ。同じ会話でも、まだ読んでいない発言（束ねる上限で外れた残り・待ち行列で別の会話をはさんだ分・枠で保持中の分）の task は閉じない。
   * 空なら回答（human_answer）で起きたターン（人間の発言を読んでいない）。
   */
  readonly readSignalIds: ReadonlySet<string>;
  /**
   * 受信箱にまだ残っている合図の id（器の未読 ∪ 受信箱ストアの未処理）。呼び出し側が閉じる直前に測る。
   * `conversation_post` と回答のターンの返答は、読んだ合図の id を持たないので、「まだ読んでいない」ものをこれで除く。
   */
  readonly unreadSignalIds: ReadonlySet<string>;
  /**
   * 問い（`ask_human`・`request_permission`）を出して答えが無い会話 id（このターンで出したもの ∪ 閉じる直前に承認待ちの台帳から引いた、前のターンの未回答の問い）。
   * その会話の task は、人間の答え待ちなので閉じない。答えが付いた問いは台帳から外れるので、答えを受けたターンの返答では閉じる。
   */
  readonly askedConversationIds: ReadonlySet<string>;
  /** このターンで委譲に頼んだ（`manager_start`・`manager_send`）委譲が結び付いている task の id（`Job.taskId`）。task に結び付けていない委譲は入れない。 */
  readonly delegatedTaskIds: ReadonlySet<string>;
  /** 閉じる時点で走っている（running / waiting_human）委譲が結び付いている task の id（`Job.taskId`）。前のターンで起こした委譲もここに入る。 */
  readonly activeJobTaskIds: ReadonlySet<string>;
}

/**
 * その task に結び付いた委譲（`Job.taskId`、#5469 P3）が、走っている（running / waiting_human）か、このターンで頼んだものか。あれば task は閉じない（委譲の報告を読んでから閉じる）。
 * 判定は task の id と `Job.taskId` の一致だけ。会話の一致では見ない（同じ会話の別の task のために起こした委譲に巻き込まれない）。
 * `manager_start` に taskId を渡さなかった委譲は、どの task にも結び付かないので、ここでは数えない。
 * 委譲が終わった（done / failed / lost / stopped）後は P3 が task を needs_decision へ戻すので、queued でなくなり自動 done の対象外になる。
 */
export function hasDelegationForTask(task: Task, trace: TurnReplyTrace): boolean {
  return trace.delegatedTaskIds.has(task.id) || trace.activeJobTaskIds.has(task.id);
}

/** 返答の経路ごとの「この task は、この返答が宛てた発言のものか」。 */
function isAddressedByReply(task: Task, via: TurnReplyVia, trace: TurnReplyTrace): boolean {
  // 人間の発言で起きたターン: 読んだ発言の task だけ
  if (via === 'turn_reply' && trace.readSignalIds.size > 0) return trace.readSignalIds.has(task.id);
  // 回答のターンの返答・conversation_post: 受信箱にまだ残っている合図の task は、まだ読んでいないので除く
  return !trace.unreadSignalIds.has(task.id);
}

/**
 * 閉じる対象。次をすべて満たす task だけ:
 * - status が queued（waiting / needs_decision は、器が勝手に閉じない。外の返事待ち・判断待ちを返答で終わりにしない）
 * - 起点の会話があり、そこへこのターンが返答した。返答が宛てた発言の task だけ（`isAddressedByReply`）
 * - 「続く」の印（`keep`）が無い
 * - その会話に、答えの無い問い（`ask_human`・`request_permission`。前のターンのものを含む）が残っていない（人間の答え待ち。不要になった問いは `approval_withdraw` で取り下げると対象に戻る）
 * - その task に結び付く委譲が無い（`hasDelegationForTask`）
 * - ターンの始まりより前に届いている（返答の最中に届いた task は、返答の宛先になっていない）
 */
export function selectTasksToAutoClose(tasks: readonly Task[], trace: TurnReplyTrace): Task[] {
  return tasks.filter((task) => {
    const origin = task.originConversationId;
    if (origin === undefined) return false;
    const via = trace.replied.get(origin);
    return (
      via !== undefined &&
      task.status === 'queued' &&
      task.keep !== true &&
      !trace.askedConversationIds.has(origin) &&
      isAddressedByReply(task, via, trace) &&
      compareIsoInstant(task.createdAt, trace.startedAt) <= 0 &&
      !hasDelegationForTask(task, trace)
    );
  });
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
          'queued で、「続く」の印が無く、問いを出しておらず、結び付く委譲も走っていないため（#5469 P5）。本文は書かない（task_list id で読める）',
      });
    } catch {
      failed.push({ id: task.id, step: 'journal' });
    }
  }
  return { closed, failed };
}
