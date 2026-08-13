import { useState } from 'react';

import { Page } from '~/components/page';
import {
  Badge,
  Button,
  Card,
  CardHeader,
  Empty,
  ErrorNote,
  Input,
  Spinner,
  Textarea,
} from '~/components/ui';
import { usePostEvent, useRunSchedule } from '~/hooks/mutations';
import { useSchedule } from '~/hooks/queries';
import { formatDateTime, formatRelative } from '~/lib/format';

/**
 * 仕事の起点のうち、時間（②）と外部イベント（③）を人間から起こす画面。
 *
 * **これは「止まっているものを動かす」ボタンではない。** 日報も発意 tick も既定で
 * 回っている。ここにあるのは、待たずに確かめるための口である。
 */
export default function Schedule() {
  const { data, error, isLoading } = useSchedule();
  const runSchedule = useRunSchedule();
  const [running, setRunning] = useState<string | undefined>(undefined);
  const [failure, setFailure] = useState<unknown>(undefined);

  return (
    <Page title="スケジュールと外部イベント" description="時間起点と外部イベント起点を手で起こす">
      <ErrorNote error={error ?? failure} className="mb-4" />

      <Card className="mb-4">
        <CardHeader title="定期ジョブ" subtitle="既定で回っている。ここは待たずに試すための口" />
        {isLoading ? (
          <Spinner />
        ) : data === undefined || data.entries.length === 0 ? (
          <Empty>登録された定期ジョブが無い（`off` にしている可能性がある）。</Empty>
        ) : (
          <ul>
            {data.entries.map((entry) => (
              <li
                key={entry.kind}
                className="flex items-center gap-3 border-b border-border px-4 py-3 last:border-b-0"
              >
                <div className="min-w-0 flex-1">
                  <p className="text-sm">{entry.description}</p>
                  <p className="mt-0.5 font-mono text-[11px] text-muted">{entry.kind}</p>
                </div>
                <div className="shrink-0 text-right text-[11px] text-muted">
                  <p>{formatDateTime(entry.nextAt)}</p>
                  <Badge tone="accent">{formatRelative(entry.nextAt)}</Badge>
                </div>
                <Button
                  size="sm"
                  loading={running === entry.kind}
                  onClick={() => {
                    setRunning(entry.kind);
                    setFailure(undefined);
                    runSchedule(entry.kind)
                      .catch(setFailure)
                      .finally(() => setRunning(undefined));
                  }}
                >
                  今すぐ回す
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <EventForm />
    </Page>
  );
}

function EventForm() {
  const postEvent = usePostEvent();
  const [source, setSource] = useState('');
  const [payload, setPayload] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<string | undefined>(undefined);
  const [failure, setFailure] = useState<unknown>(undefined);

  function submit() {
    if (source.trim() === '') return;
    setBusy(true);
    setFailure(undefined);
    setSent(undefined);

    // JSON として読めればそのまま、読めなければ文字列として渡す。
    // ここで弾くと「送れない形」を画面が勝手に作ることになる。
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload) as unknown;
    } catch {
      parsed = payload;
    }

    postEvent(source, parsed)
      .then((result) => {
        setSent(result.id);
        setPayload('');
      })
      .catch(setFailure)
      .finally(() => setBusy(false));
  }

  return (
    <Card>
      <CardHeader
        title="外部イベントを流す"
        subtitle="MCP 経由の通知・CI の失敗・レビュー依頼を、人間の手で再現する"
      />
      <div className="flex flex-col gap-2 px-4 py-3">
        <Input
          value={source}
          placeholder="source（例: github, slack, ci）"
          onChange={(event) => setSource(event.target.value)}
        />
        <Textarea
          rows={4}
          value={payload}
          className="font-mono text-xs"
          placeholder="payload（JSON でも素のテキストでもよい）"
          onChange={(event) => setPayload(event.target.value)}
        />
        <div className="flex items-center gap-2">
          <Button variant="primary" loading={busy} disabled={source.trim() === ''} onClick={submit}>
            送る
          </Button>
          {sent !== undefined && (
            <span className="font-mono text-[11px] text-muted">受け付けた: {sent}</span>
          )}
        </div>
        <ErrorNote error={failure} />
      </div>
    </Card>
  );
}
