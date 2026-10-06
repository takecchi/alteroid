import { AlertTriangle } from 'lucide-react';
import { useMemo, useState } from 'react';

import { ApprovalEntry } from '~/components/approval-entry';
import { isApprovalAnswered, isApprovalWithdrawn } from '~/components/approval-answer-card';
import { ApprovalsTabs } from '~/components/group-tabs';
import { Page, Button, Card, Empty, ErrorNote, Spinner } from '@alteroid/ui';
import { useAnswerApprovals, useApprovals } from '@alteroid/swr';
import type { PendingApproval, UnreadableApproval } from '@alteroid/logic';

/** `Record` から1つの key を落とした新しい `Record` を作る（同じ参照は返さない）。 */
function without<T>(record: Record<string, T>, key: string): Record<string, T> {
  if (!(key in record)) return record;
  const next = { ...record };
  delete next[key];
  return next;
}

/**
 * 読めない承認待ちが在ることを、一覧の上で断る（issue #2298。commitments 画面の
 * `UnreadableNote` と同じ形）。**0件なら描かない**（0 の行を作らない）。
 *
 * id が取れない行は件数だけに数える。id の列挙には上限を置き、切ったら言う。
 * **「回答済みでも取り下げ済みでもない」を落とさない**——落とすと、行が消えたのと区別が付かない。
 */
const UNREADABLE_APPROVAL_IDS_SHOWN = 20;

function UnreadableApprovalNote({ unreadable }: { unreadable: UnreadableApproval[] }) {
  if (unreadable.length === 0) return null;
  const idsAll = unreadable.map((entry) => entry.id).filter((id): id is string => id != null);
  const ids = idsAll.slice(0, UNREADABLE_APPROVAL_IDS_SHOWN);
  const idsRest = idsAll.length - ids.length;
  return (
    <div
      role="status"
      className="mb-4 flex items-start gap-2 rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-sm text-warn"
    >
      <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
      <span className="min-w-0 break-words">
        読めない承認待ちが {unreadable.length} 件ある
        {ids.length > 0 &&
          `（id: ${ids.join(', ')}${idsRest > 0 ? ` …ほか ${idsRest} 件は省略` : ''}）`}
        。<strong>壊れた行であって、回答済みでも取り下げ済みでもない。</strong>
        この一覧には載っていない。
      </span>
    </div>
  );
}

export default function Approvals() {
  /**
   * **未回答だけを読む**（`GET /approvals?pending=true`）。回答済み・取り下げ済みは別のページ
   * （`approvals-answered.tsx`。タブの「回答済み」）で、日付ごとに読む。
   */
  const { data, error, isLoading } = useApprovals(true);
  /**
   * **形の違う応答（`approvals` が配列でない）は「0件」ではなく「読めていない」へ倒す**
   * （issue #2308。外枠 `shell.tsx` の PR #2307 と同じ判断）。デーモンと画面は別デプロイで
   * 版がずれうる。`data.approvals.length` のままだと `TypeError` で画面ごと落ち、
   * `?? []` で黙らせると読めていないのに「答えを待っているものはない」と言う。
   * 型は配列と言っているので、ここが守るのは実行時の倒れ先だけである。
   */
  const approvalsList: PendingApproval[] | undefined = Array.isArray(data?.approvals)
    ? data.approvals
    : undefined;
  const approvalsMalformed = data !== undefined && approvalsList === undefined;
  /**
   * **取れなかったのを0件と描かない**（issue #2313）。一覧をまだ一度も読めていないまま
   * 失敗したとき、失敗は上の `ErrorNote` が言う。ここで「答えを待っているものはない」を
   * 並べると、読めていないのに承認待ちが無いように読め、承認を見落とす。再検証の失敗で
   * `data` が残っているときは当たらず、一覧をそのまま出す（#2266 と同じ）。
   */
  const listUnavailable = data === undefined && error !== undefined;
  // `unreadable` は、読めない行が1件以上あるときだけ載る欄（#2298）。形が違えば無いものとして扱う
  // （読めた一覧まで巻き込んで落とさない）。
  const unreadable: UnreadableApproval[] = Array.isArray(data?.unreadable) ? data.unreadable : [];
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
    () =>
      new Set(
        (approvalsList ?? [])
          .filter((approval) => !isApprovalAnswered(approval) && !isApprovalWithdrawn(approval))
          .map((a) => a.id),
      ),
    [approvalsList],
  );
  const pendingDrafts = Object.entries(drafts).filter(
    ([id, text]) => text.trim() !== '' && unansweredIds.has(id),
  );

  async function submitBulk(): Promise<void> {
    if (pendingDrafts.length === 0) return;
    setBulkBusy(true);
    setBulkFailure(undefined);
    try {
      const results = await answerApprovals(pendingDrafts.map(([id, answer]) => ({ id, answer })));
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
      tabs={<ApprovalsTabs />}
      title="承認待ち"
      description="記憶に根拠が無かったこと。ここで答えると、同じ判断は次から聞かれなくなる"
    >
      <ErrorNote error={error} className="mb-4" />
      <UnreadableApprovalNote unreadable={unreadable} />

      {unansweredIds.size > 0 && (
        <div className="mb-4 flex flex-wrap items-center gap-3 rounded-md border border-border bg-card px-3 py-2">
          <span className="text-sm text-muted-foreground">
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
      ) : listUnavailable ? null : approvalsMalformed ? (
        // **0件と描かない**（issue #2308）。応答は届いたが、一覧の形をしていない。
        <ErrorNote
          error={
            new Error(
              '承認待ちの一覧が読めない形で届いた（サーバと画面の版がずれている可能性がある）。' +
                '答えを待っているものが無いという意味ではない。',
            )
          }
          className="mb-4"
        />
      ) : approvalsList === undefined || approvalsList.length === 0 ? (
        <Card>
          <Empty>
            {unreadable.length > 0
              ? '読めた範囲では、答えを待っているものはない。'
              : '答えを待っているものはない。クローンは進んでいる。'}
          </Empty>
        </Card>
      ) : (
        <ul className="flex flex-col gap-3" aria-label="承認待ちの一覧">
          {approvalsList.map((approval) => (
            <li key={approval.id}>
              <ApprovalEntry
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
