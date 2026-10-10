import { WorkTabs } from '~/components/group-tabs';
import { LoadError } from '~/components/load-error';
import { useReportDirty, LeaveGuardScope } from '~/lib/leave-guard';
import { useLatest } from '~/lib/use-latest';
import { formatRelativeAtMinute, useMinuteNow } from '~/lib/use-now';
import { unsentInput } from '~/lib/unsent-input';
import { Fragment, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Tabs } from 'radix-ui';
import { Link, useLocation, useSearchParams } from 'react-router';

import {
  Markdown,
  Page,
  Badge,
  Button,
  Card,
  CardHeader,
  CodeBlock,
  ConfirmDialog,
  Empty,
  ErrorNote,
  FieldHint,
  Input,
  Spinner,
  SubmitHint,
  Textarea,
  WarnNote,
  cn,
  useKeyboardHintsVisible,
} from '@alteroid/ui';
import {
  CommitmentConflictError,
  useCloseCommitment,
  useEditCommitment,
  usePushCommitment,
  useCommitments,
  ApiError,
  useConversation,
  useConversations,
} from '@alteroid/swr';
import { formatDateTime, redactBody } from '@alteroid/logic';
import type { CommitmentClosedBy, CommitmentOrigin, TextMarkup } from '@alteroid/core';
import type { Commitment, UnreadableCommitment, UnreadableJob } from '@alteroid/logic';

/** 並べ替えや優先度の札を足さない: 足すと「やることの一覧」になってしまうため。 */
export default function Commitments() {
  const { pathname } = useLocation();
  return (
    <LeaveGuardScope staysOn={(next) => next === pathname}>
      <CommitmentsPage />
    </LeaveGuardScope>
  );
}

const CLOSED_PARAM = 'closed';
const RAW_VALUE_MAX = 40;

function clipRawValue(raw: string): string {
  const chars = Array.from(raw);
  return chars.length > RAW_VALUE_MAX ? `${chars.slice(0, RAW_VALUE_MAX).join('')}…` : raw;
}

function CommitmentsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const rawClosed = searchParams.get(CLOSED_PARAM);
  const showClosed = rawClosed === '1';
  const invalidClosed =
    rawClosed !== null && rawClosed !== '' && rawClosed !== '1' ? rawClosed : null;
  const duplicateClosed = searchParams.getAll(CLOSED_PARAM).length > 1;
  const toggleClosed = () =>
    setSearchParams(
      (previous) => {
        const params = new URLSearchParams(previous);
        if (showClosed) params.delete(CLOSED_PARAM);
        else params.set(CLOSED_PARAM, '1');
        return params;
      },
      { replace: true },
    );
  const { data, error, isLoading, isValidating, mutate } = useCommitments(showClosed);

  // ここで並べ直さない: 並べ直すと齢の見え方が CLI・クローンと食い違う。
  const all = data?.entries ?? [];
  const open = all.filter((commitment) => !isClosed(commitment));
  const closed = all.filter(isClosed);
  const unreadable = data?.unreadable ?? [];
  const trimmedClosed = data?.trimmedClosed ?? 0;
  // 取れなかったのを0件と描かない: 読めていないのに「仕事はない」と読めてしまうため。
  const listUnavailable = data === undefined && error !== undefined;

  // 行が裏で片付いて一覧から外れると OpenRow ごと unmount され、書きかけも 409 の本文も消えるので、ここへも写す。
  const [notes, setNotes] = useState<Readonly<Record<string, RowNote>>>({});
  const track = useCallback((commitment: Commitment, patch: RowNotePatch) => {
    setNotes((current) => {
      const before = current[commitment.id];
      const merged: RowNote = { ...before, ...patch, commitment };
      if (isEmptyNote(merged)) {
        if (before === undefined) return current;
        return withoutKey(current, commitment.id);
      }
      if (before !== undefined && sameNote(before, merged)) return current;
      return { ...current, [commitment.id]: merged };
    });
  }, []);
  const [settling, setSettling] = useState<ReadonlySet<string>>(new Set());
  const markSettling = useCallback((id: string, on: boolean) => {
    setSettling((current) => {
      if (current.has(id) === on) return current;
      const next = new Set(current);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);
  const dismissNote = useCallback((id: string) => {
    setNotes((current) => withoutKey(current, id));
  }, []);
  // 一覧を読めているときだけ外れたと見る: 読み込み中・失敗で空に見えるだけのときに、書きかけを断りへ変えないため。
  const orphans = (() => {
    if (data === undefined) return [];
    const openIds = new Set([...open.map((c) => c.id), ...unreadable.map((u) => u.id)]);
    return Object.values(notes)
      .filter((note) => !openIds.has(note.commitment.id) && !settling.has(note.commitment.id))
      .map((note) => ({ note, current: all.find((c) => c.id === note.commitment.id) }));
  })();

  return (
    <Page
      tabs={<WorkTabs />}
      title="未了の仕事"
      description="受信箱でも日誌でもここには残らない。忘れさせないための場所であって、やることの一覧ではない"
      action={
        <Button size="sm" onClick={toggleClosed}>
          {showClosed ? '未了だけ' : '片付けたものも見る'}
        </Button>
      }
    >
      <LoadError
        what="未了の仕事の一覧"
        error={error}
        onRetry={() => mutate()}
        retrying={isValidating}
        className="mb-4"
      />

      {invalidClosed !== null && (
        <p className="mb-4 text-xs text-warn">
          {`指定された値（${clipRawValue(invalidClosed)}）は読めないので、未了だけで表示しています`}
        </p>
      )}
      {duplicateClosed && (
        <p className="mb-4 text-xs text-warn">
          「片付けたものも見る」の指定が複数あるので、先頭の値を使っています
        </p>
      )}

      <PushForm />

      {isLoading && data === undefined ? (
        <Spinner />
      ) : listUnavailable ? null : (
        <>
          <UnreadableNote unreadable={unreadable} onTrack={track} onSettling={markSettling} />
          <UnreadableJobsNote unreadableJobs={data?.unreadableJobs ?? []} />
          <TrimmedClosedNote trimmedClosed={trimmedClosed} />

          <OrphanNotes orphans={orphans} onDismiss={dismissNote} />

          <Card className="mb-4">
            <div data-open-list-header="">
              <CardHeader
                title="未了"
                subtitle="古い順。齢がそのまま「どれだけ放置されているか」である"
              />
            </div>
            {open.length === 0 ? (
              <Empty>
                {unreadable.length > 0 || (data?.unreadableJobs ?? []).length > 0
                  ? '読めた範囲では、未了の仕事はない。'
                  : '未了の仕事はない。'}
              </Empty>
            ) : (
              <ul>
                {open.map((commitment) => (
                  <OpenRow
                    key={commitment.id}
                    commitment={commitment}
                    onTrack={track}
                    onSettling={markSettling}
                  />
                ))}
              </ul>
            )}
          </Card>

          {showClosed && (
            <Card>
              <CardHeader
                title="完了した仕事"
                subtitle="新しい順。何をもって終わりとしたかを残す"
              />
              {closed.length === 0 && isLoading ? (
                // 閉じた分の初回読み込み中は前のキー（未了だけ）の一覧が data に載っている: ここで「記録はまだない」と言うと、読めていないのに無いと読める。
                <Spinner />
              ) : closed.length === 0 && error !== undefined ? null : closed.length === 0 ? (
                <Empty>
                  {trimmedClosed > 0
                    ? '残っている範囲に、完了した仕事の記録はない。'
                    : unreadable.length > 0
                      ? // 読めない行は片付いた行かもしれないので、完了の側も言い切れない。
                        '読めた範囲では、完了した仕事の記録はない。'
                      : '完了した仕事の記録はまだない。'}
                </Empty>
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

const UNREADABLE_IDS_SHOWN = 20;

// 「無い」でも「片付いた」でもない第3の状態を `Empty` の顔にしない: `Empty` は「無い」を表す部品なので、読めない行を混ぜると「特に何も無い」に見えるため。
// 0件なら描かない: 常に出る断りは、出ていることが情報にならない。
function UnreadableNote({
  unreadable,
  onTrack,
  onSettling,
}: {
  unreadable: UnreadableCommitment[];
  onTrack: (commitment: Commitment, patch: RowNotePatch) => void;
  onSettling: (id: string, on: boolean) => void;
}) {
  // 閉じる入口は未了の一覧に載る id にだけ出す: 閉じた読めない行は閉じたかが公開されず、閉じようとすると必ず 409 になるため。
  const unclosed = useCommitments(false).data?.unreadable;
  if (unreadable.length === 0) return null;
  const idsAll = unreadable.map((entry) => entry.id).filter((id): id is string => id != null);
  const ids = idsAll.slice(0, UNREADABLE_IDS_SHOWN);
  const idsRest = idsAll.length - ids.length;
  const closable = idsAll
    .filter((id) => unclosed?.some((entry) => entry.id === id))
    .slice(0, UNREADABLE_IDS_SHOWN);
  return (
    <WarnNote className="mb-4" block>
      読めない行が {unreadable.length} 件ある
      {ids.length > 0 &&
        `（id: ${ids.join(', ')}${idsRest > 0 ? ` …ほか ${idsRest} 件は省略` : ''}）`}
      。<strong>片付いたのではない。</strong>
      {closable.length > 0 && (
        <>
          <p className="mt-2 text-xs">
            閉じても中身は読めないままなので、「片付けたものも見る」に本文は出ない。
          </p>
          <ul>
            {closable.map((id) => (
              <UnreadableClose key={id} id={id} onTrack={onTrack} onSettling={onSettling} />
            ))}
          </ul>
        </>
      )}
    </WarnNote>
  );
}

function UnreadableClose({
  id,
  onTrack,
  onSettling,
}: {
  id: string;
  onTrack: (commitment: Commitment, patch: RowNotePatch) => void;
  onSettling: (id: string, on: boolean) => void;
}) {
  // 毎回作り直すと RowNote の写しが更新され続けるので固定する。
  const stub = useMemo<Commitment>(
    () => ({ id, at: '', updatedAt: '', origin: 'self', body: `読めない行 ${id}` }),
    [id],
  );
  const rowRef = useRef<HTMLLIElement>(null);
  return (
    <li ref={rowRef}>
      <CloseReasonForm
        commitment={stub}
        label={id}
        onTrack={onTrack}
        onSettling={onSettling}
        planFocus={() => planFocusAfterRemoval(rowRef.current, 'input')}
      />
    </li>
  );
}

// 行には何も足さず一覧の上で1回だけ断る: どの行に紐づくかは委譲の行が壊れていて言えず、推測で紐づけないため。
function UnreadableJobsNote({ unreadableJobs }: { unreadableJobs: readonly UnreadableJob[] }) {
  if (unreadableJobs.length === 0) return null;
  const idsAll = unreadableJobs.map((entry) => entry.id).filter((id): id is string => id != null);
  const ids = idsAll.slice(0, UNREADABLE_IDS_SHOWN);
  const idsRest = idsAll.length - ids.length;
  return (
    <WarnNote className="mb-4">
      読めない委譲が {unreadableJobs.length} 件ある
      {ids.length > 0 &&
        `（id: ${ids.join(', ')}${idsRest > 0 ? ` …ほか ${idsRest} 件は省略` : ''}）`}
      。<strong>どの行に紐づくかは分からない</strong>
      ——「進行中（委譲あり）」の印が無い行の中に、本当は委譲が走っているものがあるかもしれない。
    </WarnNote>
  );
}

function TrimmedClosedNote({ trimmedClosed }: { trimmedClosed: number }) {
  if (trimmedClosed === 0) return null;
  return (
    <WarnNote className="mb-4">
      保存できる数の上限を超えたため、古い完了済みの仕事が合わせて {trimmedClosed} 件消えている。
      <strong>消えた分の内容は、ここでは二度と読めない。</strong>
    </WarnNote>
  );
}

const ORIGIN_LABEL: Record<CommitmentOrigin, string> = {
  human: '人間',
  manager: 'マネージャー',
  external: '外部',
  self: '自分',
};

function originLabel(origin: CommitmentOrigin): string {
  // Record<string, string | undefined> へ広げて引く: デーモンが先に新しい origin を返すと実行時は undefined になりうるが、
  // ORIGIN_LABEL の型では `?? origin` が不要に見えるため。倒れ先は空文字でなく生の値（取れないことを消さない）。
  const labels: Record<string, string | undefined> = ORIGIN_LABEL;
  const label = labels[origin];
  if (label !== undefined) return label;

  console.warn(`commitments.tsx: 未知の commitment.origin が来た（バッジ）: ${origin}`);
  return origin;
}

function OriginBadge({ commitment }: { commitment: Commitment }) {
  const label = originLabel(commitment.origin);
  const source = commitment.source;
  const hasSource = source !== undefined && source !== null && source !== '';
  const tone = commitment.origin === 'human' ? 'accent' : 'neutral';

  // origin: 'human' には広げない: source の意味が複数ありえ、/managers/<id> へ飛べる保証が無いため。
  // 内部 ID（UUID）は文字として出さない。
  if (commitment.origin === 'manager' && hasSource) {
    return (
      <Badge tone={tone}>
        <Link to={`/managers/${source}`} className="hover:underline">
          {label}の詳細
        </Link>
      </Badge>
    );
  }
  if (commitment.origin === 'human' && hasSource && looksLikeId(source)) {
    return <HumanConversationBadge label={label} source={source} />;
  }
  if (commitment.origin === 'external' && hasSource && !looksLikeId(source)) {
    return (
      <Badge tone={tone}>
        {label}（{source}）
      </Badge>
    );
  }
  return <Badge tone={tone}>{label}</Badge>;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function looksLikeId(value: string): boolean {
  return UUID_PATTERN.test(value);
}

const CONVERSATION_TITLE_MAX = 24;

// source は承認待ちへの回答の id のこともあるので、会話だと確かめられるまで言い切らない。
// 一覧に無い id だけ1件引く: 引く口は中身（messages）ごと返し、メタだけの口が無いため。
function HumanConversationBadge({ label, source }: { label: string; source: string }) {
  const recent = useConversations();
  const recentSettled = recent.data !== undefined || recent.error !== undefined;
  const inRecent = recent.data?.conversations.find((entry) => entry.conversationId === source);
  const single = useConversation(recentSettled && inRecent === undefined ? source : null, {
    retryOnNotFound: false,
  });

  if (inRecent !== undefined) {
    return <ConversationLink label={label} source={source} preview={inRecent.preview} />;
  }
  if (single.data !== undefined) {
    const messages = single.data.messages;
    const titled =
      messages.findLast((message) => message.turnFailure === undefined) ?? messages.at(-1);
    if (titled !== undefined) {
      return <ConversationLink label={label} source={source} preview={titled.text} />;
    }
    // 200 で空: 窓の外に続きが残っているかもしれないので、無いとは言えない。
    return <UnconfirmedBadge label={label} />;
  }
  if (single.error !== undefined) {
    if (single.error instanceof ApiError && single.error.status === 404) {
      return <Badge tone="accent">{label}</Badge>;
    }
    return <UnconfirmedBadge label={label} />;
  }
  return <Badge tone="accent">{label}</Badge>;
}

function UnconfirmedBadge({ label }: { label: string }) {
  return (
    <Badge tone="accent">
      {label} / <span className="text-muted-foreground">会話？（確かめられなかった）</span>
    </Badge>
  );
}

function ConversationLink({
  label,
  source,
  preview,
}: {
  label: string;
  source: string;
  preview: string;
}) {
  const flat = preview.replace(/\s+/g, ' ').trim();
  const title =
    flat.length > CONVERSATION_TITLE_MAX ? `${flat.slice(0, CONVERSATION_TITLE_MAX)}…` : flat;
  return (
    <Badge tone="accent">
      {label} /{' '}
      <Link to={`/chat/${source}`} className="hover:underline">
        {title === '' ? '会話' : `会話「${title}」`}
      </Link>
    </Badge>
  );
}

const MANAGER_PREFIXES = ['[report] ', '[question] ', '[permission] '] as const;

// 接頭辞の形式（`[kind] text`）の持ち主は packages/core/src/clone.ts の commitmentFor。向こうが変えるとここは前方一致しなくなり、本文全体を Markdown で描く。
function splitManagerPrefix(body: string): { prefix: string | null; rest: string } {
  for (const prefix of MANAGER_PREFIXES) {
    if (body.startsWith(prefix)) return { prefix, rest: body.slice(prefix.length) };
  }
  return { prefix: null, rest: body };
}

// JSON として読めない・入れ子や配列を含むときは、欠落させないよう元の文字列のまま返す。
export function readableExternalBody(body: string): string {
  const trimmed = body.trim();
  if (!trimmed.startsWith('{')) return body;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return body;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return body;
  const entries = Object.entries(parsed);
  if (entries.length === 0) return body;
  const flat = entries.every(
    ([, value]) =>
      typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean',
  );
  if (!flat) return body;
  if (entries.length === 1 && entries[0]?.[0] === 'note' && typeof entries[0][1] === 'string') {
    return entries[0][1];
  }
  return entries.map(([key, value]) => `${key}: ${String(value)}`).join('\n');
}

function PlainBody({ body }: { body: string }) {
  return <p className="text-sm leading-relaxed break-words whitespace-pre-wrap">{body}</p>;
}

// 網羅性チェック専用（引数は never）。戻り値は使わず、本文は渡さない: 渡すと本文でなく起点の生の値が描かれる。
// 実行時に来たら黙って倒さず console.warn で残す。
function assertOriginHandled(origin: never): void {
  console.warn(`commitments.tsx: 未知の commitment.origin が来た: ${String(origin)}`);
}

// 網羅性チェック専用（引数は never）。never の変数を本文として描かない: string の prop に代入できて型で捕まらず、分岐キーの生の値が出る。
function assertClosedByHandled(closedBy: never): void {
  console.warn(`commitments.tsx: switch が決めていない commitment.closedBy: ${String(closedBy)}`);
}

// @alteroid/core から値として import しない: index がサーバ専用のドメイン層まで再エクスポートしており、
// 値を1つ import するとブラウザバンドルに入ってこのルートが開けなくなる（型は import type で引く）。
// core 側の enum に値が足されてもこの複製は追随しない。新しい値は未知として console.warn 付きの default へ落ちるので、変えたら手で更新する。
const KNOWN_COMMITMENT_CLOSED_BY = [
  'clone',
  'human',
] as const satisfies readonly CommitmentClosedBy[];

function isKnownCommitmentClosedBy(value: string): value is CommitmentClosedBy {
  return (KNOWN_COMMITMENT_CLOSED_BY as readonly string[]).includes(value);
}

// 網羅性チェック専用（引数は never）。never の変数を本文として描かない（assertClosedByHandled と同じ）。
function assertMarkupHandled(markup: never): void {
  console.warn(`commitments.tsx: switch が決めていない commitment.bodyMarkup: ${String(markup)}`);
}

const KNOWN_TEXT_MARKUP = ['markdown', 'none'] as const satisfies readonly TextMarkup[];

function isKnownTextMarkup(value: string): value is TextMarkup {
  return (KNOWN_TEXT_MARKUP as readonly string[]).includes(value);
}

// bodyMarkup が undefined のときは Markdown のまま: 印が無いことを安全と読まず、いまの既定を変えないため。
function ManagerRestBody({ rest, bodyMarkup }: { rest: string; bodyMarkup: string | undefined }) {
  if (bodyMarkup === undefined) return <Markdown remoteImages={false}>{rest}</Markdown>;

  if (!isKnownTextMarkup(bodyMarkup)) {
    console.warn(
      `commitments.tsx: 未知の commitment.bodyMarkup が来た（undefined とは別扱い）: ${String(bodyMarkup)}`,
    );
    return <PlainBody body={rest} />;
  }

  const markup = bodyMarkup;
  switch (markup) {
    case 'markdown':
      return <Markdown remoteImages={false}>{rest}</Markdown>;

    case 'none':
      return <PlainBody body={rest} />;

    default:
      assertMarkupHandled(markup);
      return <PlainBody body={rest} />;
  }
}

// manager を丸ごと Markdown のままにする: text に型で区別されない3種（マネージャーの出力・既に ** を含むデーモンの通知文・SDK のエラー文）が
// 混ざり、本文を判定せずには分離できないため。human は人間が打った文字が化けないよう素のまま、external は書き手が不明なので化けて困る側（素）へ倒す。
// closedReason は origin では書き手を判別できないので、ClosedReasonBody が closedBy で描き分ける。
function CommitmentBody({ commitment }: { commitment: Commitment }) {
  const body = redactBody(commitment.body);
  switch (commitment.origin) {
    case 'self':
      return <Markdown remoteImages={false}>{body}</Markdown>;

    case 'manager': {
      const { prefix, rest } = splitManagerPrefix(body);
      return (
        <div className="min-w-0">
          {prefix !== null && (
            <span className="mr-1 font-mono text-[11px] text-muted-foreground">{prefix}</span>
          )}
          <ManagerRestBody rest={rest} bodyMarkup={commitment.bodyMarkup} />
        </div>
      );
    }

    case 'human':
      return <PlainBody body={body} />;

    case 'external':
      return <PlainBody body={readableExternalBody(body)} />;

    default:
      // デーモンが先に新しい origin を返すと実行時にここへ来る: 空白を描かず、素のテキストで本文を消さない。
      assertOriginHandled(commitment.origin);
      return <PlainBody body={body} />;
  }
}

// editedAt の有無だけを見る: 書き換えを通すかはサーバが決めており、editedBy はラベルに使わない。ClosedRow にも出す（editedAt は片付けても消えない）。
function EditedBadge({ commitment }: { commitment: Commitment }) {
  if (commitment.editedAt === undefined) return null;
  return <Badge tone="neutral">編集済み（{formatDateTime(commitment.editedAt)}）</Badge>;
}

// origin: 'human' にだけ出す: 他の origin には「クローンが人間へ返答したか」という概念が無く、「未着手」を貼ると当てはまらない。
// InProgressBadge とは別のバッジのまま: 排他ではなく、1つの2値バッジへ畳むと両方が真の行を表せない。
function AnsweredStateBadge({ commitment }: { commitment: Commitment }) {
  if (commitment.origin !== 'human') return null;
  if (commitment.respondedAt !== undefined) {
    return (
      <Badge tone="accent">
        返事済み・まだ片付いていない（{formatDateTime(commitment.respondedAt)}）
      </Badge>
    );
  }
  return <Badge tone="warn">未着手</Badge>;
}

// この印は自動で閉じる合図ではない: 委譲が終わっても行は消えず閉じない（閉じるのは人間の commitment_close だけ）。
// 同じ会話の別の行にも付きうる（1対1の紐付けではない）。key は id でよい: 同じ会話の配列内に同じ id は2度現れない。
function InProgressBadge({ commitment }: { commitment: Commitment }) {
  if (commitment.origin !== 'human') return null;
  const ids = commitment.activeManagerIds;
  if (ids === undefined || ids.length === 0) return null;
  return (
    <Badge tone="ok">
      進行中（委譲あり:{' '}
      {ids.map((id, index) => (
        <Fragment key={id}>
          {index > 0 && ', '}
          <Link to={`/managers/${id}`} className="hover:underline">
            {ids.length === 1 ? '詳細を見る' : `詳細${index + 1}`}
          </Link>
        </Fragment>
      ))}
      ）
    </Badge>
  );
}

const EDITOR_TAB_TRIGGER_CLASS =
  'border-b-2 border-transparent px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground';
const EDITOR_TAB_TRIGGER_ACTIVE_CLASS = 'border-primary text-foreground';

// 誰の行を書き換えられるかは画面に写さない: サーバ側の線が変わった日に画面だけが黙ってずれるため（403 の本文を ErrorNote に出す）。
// draft は Tabs.Root の外に置く: 非活性の Tabs.Content は unmount されるので、内側だとタブを切り替えた瞬間に入力が消える。
function CommitmentBodyEditor({
  commitment,
  onCancel,
  onRequestCancel,
  onDirtyChange,
  onTrack,
  onSettling,
}: {
  commitment: Commitment;
  onTrack: (patch: RowNotePatch) => void;
  onSettling: (on: boolean) => void;
  /** 確認なしで閉じる。保存に成功したときだけ使う（保存直後は下書きが元と違って見えるため）。 */
  onCancel: () => void;
  onRequestCancel: () => void;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const editCommitment = useEditCommitment();
  const keyboardHints = useKeyboardHintsVisible();
  const [draft, setDraft] = useState<string | undefined>(undefined);
  const [tab, setTab] = useState<string>('preview');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(undefined);
  // 一覧の取り直しで commitment が変わっても版は追従しない: 追従すると、裏の編集を見ずに上書きできる。
  const [baseVersion, setBaseVersion] = useState(() => commitment.editedAt ?? commitment.at);
  // 保存の応答は新しい版を返さないので、取り直した一覧の本文が送った本文と一致したときだけ自分の書き込みの版として取り込む。版だけで追うと、裏で入った編集の版まで拾って上書きする。
  const [ownSent, setOwnSent] = useState<string | undefined>(undefined);
  if (ownSent !== undefined && commitment.body.trim() === ownSent) {
    setBaseVersion(commitment.editedAt ?? commitment.at);
    setOwnSent(undefined);
  }
  const [conflict, setConflict] = useState<Commitment | undefined>(undefined);

  const value = draft ?? commitment.body;
  // trim した値どうしで比べる: 送るのは trim した本文で、末尾の空白だけの下書きを変更ありにすると、保存が押せるのに同じ本文を送ることになる。
  const dirty = draft !== undefined && draft.trim() !== commitment.body.trim();
  const latestDraft = useLatest(draft);

  useReportDirty(commitment.id, dirty);
  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);
  // unmount では消さない: 行が一覧から外れたときに、ページが断りとして残すため。
  useEffect(() => {
    onTrack({ draft: dirty ? draft : undefined });
  }, [dirty, draft, onTrack]);

  function save(ifMatch: string = baseVersion) {
    // ⌘/Ctrl+S は dirty で止まるボタンを通らずここへ直接来るので、門はここに置く。
    if (busy) return;
    if (!dirty) return;
    if (draft === undefined || draft.trim() === '') return;
    setBusy(true);
    setFailure(undefined);
    onTrack({ editFailure: undefined });
    onSettling(true);
    const sent = draft.trim();
    editCommitment(commitment.id, sent, ifMatch).then(
      () => {
        setConflict(undefined);
        // 応答を待つ間に打ち足した分があるときは畳まず、下書きを残す。
        if (latestDraft.current?.trim() === sent) onCancel();
        else setOwnSent(sent);
        setBusy(false);
        onSettling(false);
      },
      (caught: unknown) => {
        if (caught instanceof CommitmentConflictError && caught.current !== null) {
          setConflict(caught.current);
          setBusy(false);
          onSettling(false);
          return;
        }
        // 失敗の記録と「待ちが終わった」は同じ処理の中で行う: 別の描画だと、行が消えた断りが失敗の無い形で一瞬出る。
        setFailure(caught);
        onTrack({ editFailure: caught });
        setBusy(false);
        onSettling(false);
      },
    );
  }

  function adoptConflictVersion(next: Commitment): string {
    const version = next.editedAt ?? next.at;
    setBaseVersion(version);
    setOwnSent(undefined);
    setConflict(undefined);
    return version;
  }

  return (
    <div className="mt-2 rounded-md border border-border">
      <Tabs.Root value={tab} onValueChange={setTab}>
        <Tabs.List className="flex gap-1 border-b border-border px-2">
          <Tabs.Trigger
            value="preview"
            className={cn(
              EDITOR_TAB_TRIGGER_CLASS,
              tab === 'preview' && EDITOR_TAB_TRIGGER_ACTIVE_CLASS,
            )}
          >
            プレビュー
          </Tabs.Trigger>
          <Tabs.Trigger
            value="edit"
            className={cn(
              EDITOR_TAB_TRIGGER_CLASS,
              tab === 'edit' && EDITOR_TAB_TRIGGER_ACTIVE_CLASS,
            )}
          >
            編集
          </Tabs.Trigger>
        </Tabs.List>

        <Tabs.Content value="preview" className="px-2 py-2">
          <CommitmentBody commitment={{ ...commitment, body: value }} />
        </Tabs.Content>

        <Tabs.Content value="edit" className="px-2 py-2">
          <Textarea
            aria-label={`「${snippet(commitment.body)}」の本文`}
            className="min-h-32 font-mono text-xs leading-relaxed"
            maxHeight="60vh"
            onSubmitShortcut={() => save()}
            submitDisabled={!dirty || value.trim() === '' || busy}
            value={value}
            spellCheck={false}
            // Enter は改行のまま: 長文になりうる本文欄なので Enter 単体では送信せず、IME の門（isComposing / keyCode 229）も付けていない。
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === 's') {
                event.preventDefault();
                save();
              }
            }}
          />
        </Tabs.Content>
      </Tabs.Root>

      <div className="flex items-center gap-2 px-2 py-2">
        <Button
          variant="primary"
          size="sm"
          loading={busy}
          disabled={!dirty || value.trim() === ''}
          onClick={() => save()}
        >
          保存
        </Button>
        {tab === 'edit' && keyboardHints && (
          <span className="text-[11px] text-muted-foreground select-none">⌘/Ctrl + S で保存</span>
        )}
        {tab === 'edit' && <SubmitHint action="保存" />}
        <Button size="sm" onClick={onRequestCancel}>
          やめる
        </Button>
      </div>

      {conflict !== undefined && (
        <div
          role="alert"
          className="mx-2 mb-2 rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-sm"
        >
          <p className="mb-2 break-words">
            <strong>開いたあとに、裏でこの本文が変わった。</strong>
            保存していない。下書きはそのまま残してある。
          </p>
          <CodeBlock label="いまの本文" maxHeight="12rem">
            {redactBody(conflict.body)}
          </CodeBlock>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="primary"
              disabled={busy}
              onClick={() => save(adoptConflictVersion(conflict))}
            >
              いまの本文の上で、下書きを保存し直す
            </Button>
            <Button
              size="sm"
              disabled={busy}
              onClick={() => {
                adoptConflictVersion(conflict);
                setDraft(undefined);
              }}
            >
              下書きを捨てて、いまの本文にする
            </Button>
          </div>
        </div>
      )}
      <ErrorNote error={failure} className="mx-2 mb-2" />
    </div>
  );
}

interface RowNote {
  commitment: Commitment;
  draft?: string;
  reason?: string;
  editFailure?: unknown;
  closeFailure?: unknown;
  closedHere?: true;
}
type RowNotePatch = Partial<Omit<RowNote, 'commitment'>>;

function isEmptyNote(note: RowNote): boolean {
  return (
    note.draft === undefined &&
    note.reason === undefined &&
    note.editFailure === undefined &&
    note.closeFailure === undefined
  );
}

function sameNote(a: RowNote, b: RowNote): boolean {
  return (
    a.commitment === b.commitment &&
    a.draft === b.draft &&
    a.reason === b.reason &&
    a.editFailure === b.editFailure &&
    a.closeFailure === b.closeFailure &&
    a.closedHere === b.closedHere
  );
}

function withoutKey<T>(record: Readonly<Record<string, T>>, key: string): Record<string, T> {
  return Object.fromEntries(Object.entries(record).filter(([k]) => k !== key));
}

// 書きかけが在るあいだだけ離れる前の確認に載せる: 使い手が書いたものが画面にしか無いため。失敗の本文だけなら読めば済むので載せない。
function OrphanNotes({
  orphans,
  onDismiss,
}: {
  orphans: { note: RowNote; current: Commitment | undefined }[];
  onDismiss: (id: string) => void;
}) {
  if (orphans.length === 0) return null;
  return (
    <ul className="mb-4 flex flex-col gap-3" aria-label="一覧から外れた仕事">
      {orphans.map(({ note, current }) => (
        <OrphanNote key={note.commitment.id} note={note} current={current} onDismiss={onDismiss} />
      ))}
    </ul>
  );
}

function OrphanNote({
  note,
  current,
  onDismiss,
}: {
  note: RowNote;
  current: Commitment | undefined;
  onDismiss: (id: string) => void;
}) {
  const { commitment } = note;
  // 行が持っていた id と同じものを使う: 行の unmount と入れ替わるとき、確認が一瞬も途切れない。
  useReportDirty(commitment.id, note.draft !== undefined);
  useReportDirty(`close-reason:${commitment.id}`, note.reason !== undefined);
  return (
    <li className="rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-sm">
      <p className="mb-2 break-words">
        {note.closedHere === true ? (
          <strong>この仕事は片付けた。編集中だった本文の書きかけは残してある。</strong>
        ) : (
          <>
            <strong>この仕事は既に片付いた（または未了の一覧から外れた）。</strong>
            書きかけは残してある。
          </>
        )}
        ここから保存や片付けはできないので、必要なら写してから閉じる。
        <span className="mt-1 block text-xs text-muted-foreground">
          対象: 「{snippet(commitment.body)}」
        </span>
        {current?.closedReason !== undefined && (
          <span className="mt-1 block text-xs text-muted-foreground">
            片付けた理由: {redactBody(current.closedReason ?? '')}
          </span>
        )}
      </p>
      {note.draft !== undefined && (
        <CodeBlock label="書きかけの本文" maxHeight="12rem">
          {note.draft}
        </CodeBlock>
      )}
      {note.reason !== undefined && (
        <CodeBlock label="書きかけの片付けた理由" maxHeight="12rem" className="mt-2">
          {note.reason}
        </CodeBlock>
      )}
      <ErrorNote error={note.editFailure} className="mt-2" />
      <ErrorNote error={note.closeFailure} className="mt-2" />
      <div className="mt-2">
        <Button size="sm" onClick={() => onDismiss(commitment.id)}>
          閉じる（見送る）
        </Button>
      </div>
    </li>
  );
}

const SNIPPET_MAX = 20;

function snippet(body: string): string {
  const flat = redactBody(body).replace(/\s+/g, ' ').trim();
  return flat.length > SNIPPET_MAX ? `${flat.slice(0, SNIPPET_MAX)}…` : flat;
}

function OpenRow({
  commitment,
  onTrack,
  onSettling,
}: {
  commitment: Commitment;
  onTrack: (commitment: Commitment, patch: RowNotePatch) => void;
  onSettling: (id: string, on: boolean) => void;
}) {
  const now = useMinuteNow();
  const track = useCallback(
    (patch: RowNotePatch) => onTrack(commitment, patch),
    [onTrack, commitment],
  );
  const settling = useCallback(
    (on: boolean) => onSettling(commitment.id, on),
    [onSettling, commitment.id],
  );
  // 編集の入口は origin で隠さず未了の行すべてに出す: 隠すと「なぜ直せないか」が画面から消える。
  // 誰が編集できるかの規則は画面に写さない（断るのはサーバで、403 の本文を ErrorNote に出す）。
  const [editing, setEditing] = useState(false);
  const [editDirty, setEditDirty] = useState(false);
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  // 編集欄が閉じると押したボタンが消えてフォーカスが文書の先頭へ落ちるので、「本文を編集」のボタンへ戻す。
  const toggleRef = useRef<HTMLButtonElement>(null);
  const rowRef = useRef<HTMLLIElement>(null);
  const restoreToggleFocus = useRef(false);
  useEffect(() => {
    if (!editing && restoreToggleFocus.current) {
      restoreToggleFocus.current = false;
      toggleRef.current?.focus();
    }
  }, [editing]);
  function closeEditor() {
    restoreToggleFocus.current = true;
    setEditing(false);
    setEditDirty(false);
    setConfirmingDiscard(false);
    track({ draft: undefined, editFailure: undefined });
  }
  function requestCloseEditor() {
    if (editDirty) setConfirmingDiscard(true);
    else closeEditor();
  }

  return (
    <li ref={rowRef} className="border-b border-border px-4 py-3 last:border-b-0">
      <div className="mb-1.5 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
        <OriginBadge commitment={commitment} />
        <EditedBadge commitment={commitment} />
        <AnsweredStateBadge commitment={commitment} />
        <InProgressBadge commitment={commitment} />
        <span>{formatDateTime(commitment.at)}</span>
        <span>({formatRelativeAtMinute(commitment.at, now)})</span>
        <button
          ref={toggleRef}
          data-row-toggle=""
          type="button"
          className="ml-auto text-[11px] text-muted-foreground underline hover:text-foreground pointer-coarse:-my-3.5 pointer-coarse:-mr-3 pointer-coarse:px-3 pointer-coarse:py-3.5"
          aria-label={
            editing
              ? `「${snippet(commitment.body)}」の編集をやめる`
              : `「${snippet(commitment.body)}」の本文を編集`
          }
          onClick={() => (editing ? requestCloseEditor() : setEditing(true))}
        >
          {editing ? '編集をやめる' : '本文を編集'}
        </button>
      </div>

      {/* 編集中の行だけ CommitmentBodyEditor を mount する: Tabs / Textarea の実体が行数に比例して増えないように。 */}
      {editing ? (
        <CommitmentBodyEditor
          commitment={commitment}
          onCancel={closeEditor}
          onRequestCancel={requestCloseEditor}
          onDirtyChange={setEditDirty}
          onTrack={track}
          onSettling={settling}
        />
      ) : (
        <CommitmentBody commitment={commitment} />
      )}

      <ConfirmDialog
        open={confirmingDiscard}
        onOpenChange={setConfirmingDiscard}
        title="保存していない変更があります"
        description="編集をやめると、書きかけの内容は失われます。"
        confirmLabel="破棄して閉じる"
        destructive
        onConfirm={closeEditor}
      />

      <CloseReasonForm
        commitment={commitment}
        label={snippet(commitment.body)}
        onTrack={onTrack}
        onSettling={onSettling}
        planFocus={() => planFocusAfterRemoval(rowRef.current, '[data-row-toggle]')}
      />
    </li>
  );
}

function CloseReasonForm({
  commitment,
  label,
  onTrack,
  onSettling,
  planFocus,
}: {
  commitment: Commitment;
  label: string;
  onTrack: (commitment: Commitment, patch: RowNotePatch) => void;
  onSettling: (id: string, on: boolean) => void;
  planFocus: () => () => void;
}) {
  const closeCommitment = useCloseCommitment();
  // 外れたあとの後始末は片付けの途中だったときだけ動かす。応答が外れより先なら応答のほうで動かす。
  const closing = useRef<(() => void) | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      closing.current?.();
    };
  }, []);
  const reasonId = useId();
  const reasonHintId = useId();
  const [reason, setReason] = useState('');
  const track = useCallback(
    (patch: RowNotePatch) => onTrack(commitment, patch),
    [onTrack, commitment],
  );
  // unmount では消さない: 行が外れたらページが断りとして残す。
  useEffect(() => {
    track({ reason: reason.trim() !== '' ? reason : undefined });
  }, [reason, track]);
  useReportDirty(`close-reason:${commitment.id}`, reason.trim() !== '');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(undefined);

  async function submit() {
    // Enter はボタン（loading で塞がる）を通らないので、送信中の門はここで持つ。
    if (busy || reason.trim() === '') return;
    setBusy(true);
    setFailure(undefined);
    track({ closeFailure: undefined });
    // 応答を待つ間は、行が一覧から消えても断りにしない（一覧は応答より先に取り直される）。
    onSettling(commitment.id, true);
    const restoreFocus = planFocus();
    closing.current = restoreFocus;
    try {
      await closeCommitment(commitment.id, reason.trim());
      track({ reason: undefined, closeFailure: undefined, closedHere: true });
      // 取り直しが応答より先に行を外していたら、後始末は走り終えている。ここで送る。
      if (!mounted.current) restoreFocus();
    } catch (caught) {
      closing.current = null;
      setFailure(caught);
      // 一覧の取り直しが先に行を消すことがある（409）。ページにも渡し、行が消えても失敗の本文を見せる。
      track({ closeFailure: caught });
    } finally {
      setBusy(false);
      onSettling(commitment.id, false);
    }
  }

  return (
    <>
      <label htmlFor={reasonId} className="mt-2 block text-xs font-medium text-muted-foreground">
        片付けた理由
      </label>
      <div className="mt-1 flex items-center gap-2">
        <Input
          id={reasonId}
          aria-describedby={reasonHintId}
          value={reason}
          aria-label={`「${label}」を片付けた理由`}
          placeholder="例: 修正を入れて確認した"
          onChange={(event) => setReason(event.target.value)}
          onSubmitShortcut={() => void submit()}
        />
        <Button
          variant="primary"
          size="sm"
          className="shrink-0"
          loading={busy}
          aria-label={`「${label}」が片付いた`}
          // 理由なしでは閉じられない: 「閉じた」だけが残ると、人間が後から否定できない。
          disabled={reason.trim() === ''}
          onClick={() => void submit()}
        >
          片付いた
        </Button>
      </div>
      <FieldHint id={reasonHintId} className="mt-1.5">
        何をもって片付いたかを書く。後から否定できるように残る。
      </FieldHint>

      <ErrorNote error={failure} className="mt-2" />
    </>
  );
}

// 返した関数は、フォーカスがまだ文書の先頭へ落ちたままのときだけ送る（使い手がほかへ移していたら動かさない）。
function planFocusAfterRemoval(row: HTMLElement | null, targetSelector: string): () => void {
  const neighbor = row?.nextElementSibling ?? row?.previousElementSibling ?? null;
  return () => {
    const active = document.activeElement;
    if (active !== null && active !== document.body) return;
    const target = neighbor?.isConnected
      ? neighbor.querySelector<HTMLElement>(targetSelector)
      : null;
    if (target !== null && target !== undefined) {
      target.focus();
      return;
    }
    const header = document.querySelector<HTMLElement>('[data-open-list-header]');
    if (header !== null) {
      header.setAttribute('tabindex', '-1');
      header.focus();
    }
  };
}

function ClosedRow({ commitment }: { commitment: Commitment }) {
  return (
    <li className="border-b border-border px-4 py-3 text-muted-foreground last:border-b-0">
      <div className="mb-1.5 flex flex-wrap items-center gap-2 text-[11px]">
        <Badge tone="ok">片付いた</Badge>
        <OriginBadge commitment={commitment} />
        <EditedBadge commitment={commitment} />
        <span>
          {formatDateTime(commitment.at)} → {formatDateTime(commitment.closedAt ?? '')}
        </span>
      </div>
      <CommitmentBody commitment={commitment} />
      <ClosedReasonBody commitment={commitment} />
    </li>
  );
}

function PlainClosedReason({ reason }: { reason: string }) {
  return (
    <p className="mt-1 text-xs break-words whitespace-pre-wrap">
      <span className="mr-2 text-[11px]">どう片付いたか</span>
      {reason}
    </p>
  );
}

// human は人間が打った文字を化けさせないよう素テキスト（chat-message.tsx の「クローンの行だけを Markdown にする」と同じ線）。
// 保存層は closedBy を z.string() で緩く持つ（未知の値で一覧が丸ごと読めなくなるのを避ける）ので、表示側で isKnownCommitmentClosedBy で狭める。
function ClosedReasonBody({ commitment }: { commitment: Commitment }) {
  if (commitment.closedReason === undefined || commitment.closedReason === null) return null;
  // 4経路すべてが通る入口で伏せる: 経路ごとに足すと、足し忘れた経路から素のまま出る。
  const reason = redactBody(commitment.closedReason);

  // closedBy が無い行は既定（clone / human）へ倒さない。未知の値とは別扱いで、warn するのは未知の値だけ。
  if (commitment.closedBy === undefined) return <PlainClosedReason reason={reason} />;

  if (!isKnownCommitmentClosedBy(commitment.closedBy)) {
    console.warn(
      `commitments.tsx: 未知の commitment.closedBy が来た（undefined とは別扱い）: ${String(commitment.closedBy)}`,
    );
    return <PlainClosedReason reason={reason} />;
  }

  const closedBy = commitment.closedBy;
  switch (closedBy) {
    case 'clone':
      return (
        <div className="mt-1 text-xs">
          <span className="mr-2 text-[11px]">どう片付いたか</span>
          <Markdown remoteImages={false}>{reason}</Markdown>
        </div>
      );

    case 'human':
      return <PlainClosedReason reason={reason} />;

    default:
      assertClosedByHandled(closedBy);
      return <PlainClosedReason reason={reason} />;
  }
}

const PUSH_FORM_DIRTY_ID = 'push-form';

// 読めるだけにしない: 積みたい場面は「いま言ったことを忘れられたら困る」ときで、クローンのターンを1回起こさないと書けないのは重い。CLI の `/commit` と同じ経路にする。
function PushForm() {
  const pushCommitment = usePushCommitment();
  const inputId = useId();
  const bodyHintId = useId();
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(undefined);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const { data, mutate } = useCommitments(false);
  const dataRef = useLatest(data);

  useReportDirty(PUSH_FORM_DIRTY_ID, body !== '');

  async function submit() {
    const text = body.trim();
    if (text === '') return;
    const sent = body;
    const before = dataRef.current && new Set(dataRef.current.entries.map((entry) => entry.id));
    setBusy(true);
    setFailure(undefined);
    setNotice(undefined);
    try {
      await pushCommitment(text);
      setBody((current) => unsentInput(current, sent));
    } catch (caught) {
      // サーバは冪等の鍵を持たず、送り直すと同じ本文が二重に載る。届いたか分からない失敗のときだけ、
      // 取り直した一覧に積む前に無かった同じ本文の行が在るかで確かめる。
      const unknown =
        !(caught instanceof ApiError) || caught.status >= 500 || caught.status === 408;
      const landed =
        unknown &&
        before !== undefined &&
        ((await mutate())?.entries ?? []).some(
          (entry) => !before.has(entry.id) && entry.body.trim() === text,
        );
      if (landed) {
        setBody((current) => unsentInput(current, sent));
        setNotice('応答は届かなかったが、台帳には載っている。送り直さなくてよい。');
      } else {
        setFailure(caught);
        if (unknown)
          setNotice(
            '届いたか分からない。台帳の一覧を確かめてから送り直すこと（二重に載ることがある）。',
          );
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="mb-4">
      <CardHeader title="仕事を登録する" subtitle="引き受けたことを、片付くまで残す" />
      <div className="flex flex-col gap-2 px-4 py-3">
        <label htmlFor={inputId} className="text-xs font-medium text-muted-foreground">
          何を引き受けたか
        </label>
        <Textarea
          id={inputId}
          aria-describedby={bodyHintId}
          rows={3}
          maxHeight="60vh"
          value={body}
          placeholder="例: 金曜までに週次レビューを出す"
          onChange={(event) => setBody(event.target.value)}
          onSubmitShortcut={() => void submit()}
          submitDisabled={body.trim() === '' || busy}
        />
        <FieldHint id={bodyHintId} className="-mt-1">
          何を引き受けたかを全文で書く。クローンへ渡す一覧（commitment_list）は長い本文を先頭だけに切るが、台帳には全文が残る。
        </FieldHint>
        <div className="flex items-center gap-2">
          <Button
            variant="primary"
            loading={busy}
            disabled={body.trim() === ''}
            onClick={() => void submit()}
          >
            積む
          </Button>
          <SubmitHint action="登録" />
        </div>
        <ErrorNote error={failure} />
        {notice !== undefined && (
          <p role="status" className="text-xs text-muted-foreground">
            {notice}
          </p>
        )}
      </div>
    </Card>
  );
}
