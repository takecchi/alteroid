import { LoadError } from '~/components/load-error';

import { Badge, Card, CardHeader, Empty, KeyValueList, Spinner } from '@alteroid/ui';
import { useJournal } from '@alteroid/swr';
import { formatDateTime } from '@alteroid/logic';
import type { TokenRotationEntry } from '@alteroid/logic';

import {
  describeEvent,
  describeFreshness,
  describeRecoveredSource,
  describeRotationReason,
  describeRotationSignal,
} from './tokens-describe';

// 打ち切ったら必ずそう書く: 黙って切り捨てないため
const JOURNAL_LIMIT = 50;

export function RotationHistory() {
  const { data, error, isLoading, isValidating, mutate } = useJournal(JOURNAL_LIMIT, [
    'token_rotation',
  ]);
  // type で狭める: GET /journal の型はサーバ側の絞り込みを反映せず、全種別の合併型のままのため
  const entries = (data?.entries ?? []).filter(
    (entry): entry is TokenRotationEntry => entry.type === 'token_rotation',
  );
  // 取れなかったのを0件と描かない: 失敗は LoadError が言うため
  const listUnavailable = data === undefined && error !== undefined;

  return (
    <Card>
      <CardHeader
        title="切り替えの履歴（エラー状況）"
        subtitle="トークンの切り替えの記録を新しい順に表示する。出来事は省かずに全部出す"
        action={data === undefined ? undefined : <Badge>{entries.length}</Badge>}
      />
      <LoadError
        what="切り替えの履歴"
        error={error}
        onRetry={() => mutate()}
        retrying={isValidating}
        className="m-4"
      />
      {isLoading ? (
        <Spinner />
      ) : listUnavailable ? null : entries.length === 0 ? (
        <Empty>切り替えの記録がまだ1件も無い。</Empty>
      ) : (
        <ul>
          {entries.map((entry) => (
            <RotationRow key={entry.id} entry={entry} />
          ))}
        </ul>
      )}
      {/* TruncationNote は使えない: GET /journal は総件数を返さず、あちらは正確な total が要るため */}
      {entries.length === JOURNAL_LIMIT && (
        <p className="border-t border-border px-4 py-2 text-[11px] text-muted-foreground">
          直近 {JOURNAL_LIMIT} 件のみ表示している。これより古い記録は、日誌の画面で
          トークンの切り替えの記録に絞り込んで確認する。
        </p>
      )}
    </Card>
  );
}

function RotationRow({ entry }: { entry: TokenRotationEntry }) {
  const event = describeEvent(entry.event, entry.freshness);

  return (
    <li className="border-b border-border px-4 py-3 last:border-b-0">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={event.tone}>{event.label}</Badge>
        <span className="text-xs text-muted-foreground">{formatDateTime(entry.at)}</span>
        {entry.signal !== undefined && (
          <span className="text-xs text-muted-foreground">
            きっかけ: {describeRotationSignal(entry.signal)}
          </span>
        )}
        {entry.freshness !== undefined && (
          <span className="text-xs text-muted-foreground">
            {describeFreshness(entry.freshness)}
          </span>
        )}
        {/* signal と畳まない: 畳むと「休止が明けたので見直した」と「記録の上で現役が通らない」が同じ顔になるため */}
        {entry.reason !== undefined && (
          <span className="text-xs text-muted-foreground">
            見直したきっかけ: {describeRotationReason(entry.reason)}
          </span>
        )}
        {/* recovered の行にだけ付ける: 無い回は「観測していない」であって「account_probe だった」ではないため */}
        {entry.recoveredSource !== undefined && (
          <span className="text-xs text-muted-foreground">
            {describeRecoveredSource(entry.recoveredSource)}
          </span>
        )}
      </div>

      <p className="mt-1 text-sm break-words whitespace-pre-wrap">{entry.text}</p>

      <KeyValueList
        className="mt-2"
        labelWidth="8rem"
        items={[
          ...(entry.label !== undefined ? [{ label: 'ラベル', value: entry.label }] : []),
          ...(entry.tokenId !== undefined
            ? [{ label: '移った先・渡した先', value: entry.tokenId, mono: true }]
            : []),
          ...(entry.fromTokenId !== undefined
            ? [{ label: '降りた側', value: entry.fromTokenId, mono: true }]
            : []),
          ...(entry.generation !== undefined ? [{ label: '世代', value: entry.generation }] : []),
          ...(entry.earliestAt !== undefined
            ? [
                // 見出しはどちらでも読める言い方にする: parked の回はこれが「撒いた鍵が通るようになる時刻」で、exhausted の同じ欄と意味が同じため
                { label: '最速の復帰見込み', value: formatDateTime(entry.earliestAt) },
              ]
            : []),
        ]}
      />

      {entry.noticeText !== undefined && (
        // 当たった文言は言い換えずそのまま出す: text の中にも出るが、整形が変わっても原文はこちらに残すため
        <p className="mt-2 font-mono text-[11px] break-words whitespace-pre-wrap text-muted-foreground">
          {entry.noticeText}
        </p>
      )}
    </li>
  );
}
