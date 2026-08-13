import { useState } from 'react';
import { Link, useNavigate } from 'react-router';

import { Page } from '~/components/page';
import { Badge, Button, Card, CardHeader, Empty, ErrorNote, Input, Spinner } from '~/components/ui';
import { useAbortManager, useSendManagerMessage } from '~/hooks/mutations';
import { useManager, useManagerTranscript } from '~/hooks/queries';
import { formatDateTime, formatRelative } from '~/lib/format';

import type { Route } from './+types/manager-detail';
import { ManagerStatusBadge } from './managers';

export function clientLoader({ params }: Route.ClientLoaderArgs) {
  return { id: params.id };
}

export default function ManagerDetail({ loaderData }: Route.ComponentProps) {
  const { id } = loaderData;
  const { data, error, isLoading } = useManager(id);
  const navigate = useNavigate();
  const abortManager = useAbortManager();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(undefined);

  const manager = data?.manager;

  return (
    <Page
      title={
        <span className="flex items-center gap-2">
          <Link to="/managers" className="text-muted hover:text-fg">
            マネージャー
          </Link>
          <span className="text-muted">/</span>
          <span className="font-mono text-sm">{id}</span>
        </span>
      }
      description={manager?.request}
      action={
        manager !== undefined &&
        (manager.status === 'running' || manager.status === 'waiting_human') ? (
          <Button
            variant="danger"
            size="sm"
            loading={busy}
            onClick={() => {
              setBusy(true);
              setFailure(undefined);
              // 本文が要る（サーバ側に json バリデータが付いている）。
              abortManager(id, '人間が画面から停止した')
                .then(() => navigate('/managers'))
                .catch(setFailure)
                .finally(() => setBusy(false));
            }}
          >
            停止する
          </Button>
        ) : undefined
      }
    >
      <ErrorNote error={error ?? failure} className="mb-4" />

      {isLoading ? (
        <Spinner />
      ) : manager === undefined ? (
        <Card>
          <Empty>見つからない。</Empty>
        </Card>
      ) : (
        <div className="flex flex-col gap-4">
          <Card>
            <CardHeader title="状態" />
            <dl className="grid grid-cols-[8rem_1fr] gap-y-1.5 px-4 py-3 text-sm">
              <dt className="text-muted">状態</dt>
              <dd className="flex items-center gap-2">
                <ManagerStatusBadge status={manager.status} />
                {manager.live && <Badge tone="ok">接続あり</Badge>}
              </dd>
              <dt className="text-muted">作業ディレクトリ</dt>
              <dd className="font-mono text-xs break-all">{manager.cwd}</dd>
              <dt className="text-muted">開始</dt>
              <dd>
                {formatDateTime(manager.startedAt)}（{formatRelative(manager.startedAt)}）
              </dd>
              <dt className="text-muted">更新</dt>
              <dd>
                {formatDateTime(manager.updatedAt)}（{formatRelative(manager.updatedAt)}）
              </dd>
              {manager.runnerId !== undefined && manager.runnerId !== null && (
                <>
                  <dt className="text-muted">runner</dt>
                  <dd className="font-mono text-xs">{manager.runnerId}</dd>
                </>
              )}
              {manager.sessionId !== undefined && manager.sessionId !== null && (
                <>
                  <dt className="text-muted">セッション</dt>
                  <dd className="font-mono text-xs break-all">{manager.sessionId}</dd>
                </>
              )}
            </dl>
          </Card>

          {manager.waiting.length > 0 && (
            <Card>
              <CardHeader
                title="このマネージャーが待っていること"
                subtitle="答えるまでこの仕事だけが止まる"
              />
              <ul>
                {manager.waiting.map((request) => (
                  <li key={request.requestId} className="border-b border-border last:border-b-0">
                    <WaitingRow id={id} requestId={request.requestId} summary={request.summary} />
                  </li>
                ))}
              </ul>
            </Card>
          )}

          {manager.lastReport !== undefined && manager.lastReport !== null && (
            <Card>
              <CardHeader title="最後の報告" />
              <div className="px-4 py-3 text-sm whitespace-pre-wrap">{manager.lastReport}</div>
            </Card>
          )}

          <SendMessage id={id} />
          <Transcript id={id} />
        </div>
      )}
    </Page>
  );
}

function WaitingRow({
  id,
  requestId,
  summary,
}: {
  id: string;
  requestId: string;
  summary: string;
}) {
  const send = useSendManagerMessage();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(undefined);

  function answer(decision: 'allow' | 'deny') {
    setBusy(true);
    setFailure(undefined);
    send(id, {
      text: decision === 'allow' ? '許可する' : '許可しない',
      requestId,
      decision,
    })
      .catch(setFailure)
      .finally(() => setBusy(false));
  }

  return (
    <div className="px-4 py-3">
      <p className="text-sm">{summary}</p>
      <div className="mt-2 flex items-center gap-2">
        <Button size="sm" variant="primary" loading={busy} onClick={() => answer('allow')}>
          許可
        </Button>
        <Button size="sm" variant="danger" disabled={busy} onClick={() => answer('deny')}>
          拒否
        </Button>
      </div>
      <ErrorNote error={failure} className="mt-2" />
    </div>
  );
}

function SendMessage({ id }: { id: string }) {
  const send = useSendManagerMessage();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<string | undefined>(undefined);
  const [failure, setFailure] = useState<unknown>(undefined);

  function submit() {
    if (text.trim() === '') return;
    setBusy(true);
    setFailure(undefined);
    send(id, { text })
      .then((result) => {
        setOutcome(`${result.outcome}: ${result.detail}`);
        setText('');
      })
      .catch(setFailure)
      .finally(() => setBusy(false));
  }

  return (
    <Card>
      <CardHeader title="話しかける" subtitle="走行中のマネージャーに追加の指示を割り込ませる" />
      <div className="px-4 py-3">
        <div className="flex gap-2">
          <Input
            value={text}
            placeholder="追加の指示"
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') submit();
            }}
          />
          <Button variant="primary" loading={busy} disabled={text.trim() === ''} onClick={submit}>
            送る
          </Button>
        </div>
        {outcome !== undefined && <p className="mt-2 text-xs text-muted">{outcome}</p>}
        <ErrorNote error={failure} className="mt-2" />
      </div>
    </Card>
  );
}

/**
 * 生ログ。
 *
 * 日誌で足りないときの最後の拠り所（PRD 可観測性の3層目）なので、要約せずに
 * そのまま出す。既定では畳んでおく — 長いため。
 */
function Transcript({ id }: { id: string }) {
  const [open, setOpen] = useState(false);
  // 開くまで取りに行かない（長いので、見たいと言われてから読む）。
  const { data, error, isLoading } = useManagerTranscript(open ? id : null);

  return (
    <Card>
      <CardHeader
        title="セッションログ（生）"
        subtitle="compaction で潰される前の全文"
        action={
          <Button size="sm" onClick={() => setOpen((value) => !value)}>
            {open ? '閉じる' : '開く'}
          </Button>
        }
      />
      {open && (
        <div className="px-4 py-3">
          <ErrorNote error={error} />
          {isLoading ? (
            <Spinner />
          ) : (
            <pre className="max-h-[32rem] overflow-auto rounded border border-border bg-bg p-2 text-[11px] text-muted">
              {data === undefined || data === '' ? '(空)' : data}
            </pre>
          )}
        </div>
      )}
    </Card>
  );
}
