import { useMemo, useState } from 'react';

import { Page } from '~/components/page';
import { Badge, Button, Card, Empty, ErrorNote, Spinner, Textarea } from '~/components/ui';
import { useAnswerApproval, useAnswerApprovals } from '~/hooks/mutations';
import { useApprovals } from '~/hooks/queries';
import { formatDateTime, formatRelative } from '~/lib/format';
import type { PendingApproval } from '~/lib/types';

function isAnswered(approval: PendingApproval): boolean {
  return approval.answeredAt !== undefined && approval.answeredAt !== null;
}

/** `Record` から1つの key を落とした新しい `Record` を作る（同じ参照は返さない）。 */
function without<T>(record: Record<string, T>, key: string): Record<string, T> {
  if (!(key in record)) return record;
  const next = { ...record };
  delete next[key];
  return next;
}

export default function Approvals() {
  const [showAnswered, setShowAnswered] = useState(false);
  const { data, error, isLoading } = useApprovals(!showAnswered);
  const answerApprovals = useAnswerApprovals();

  /**
   * 各カードの下書き。**カードをまたいで持つのは「まとめて送る」の対象を決める
   * ためである。** 個別の「回答する」「許可」「却下」ボタンはこの下書きを直接見て
   * 動くので、1件ずつ内容を見て別々に答える自由はそのまま残る — まとめて送るのは
   * 「書かれた分をまとめて1回で送る」だけの追加であって、答え方を変えない。
   */
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  /** 直前のまとめ送信で駄目だった id ごとの理由。カードの下に出す。 */
  const [bulkErrors, setBulkErrors] = useState<Record<string, string>>({});
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkFailure, setBulkFailure] = useState<unknown>(undefined);

  function setDraft(id: string, text: string): void {
    setDrafts((current) => ({ ...current, [id]: text }));
  }

  function clearDraft(id: string): void {
    setDrafts((current) => without(current, id));
    setBulkErrors((current) => without(current, id));
  }

  // 今読み込めている未回答の一覧に実在するものだけを対象にする。別経路で
  // 先に片付いた下書きを、まとめ送信の対象へ混ぜないため。
  const unansweredIds = useMemo(
    () => new Set((data?.approvals ?? []).filter((approval) => !isAnswered(approval)).map((a) => a.id)),
    [data],
  );
  const pendingDrafts = Object.entries(drafts).filter(
    ([id, text]) => text.trim() !== '' && unansweredIds.has(id),
  );

  async function submitBulk(): Promise<void> {
    if (pendingDrafts.length === 0) return;
    setBulkBusy(true);
    setBulkFailure(undefined);
    try {
      const results = await answerApprovals(
        pendingDrafts.map(([id, answer]) => ({ id, answer })),
      );
      const nextErrors: Record<string, string> = {};
      for (const result of results) {
        if (result.ok) {
          clearDraft(result.id);
        } else {
          nextErrors[result.id] = result.error ?? '不明な失敗';
        }
      }
      if (Object.keys(nextErrors).length > 0) {
        setBulkErrors((current) => ({ ...current, ...nextErrors }));
      }
    } catch (caught) {
      // 通信そのものが失敗した場合（サーバへ届いていない）。個々の id の成否は
      // まだ分からないので、下書きは消さずに残す。
      setBulkFailure(caught);
    } finally {
      setBulkBusy(false);
    }
  }

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

      {unansweredIds.size > 0 && (
        <div className="mb-4 flex flex-wrap items-center gap-3 rounded-md border border-border bg-surface px-3 py-2">
          <span className="text-sm text-muted">
            {pendingDrafts.length === 0
              ? 'まとめて送る答えはまだ書かれていない（各カードに書くとここに数が出る）'
              : `${pendingDrafts.length} 件に答えを書いた（送るとまとめて1回で届く）`}
          </span>
          <Button
            variant="primary"
            size="sm"
            loading={bulkBusy}
            disabled={pendingDrafts.length === 0}
            onClick={() => void submitBulk()}
          >
            まとめて送る
          </Button>
        </div>
      )}
      <ErrorNote error={bulkFailure} className="mb-4" />

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
              <ApprovalCard
                approval={approval}
                draft={drafts[approval.id] ?? ''}
                onDraftChange={(text) => setDraft(approval.id, text)}
                onAnswered={() => clearDraft(approval.id)}
                bulkError={bulkErrors[approval.id]}
              />
            </li>
          ))}
        </ul>
      )}
    </Page>
  );
}

function ApprovalCard({
  approval,
  draft,
  onDraftChange,
  onAnswered,
  bulkError,
}: {
  approval: PendingApproval;
  /** まとめて送るための下書き。親が持つので、カードをまたいで数えられる。 */
  draft: string;
  onDraftChange: (text: string) => void;
  /** この id に答えが通った（個別送信・まとめ送信どちらでも呼ぶ）。 */
  onAnswered: () => void;
  /** 直前のまとめ送信でこの id が駄目だった理由（無ければ何も出さない）。 */
  bulkError?: string;
}) {
  const answerApproval = useAnswerApproval();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(undefined);

  const answered = isAnswered(approval);

  async function submit(text: string) {
    if (text.trim() === '') return;
    setBusy(true);
    setFailure(undefined);
    try {
      await answerApproval(approval.id, text);
      onAnswered();
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
            value={draft}
            placeholder="答える（書いておくと「まとめて送る」の対象になる。この場ですぐ送ってもよい）"
            onChange={(event) => onDraftChange(event.target.value)}
            onKeyDown={(event) => {
              // 長文になりうるので Enter は改行のまま。送信は Cmd/Ctrl+Enter。
              if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                event.preventDefault();
                void submit(draft);
              }
            }}
          />
          <div className="mt-2 flex items-center gap-2">
            <Button
              variant="primary"
              size="sm"
              loading={busy}
              disabled={draft.trim() === ''}
              onClick={() => void submit(draft)}
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
      {bulkError !== undefined && (
        <ErrorNote error={`まとめて送った回答は通らなかった: ${bulkError}`} className="mt-2" />
      )}
    </Card>
  );
}
