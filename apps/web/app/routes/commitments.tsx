import { useState } from 'react';

import { Page } from '~/components/page';
import { Badge, Button, Card, CardHeader, Empty, ErrorNote, Input, Spinner } from '~/components/ui';
import { useCloseCommitment, usePushCommitment } from '~/hooks/mutations';
import { useCommitments } from '~/hooks/queries';
import type { Commitment, CommitmentOrigin } from '@alteroid/core';
import { formatDateTime, formatRelative } from '~/lib/format';

/**
 * 引き受けたまま終わっていない仕事の台帳（`packages/core/src/schema.ts` の
 * `commitmentSchema`）。CLI の `/commitments` `/commit` `/done` と同じものを見る。
 *
 * **承認待ちの画面とは別のものである。** あちらは「クローンが人間の答えを待って
 * 止まっている」で、こちらは「頼まれたことがまだ片付いていない」。止まっていなくても
 * 片付いていない仕事はあるので、片方で他方は代用できない。
 *
 * **器が持つのは「何を頼まれたか」と「まだ片付いていない」の2値だけである。**
 * 順序も優先度も締切も持たない（判断はクローンと人間に残す）ので、この画面にも
 * 並べ替えや優先度の札を足さないこと — 足した瞬間に「やることの一覧」になる。
 */
export default function Commitments() {
  const [showClosed, setShowClosed] = useState(false);
  const { data, error, isLoading } = useCommitments(showClosed);

  // 並びはデーモンが決めている（未了が古い順、片付いたものが新しい順で後ろ）。
  // **ここで並べ直さない** — 並べ直すと齢の見え方が CLI・クローンと食い違う。
  const all = data?.entries ?? [];
  const open = all.filter((commitment) => !isClosed(commitment));
  const closed = all.filter(isClosed);

  return (
    <Page
      title="引き受けたまま終わっていない仕事"
      description="受信箱でも日誌でもここには残らない。忘れさせないための器であって、やることの一覧ではない"
      action={
        <Button size="sm" onClick={() => setShowClosed((v) => !v)}>
          {showClosed ? '未了だけ' : '片付けたものも見る'}
        </Button>
      }
    >
      <ErrorNote error={error} className="mb-4" />

      <PushForm />

      {isLoading ? (
        <Spinner />
      ) : (
        <>
          <Card className="mb-4">
            <CardHeader
              title="未了"
              subtitle="古い順。齢がそのまま「どれだけ放置されているか」である"
            />
            {open.length === 0 ? (
              <Empty>引き受けたまま終わっていない仕事はない。</Empty>
            ) : (
              <ul>
                {open.map((commitment) => (
                  <OpenRow key={commitment.id} commitment={commitment} />
                ))}
              </ul>
            )}
          </Card>

          {/*
            片付けたものは、押されたときだけ取りに行く。器は行を消さないので
            （「何を片付けたか」は日報の材料である）、読む手立てを画面にも置く。
          */}
          {showClosed && (
            <Card>
              <CardHeader
                title="片付いたもの"
                subtitle="新しい順。何をもって終わりとしたかを残す"
              />
              {closed.length === 0 ? (
                <Empty>片付いた記録はまだない。</Empty>
              ) : (
                <ul>
                  {closed.map((commitment) => (
                    <ClosedRow key={commitment.id} commitment={commitment} />
                  ))}
                </ul>
              )}
            </Card>
          )}
        </>
      )}
    </Page>
  );
}

function isClosed(commitment: Commitment): boolean {
  return commitment.closedAt !== undefined && commitment.closedAt !== null;
}

/**
 * その未了が何から生まれたか。
 *
 * **「誰が言ったか」ではなく「どの起点から来たか」である**（`schema.ts` の
 * `commitmentOriginSchema`）。人間との約束か自分で思い立ったことかで、
 * 取り返しのつかなさも急ぎ方も変わる。
 */
const ORIGIN_LABEL: Record<CommitmentOrigin, string> = {
  human: '人間',
  manager: 'マネージャー',
  external: '外部',
  self: '自分',
};

function OriginBadge({ commitment }: { commitment: Commitment }) {
  return (
    <Badge tone={commitment.origin === 'human' ? 'accent' : 'neutral'}>
      {ORIGIN_LABEL[commitment.origin]}
      {commitment.source !== undefined && commitment.source !== null && ` / ${commitment.source}`}
    </Badge>
  );
}

function OpenRow({ commitment }: { commitment: Commitment }) {
  const closeCommitment = useCloseCommitment();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(undefined);

  async function submit() {
    if (reason.trim() === '') return;
    setBusy(true);
    setFailure(undefined);
    try {
      await closeCommitment(commitment.id, reason.trim());
      // 成功したら一覧から消えるので、入力を戻す必要はない（部品ごと消える）。
    } catch (caught) {
      setFailure(caught);
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="border-b border-border px-4 py-3 last:border-b-0">
      <div className="mb-1.5 flex flex-wrap items-center gap-2 text-[11px] text-muted">
        <OriginBadge commitment={commitment} />
        <span>{formatDateTime(commitment.at)}</span>
        {/* 齢。器は優先度も締切も持たないので、急ぎ方を決める材料はこれだけである。 */}
        <span>({formatRelative(commitment.at)})</span>
      </div>

      {/* 本文は器が全文を持つ（要約を持たせない）。畳まずにそのまま出す。 */}
      <p className="text-sm leading-relaxed whitespace-pre-wrap">{commitment.body}</p>

      <div className="mt-2 flex items-center gap-2">
        <Input
          value={reason}
          placeholder="何をもって片付いたか（後から否定できるように残す）"
          onChange={(event) => setReason(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              void submit();
            }
          }}
        />
        <Button
          variant="primary"
          size="sm"
          className="shrink-0"
          loading={busy}
          // **理由なしでは閉じられない。** 「閉じた」だけが残ると、人間が後から
          // 否定できない（north_star の最終承認はそこで成り立っている）。
          disabled={reason.trim() === ''}
          onClick={() => void submit()}
        >
          片付いた
        </Button>
      </div>

      <ErrorNote error={failure} className="mt-2" />
    </li>
  );
}

function ClosedRow({ commitment }: { commitment: Commitment }) {
  return (
    <li className="border-b border-border px-4 py-3 text-muted last:border-b-0">
      <div className="mb-1.5 flex flex-wrap items-center gap-2 text-[11px]">
        <Badge tone="ok">片付いた</Badge>
        <OriginBadge commitment={commitment} />
        <span>
          {formatDateTime(commitment.at)} → {formatDateTime(commitment.closedAt ?? '')}
        </span>
      </div>
      <p className="text-sm leading-relaxed whitespace-pre-wrap">{commitment.body}</p>
      {commitment.closedReason !== undefined && commitment.closedReason !== null && (
        <p className="mt-1 text-xs">
          <span className="mr-2 text-[11px]">どう片付いたか</span>
          {commitment.closedReason}
        </p>
      )}
    </li>
  );
}

/**
 * 人間の手で積む口。
 *
 * **読めるだけにしない。** 積みたい場面はたいてい「いま言ったことを忘れられたら
 * 困る」ときなので、クローンのターンを1回起こさないと書けないのは重い。
 * CLI の `/commit` と同じ経路である（片方でしかできないことを作らない）。
 */
function PushForm() {
  const pushCommitment = usePushCommitment();
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(undefined);

  async function submit() {
    if (body.trim() === '') return;
    setBusy(true);
    setFailure(undefined);
    try {
      await pushCommitment(body.trim());
      setBody('');
    } catch (caught) {
      setFailure(caught);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="mb-4">
      <CardHeader title="台帳へ積む" subtitle="引き受けたことを、片付くまで残す" />
      <div className="flex flex-col gap-2 px-4 py-3">
        <Input
          value={body}
          placeholder="何を引き受けたか（全文で書く。切るのは一覧側の仕事）"
          onChange={(event) => setBody(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              void submit();
            }
          }}
        />
        <div>
          <Button
            variant="primary"
            loading={busy}
            disabled={body.trim() === ''}
            onClick={() => void submit()}
          >
            積む
          </Button>
        </div>
        <ErrorNote error={failure} />
      </div>
    </Card>
  );
}
