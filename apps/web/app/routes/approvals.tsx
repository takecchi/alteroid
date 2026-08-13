import { useState } from 'react';

import { Page } from '~/components/page';
import { Badge, Button, Card, Empty, ErrorNote, Spinner, Textarea } from '~/components/ui';
import { useAnswerApproval } from '~/hooks/mutations';
import { useApprovals } from '~/hooks/queries';
import { formatDateTime, formatRelative } from '~/lib/format';
import type { PendingApproval } from '~/lib/types';

export default function Approvals() {
  const [showAnswered, setShowAnswered] = useState(false);
  const { data, error, isLoading } = useApprovals(!showAnswered);

  return (
    <Page
      title="承認待ち"
      description="記憶に根拠が無かったこと。ここで答えると、同じ判断は次から聞かれなくなる"
      action={
        <Button size="sm" onClick={() => setShowAnswered((v) => !v)}>
          {showAnswered ? '未回答だけ' : '回答済みも見る'}
        </Button>
      }
    >
      <ErrorNote error={error} className="mb-4" />
      {isLoading ? (
        <Spinner />
      ) : data === undefined || data.approvals.length === 0 ? (
        <Card>
          <Empty>
            {showAnswered
              ? '記録がまだない。'
              : '答えを待っているものはない。クローンは進んでいる。'}
          </Empty>
        </Card>
      ) : (
        <ul className="flex flex-col gap-3">
          {data.approvals.map((approval) => (
            <li key={approval.id}>
              <ApprovalCard approval={approval} />
            </li>
          ))}
        </ul>
      )}
    </Page>
  );
}

function ApprovalCard({ approval }: { approval: PendingApproval }) {
  const answerApproval = useAnswerApproval();
  const [answer, setAnswer] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(undefined);

  const answered = approval.answeredAt !== undefined && approval.answeredAt !== null;

  async function submit(text: string) {
    if (text.trim() === '') return;
    setBusy(true);
    setFailure(undefined);
    try {
      await answerApproval(approval.id, text);
      setAnswer('');
    } catch (caught) {
      setFailure(caught);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="p-4">
      <div className="mb-2 flex items-center gap-2 text-[11px] text-muted">
        <Badge tone={answered ? 'neutral' : 'warn'}>{answered ? '回答済' : '未回答'}</Badge>
        <span>{formatDateTime(approval.createdAt)}</span>
        <span>({formatRelative(approval.createdAt)})</span>
        {approval.jobId !== undefined && approval.jobId !== null && (
          <span className="font-mono">job {approval.jobId}</span>
        )}
      </div>

      <p className="text-sm leading-relaxed whitespace-pre-wrap">{approval.question}</p>

      {approval.context !== undefined && approval.context !== null && approval.context !== '' && (
        <pre className="mt-2 max-h-48 overflow-y-auto rounded border border-border bg-bg p-2 text-xs text-muted">
          {approval.context}
        </pre>
      )}

      {answered ? (
        <p className="mt-3 rounded border border-border bg-bg p-2 text-sm">
          <span className="mr-2 text-[11px] text-muted">回答</span>
          {approval.answer}
        </p>
      ) : (
        <div className="mt-3">
          <Textarea
            rows={2}
            value={answer}
            placeholder="答える（この判断は記憶に残り、次の判断の材料になる）"
            onChange={(event) => setAnswer(event.target.value)}
            onKeyDown={(event) => {
              // 長文になりうるので Enter は改行のまま。送信は Cmd/Ctrl+Enter。
              if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                event.preventDefault();
                void submit(answer);
              }
            }}
          />
          <div className="mt-2 flex items-center gap-2">
            <Button
              variant="primary"
              size="sm"
              loading={busy}
              disabled={answer.trim() === ''}
              onClick={() => void submit(answer)}
            >
              回答する
            </Button>
            <Button size="sm" disabled={busy} onClick={() => void submit('はい、進めてよい')}>
              許可
            </Button>
            <Button size="sm" disabled={busy} onClick={() => void submit('いいえ、やらないで')}>
              却下
            </Button>
            <span className="text-[11px] text-muted">⌘/Ctrl + Enter</span>
          </div>
        </div>
      )}

      <ErrorNote error={failure} className="mt-2" />
    </Card>
  );
}
