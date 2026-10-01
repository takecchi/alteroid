import { stdout } from 'node:process';

import type { NotificationFeed } from '@alteroid/core';

import { createClient } from './client.js';
import { withErrorReason } from './format.js';
import { describeAuthFailure, resolveTarget } from './target.js';

/**
 * `alteroid notifications` — 人間への通知の一覧と既読（issue #2515）。
 *
 * `GET /notifications` / `POST /notifications/read`（`apps/daemon/src/app.ts`）を
 * 叩くだけの薄いクライアント。**数えるのはデーモン（`@alteroid/core` の
 * `buildNotificationFeed`）の1か所で、ここでは数え直さない**——Web UI と違う
 * 未読数を出さないため。
 *
 * いまの元は承認待ち（`ask_human` / `request_permission`）だけである。答えるのは
 * 今までどおり `alteroid chat` の `/approvals` と `/answer`。
 */

/**
 * `alteroid notifications list` — 読み取り専用。**HTTP の失敗は stdout へ書いて
 * 正常終了する**（`inbox show` / `permission list` と同じ、読み取り系の作法）。
 */
export async function notificationsListCommand(): Promise<void> {
  const target = await resolveTarget();
  if (target.note !== null) {
    stdout.write(`${target.note}\n`);
    return;
  }
  const client = createClient(target.baseUrl, target.headers);
  const response = await client.notifications.$get();
  if (!response.ok) {
    const described = describeAuthFailure(response.status, target);
    stdout.write(
      `${described ?? (await withErrorReason(`通知を読めませんでした（${response.status}）`, response))}\n`,
    );
    return;
  }
  const feed = (await response.json()) as NotificationFeed;
  stdout.write(`${renderNotificationFeed(feed)}\n`);
}

/**
 * `alteroid notifications read` — 一覧のいちばん新しい通知までを既読にする。
 *
 * **先に一覧を読み、その `latestAt` を渡す。** 「いま」で既読にすると、一覧を
 * 読んでから既読にするまでの間に積まれた承認待ちまで、見ずに既読になる。
 *
 * **失敗は例外で上へ通す（＝終了コードが 0 でなくなる）。** 状態を変える操作なので、
 * 「既読になったのか」を終了コードから読めない形にしない（`inbox remove` と同じ）。
 */
export async function notificationsReadCommand(): Promise<void> {
  const target = await resolveTarget();
  // 未ログインの note も例外にする（#2456。書き込み系の作法）。
  if (target.note !== null) throw new Error(target.note);
  const client = createClient(target.baseUrl, target.headers);

  const listed = await client.notifications.$get();
  if (!listed.ok) {
    const described = describeAuthFailure(listed.status, target);
    if (described !== null) throw new Error(described);
    throw new Error(await withErrorReason(`通知を読めませんでした（${listed.status}）`, listed));
  }
  const before = (await listed.json()) as NotificationFeed;
  if (before.latestAt === undefined) {
    stdout.write('既読にする通知は無い。\n');
    return;
  }

  const response = await client.notifications.read.$post({ json: { through: before.latestAt } });
  if (!response.ok) {
    const described = describeAuthFailure(response.status, target);
    if (described !== null) throw new Error(described);
    throw new Error(
      await withErrorReason(`通知を既読にできませんでした（${response.status}）`, response),
    );
  }
  const after = (await response.json()) as NotificationFeed;
  stdout.write(
    `${before.latestAt} までを既読にした（未読 ${before.unreadCount} 件 → ${after.unreadCount} 件）。\n`,
  );
}

/** 一覧を、人間が読める形へ。 */
export function renderNotificationFeed(feed: NotificationFeed): string {
  const lines: string[] = [];
  if (feed.cursorUnreadable !== undefined) {
    lines.push(
      `⚠ 既読の位置が読めない（${feed.cursorUnreadable}）。全件を未読として数えている。` +
        'alteroid notifications read で書き直せる。',
    );
  }
  if (feed.unreadableApprovals !== undefined) {
    lines.push(
      `⚠ 読めない承認待ちが ${feed.unreadableApprovals} 件ある（壊れた行。この一覧にも未読数にも入っていない）。`,
    );
  }
  if (feed.notifications.length === 0) {
    lines.push('通知は無い（未回答の承認待ちは無い）。');
    return lines.join('\n');
  }
  lines.push(
    `未読 ${feed.unreadCount} 件（全 ${feed.notifications.length} 件。いまは承認待ちだけ）`,
  );
  for (const notification of feed.notifications) {
    const mark = notification.read ? '  ' : '● ';
    const where = [
      ...(notification.managerId === undefined ? [] : [`manager=${notification.managerId}`]),
      ...(notification.conversationId === undefined ? [] : [`会話=${notification.conversationId}`]),
    ];
    lines.push(
      `${mark}${notification.at}  承認待ち ${notification.approvalId}` +
        (where.length === 0 ? '' : `（${where.join(' ')}）`),
    );
    for (const line of notification.question.split('\n')) lines.push(`    ${line}`);
  }
  if (feed.unreadCount > 0) lines.push('', '既読にする: alteroid notifications read');
  lines.push('答える: alteroid chat の /approvals と /answer');
  return lines.join('\n');
}
