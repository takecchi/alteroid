import { Fragment } from 'react';
import { Link } from 'react-router';

import { Badge } from '@alteroid/ui';
import { useConversation, useConversations } from '@alteroid/swr';
import { formatDateTime } from '@alteroid/logic';
import type { CommitmentOrigin } from '@alteroid/core';
import type { Commitment } from '@alteroid/logic';

import { clipLine } from '~/lib/clip-line';
import { isNotFound } from '~/lib/is-not-found';

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

export function OriginBadge({ commitment }: { commitment: Commitment }) {
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
    if (isNotFound(single.error)) {
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
  // 伏せてから切る: 会話の書き出しは人間の発言で秘密を含みうる（会話一覧の display.body・CLI と同じ redactBody）
  const title = clipLine(preview, CONVERSATION_TITLE_MAX);
  return (
    <Badge tone="accent">
      {label} /{' '}
      <Link to={`/chat/${source}`} className="hover:underline">
        {title === '' ? '会話' : `会話「${title}」`}
      </Link>
    </Badge>
  );
}

// origin: 'human' にだけ出す: 他の origin には「クローンが人間へ返答したか」という概念が無く、「未着手」を貼ると当てはまらない。
// InProgressBadge とは別のバッジのまま: 排他ではなく、1つの2値バッジへ畳むと両方が真の行を表せない。
export function AnsweredStateBadge({ commitment }: { commitment: Commitment }) {
  if (commitment.origin !== 'human') return null;
  // 「未着手」を出さない: 会話（source）に結べない行の「返事なし」は「見えない」であり、丸めて「未着手」と言うと嘘になるため（#4817、teto（クローン）が案A に決定）
  if (commitment.source === undefined) {
    return (
      <span className="text-xs text-muted-foreground">返事の判定なし（会話に結んでいない）</span>
    );
  }
  if (commitment.respondedAt !== undefined) {
    return (
      <Badge tone="accent">
        返事済み・まだ片付いていない（{formatDateTime(commitment.respondedAt)}）
      </Badge>
    );
  }
  return <Badge tone="warn">未着手</Badge>;
}

// この印は自動で閉じる合図ではない: 委譲が終わっても行は消えず閉じない（台帳は読むだけで、書く口は人間にもクローンにも無い）。
// 同じ会話の別の行にも付きうる（1対1の紐付けではない）。key は id でよい: 同じ会話の配列内に同じ id は2度現れない。
export function InProgressBadge({ commitment }: { commitment: Commitment }) {
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
