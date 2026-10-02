import { compareIsoInstant } from './iso-instant.js';
import type { PendingApproval } from './schema.js';
import type { ApprovalList, NotificationStore } from './store.js';

/**
 * 人間への通知一覧（issue #2515 の最初の切り出し）。
 *
 * ## 何を知らせるか — いまは承認待ちだけ
 *
 * 元は**承認待ちキュー**（`JobStore.listApprovals`）である。積むのは
 * `ask_human` と `request_permission` の2つだけ（どちらも `tools.ts` で
 * `stores.jobs.putApproval` を呼ぶ）で、どちらも人間の答えが要るものである。
 *
 * **日誌の `escalation` から作らないこと。** `escalation` はマネージャーから
 * クローンへの確認（`manager.ts`）・回答・取り下げの終端の行でも書かれるので、
 * 「`escalation` が来たら通知」にすると、人間宛てでないもの（クローンが自分で
 * 答える確認）まで人間に知らせることになる。承認待ちキューを元にすれば、
 * その区別は器の側で既に付いている。
 *
 * ## 新しく持つ状態は既読の位置1つだけ
 *
 * 一覧そのものは承認待ちキューを読んで作る射影で、真実を2つ作らない。
 * 既読は**全員で1組**（`NotificationStore`）——PRD「非ゴール」の「利用者ごとに
 * データを分けない」の線で、誰が読んでも既読になる。
 *
 * 答えた・取り下げた承認待ちは、既読の操作をしなくても一覧から消える
 * （片付いたものを「未読」として残さない）。
 */

/** 通知の種類。いまは承認待ちだけ（issue #2515 の §5）。 */
export const NOTIFICATION_KINDS = ['approval_pending'] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

/** 承認待ちが1件積まれた、という通知。 */
export interface ApprovalPendingNotification {
  kind: 'approval_pending';
  /** 承認待ちの id（`POST /approvals/:id/answer` に渡すもの）。 */
  approvalId: string;
  /** 承認待ちが積まれた時刻（`PendingApproval.createdAt`）。既読の位置と比べる値。 */
  at: string;
  question: string;
  /** どの会話で上がった確認か（在るときだけ）。 */
  conversationId?: string;
  /** マネージャーから回ってきた確認なら、その manager_id（在るときだけ）。 */
  managerId?: string;
  read: boolean;
}

export type Notification = ApprovalPendingNotification;

/** 既読の位置。`readThrough` 以前（同時刻を含む）の通知は既読である。 */
export interface NotificationReadCursor {
  readThrough: string;
  /** 位置が最後に動いた時刻。 */
  updatedAt: string;
}

/**
 * 既読の位置の読み出し結果。
 *
 * **「無い」と「読めない」を分ける**（AGENTS.md「取れない軸に 0 の行を作る」）。
 * 読めないときに `none` へ潰すと、全件が黙って未読に戻ったことを誰も説明できない。
 */
export type NotificationCursorRead =
  | { state: 'none' }
  | { state: 'ok'; cursor: NotificationReadCursor }
  | { state: 'unreadable'; reason: string };

export interface NotificationFeed {
  /** 新しい順。 */
  notifications: Notification[];
  unreadCount: number;
  /** 既読の位置（まだ一度も既読にしていなければ `null`）。 */
  readThrough: string | null;
  /**
   * 一覧のうちいちばん新しい通知の時刻（1件も無ければ鍵ごと無い）。
   *
   * **既読にするときはこの値を `through` に渡す。** 「いま」を渡すと、一覧を
   * 読んだ後・既読にする前に積まれた承認待ちまで、見ていないのに既読になる。
   */
  latestAt?: string;
  /**
   * 既読の位置が読めなかったときだけ載る理由。**このとき全件を未読として数える**
   * （知らせすぎる側へ倒す。知らせ損ねるほうが取り返しがつかない）。
   */
  cursorUnreadable?: string;
  /**
   * 読めない承認待ちの件数（1件でも在るときだけ載る）。**0件と読めないを混ぜない**
   * （issue #2105 と同じ穴を作らない）——この件数は一覧にも未読数にも入っていない。
   */
  unreadableApprovals?: number;
}

function isPending(approval: PendingApproval): boolean {
  return approval.answeredAt === undefined && approval.withdrawnAt === undefined;
}

/**
 * 承認待ちキューと既読の位置から、通知一覧を作る。
 *
 * HTTP（`GET /notifications`）・CLI・Web UI が見るものはすべてこの結果である
 * ——数え方を入口ごとに書き分けない。
 */
export function buildNotificationFeed(
  approvals: ApprovalList,
  cursor: NotificationCursorRead,
): NotificationFeed {
  const readThrough = cursor.state === 'ok' ? cursor.cursor.readThrough : null;
  const notifications: Notification[] = approvals.entries
    .filter(isPending)
    .map((approval) => ({
      kind: 'approval_pending' as const,
      approvalId: approval.id,
      at: approval.createdAt,
      question: approval.question,
      ...(approval.conversationId === undefined ? {} : { conversationId: approval.conversationId }),
      ...(approval.jobId === undefined ? {} : { managerId: approval.jobId }),
      read: readThrough !== null && compareIsoInstant(approval.createdAt, readThrough) <= 0,
    }))
    // 新しい順。同着は id で決める（器ごとの生の並びに乗らない）。
    .sort(
      (a, b) =>
        compareIsoInstant(b.at, a.at) ||
        (a.approvalId < b.approvalId ? 1 : a.approvalId > b.approvalId ? -1 : 0),
    );

  const feed: NotificationFeed = {
    notifications,
    unreadCount: notifications.filter((notification) => !notification.read).length,
    readThrough,
  };
  const latest = notifications[0];
  if (latest !== undefined) feed.latestAt = latest.at;
  if (cursor.state === 'unreadable') feed.cursorUnreadable = cursor.reason;
  if (approvals.unreadable.length > 0) feed.unreadableApprovals = approvals.unreadable.length;
  return feed;
}

/**
 * `NotificationStore` の契約を、**実装1つに対して**測る（`mcp-server-contract.ts`
 * と同じ理由で、インメモリ・fs・pg の3実装が同じ関数を呼ぶ）。
 *
 * **vitest に依存しない素の非同期関数にしてある**（`storage-fs` / `storage-pg` へ
 * vitest を持ち込まないため）。
 *
 * ⚠️ 器は空（一度も既読にしていない）の状態で渡すこと。この関数は位置を進める。
 */
export async function verifyNotificationStoreContract(store: NotificationStore): Promise<void> {
  function fail(message: string): never {
    throw new Error(`通知の既読の器の契約違反: ${message}`);
  }

  // --- 1. 一度も既読にしていなければ none ---
  const initial = await store.readCursor();
  if (initial.state !== 'none') fail(`空の器の readCursor() が none でない: ${initial.state}`);

  // --- 2. 進めたら読み戻せる ---
  const t1 = '2026-10-01T00:00:01.000Z';
  const advanced = await store.advanceReadCursor(t1);
  if (compareIsoInstant(advanced.readThrough, t1) !== 0) {
    fail(`advanceReadCursor() の返り値が渡した位置と違う: ${advanced.readThrough}`);
  }
  if (Number.isNaN(Date.parse(advanced.updatedAt))) fail('updatedAt が時刻として読めない');
  const reread = await store.readCursor();
  if (reread.state !== 'ok' || compareIsoInstant(reread.cursor.readThrough, t1) !== 0) {
    fail(`進めた位置を読み戻せない: ${JSON.stringify(reread)}`);
  }

  // --- 3. 戻らない（古い位置を渡しても、いまの位置のまま） ---
  // 2つの入口（例: CLI と Web UI）がほぼ同時に既読にしたとき、遅れて届いた古い
  // 位置で巻き戻ると、読んだはずの通知が未読へ戻る。
  const older = await store.advanceReadCursor('2026-10-01T00:00:00.000Z');
  if (compareIsoInstant(older.readThrough, t1) !== 0) {
    fail(`古い位置で巻き戻った（返り値）: ${older.readThrough}`);
  }
  const afterOlder = await store.readCursor();
  if (afterOlder.state !== 'ok' || compareIsoInstant(afterOlder.cursor.readThrough, t1) !== 0) {
    fail(`古い位置で巻き戻った（読み戻し）: ${JSON.stringify(afterOlder)}`);
  }

  // --- 4. 新しい位置へは進む ---
  const t2 = '2026-10-01T00:00:02.000Z';
  await store.advanceReadCursor(t2);
  const afterNewer = await store.readCursor();
  if (afterNewer.state !== 'ok' || compareIsoInstant(afterNewer.cursor.readThrough, t2) !== 0) {
    fail(`新しい位置へ進まない: ${JSON.stringify(afterNewer)}`);
  }
}
