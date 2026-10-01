import { Link } from 'react-router';

import { Page, Badge, Button, Card, CardHeader, Empty, ErrorNote, Spinner } from '@alteroid/ui';
import { useMarkNotificationsRead, useNotifications } from '@alteroid/swr';
import { formatDateTime } from '@alteroid/logic';
import { useState } from 'react';

/**
 * `/notifications` — 人間への通知の一覧と既読（`GET /notifications` /
 * `POST /notifications/read`。issue #2515）。CLI の `alteroid notifications list` /
 * `read` と同じ口。
 *
 * **数えるのはデーモン（`@alteroid/core` の `buildNotificationFeed`）の1か所。**
 * ここでは未読数を数え直さない——CLI と違う数を出さないため。
 *
 * いまの元は承認待ち（`ask_human` / `request_permission`）だけで、答えるのは
 * 今までどおり `/approvals` の画面である。この画面は「何が届いているか」と
 * 「どこまで見たか」だけを持つ。
 *
 * **既読にするときは、画面に出ている `latestAt` を渡す。** 「いま」で既読にすると、
 * 画面を描いた後に積まれた承認待ちまで、見ずに既読になる。
 */
export default function Notifications() {
  const { data, error, isLoading } = useNotifications();
  const markRead = useMarkNotificationsRead();
  const [marking, setMarking] = useState(false);
  const [markError, setMarkError] = useState<unknown>(undefined);

  const latestAt = data?.latestAt;
  const canMark = latestAt !== undefined && (data?.unreadCount ?? 0) > 0;

  async function onMarkRead() {
    if (latestAt === undefined) return;
    setMarking(true);
    setMarkError(undefined);
    try {
      await markRead(latestAt);
    } catch (caught) {
      setMarkError(caught);
    } finally {
      setMarking(false);
    }
  }

  return (
    <Page
      title="通知"
      description="人間への通知（いまは未回答の承認待ち）。alteroid notifications list / GET /notifications と同じもの。既読は全員で1組"
      action={
        <Button size="sm" disabled={!canMark} loading={marking} onClick={() => void onMarkRead()}>
          すべて既読にする
        </Button>
      }
    >
      <Card>
        <CardHeader
          title="通知"
          subtitle="答えると一覧から消える。答えるのは承認待ちの画面"
          action={
            data === undefined ? undefined : (
              <Badge tone={data.unreadCount > 0 ? 'warn' : 'neutral'}>
                未読 {data.unreadCount}
              </Badge>
            )
          }
        />
        <ErrorNote error={error} className="m-4" />
        <ErrorNote error={markError} className="m-4" />
        {data?.cursorUnreadable === undefined ? null : (
          <p className="m-4 text-sm text-warn">
            既読の位置が読めない（{data.cursorUnreadable}
            ）。全件を未読として数えている。「すべて既読にする」で書き直せる。
          </p>
        )}
        {data?.unreadableApprovals === undefined ? null : (
          <p className="m-4 text-sm text-warn">
            読めない承認待ちが {data.unreadableApprovals}{' '}
            件ある（壊れた行。この一覧にも未読数にも入っていない）。
          </p>
        )}
        {isLoading ? (
          <Spinner />
        ) : data === undefined ? null : data.notifications.length === 0 ? (
          <Empty>通知は無い（未回答の承認待ちは無い）。</Empty>
        ) : (
          <ul className="divide-y divide-border">
            {data.notifications.map((notification) => (
              <li key={notification.approvalId} className="flex flex-col gap-1 p-4">
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  {notification.read ? <Badge>既読</Badge> : <Badge tone="warn">未読</Badge>}
                  <span className="text-muted-foreground">{formatDateTime(notification.at)}</span>
                  <Link className="underline" to="/approvals">
                    承認待ち {notification.approvalId}
                  </Link>
                  {notification.managerId === undefined ? null : (
                    <Link className="underline" to={`/managers/${notification.managerId}`}>
                      {notification.managerId}
                    </Link>
                  )}
                </div>
                <p className="whitespace-pre-wrap break-words text-sm">{notification.question}</p>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </Page>
  );
}
