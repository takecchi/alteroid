import { useState } from 'react';
import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

export interface ApprovalConversationMessage {
  id: string;
  role: 'inbound' | 'outbound';
  /** 伏せ字を済ませた本文。部品は伏せない（伏せる規則は画面の側が持つ）。 */
  text: string;
  /** 本文の下に添える1行（添付の名前など）。 */
  note?: string;
}

/** 既定で出す直近の発言の数。 */
export const APPROVAL_CONVERSATION_RECENT = 3;
/** 1発言を畳むまでの行数と文字数。 */
export const APPROVAL_MESSAGE_MAX_LINES = 4;
export const APPROVAL_MESSAGE_MAX_CHARS = 200;

/**
 * 長い本文の頭だけを返す。行数と文字数のどちらかを超えたら切る。
 * CSS の line-clamp にしない: 切った事実を文字（「…」とボタン）で出し、読み上げとテストからも見えるようにするため。
 */
export function clipMessageText(
  text: string,
  maxLines = APPROVAL_MESSAGE_MAX_LINES,
  maxChars = APPROVAL_MESSAGE_MAX_CHARS,
): { head: string; clipped: boolean } {
  let head = text.split('\n').slice(0, maxLines).join('\n');
  if (head.length > maxChars) head = head.slice(0, maxChars);
  if (head.length === text.length) return { head: text, clipped: false };
  return { head: `${head.trimEnd()}…`, clipped: true };
}

/**
 * 承認カードの「この確認が上がった会話」。既定は直近の数件だけを出し、残りは開いたときだけ並べる。
 * 同じ会話から確認がいくつも上がると、どのカードにも同じ会話が付くため（全部を並べるとカードが会話の長さで伸びる）。
 * 古い発言を消すのではなく畳むだけで、件数は常に出す。
 */
export function ApprovalConversation({
  messages,
  reachedStart,
  footer,
  recent = APPROVAL_CONVERSATION_RECENT,
}: {
  /** 古い順。 */
  messages: readonly ApprovalConversationMessage[];
  /** 取れた窓が会話の先頭に届いたか。`false` なら、取れた発言だけだと断る。 */
  reachedStart: boolean;
  /** いちばん下に置くもの（チャットで開く導線など）。 */
  footer?: ReactNode;
  recent?: number;
}) {
  const [showAll, setShowAll] = useState(false);
  const hidden = showAll ? 0 : Math.max(0, messages.length - recent);
  const shown = messages.slice(hidden);
  const foldable = messages.length > recent;

  return (
    <div>
      <p className="mb-2 text-[11px] font-semibold text-muted-foreground">この確認が上がった会話</p>
      {!reachedStart && (
        <p className="mb-2 text-[11px] text-muted-foreground italic">
          窓が会話の先頭に届いていないので、取れた発言だけを出している
        </p>
      )}
      {foldable && (
        <div className="mb-2 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
          <span>
            {showAll
              ? `取れた ${messages.length} 件をすべて出している`
              : `取れた ${messages.length} 件のうち、直近の ${shown.length} 件だけを出している`}
          </span>
          <button
            type="button"
            className="text-primary hover:underline"
            aria-expanded={showAll}
            onClick={() => setShowAll((current) => !current)}
          >
            {showAll ? `直近の ${recent} 件だけにする` : `全部を見る（${messages.length} 件）`}
          </button>
        </div>
      )}
      <ul className="flex flex-col gap-2">
        {shown.map((message) => (
          <ConversationMessageItem key={message.id} message={message} />
        ))}
      </ul>
      {footer}
    </div>
  );
}

function ConversationMessageItem({ message }: { message: ApprovalConversationMessage }) {
  const [expanded, setExpanded] = useState(false);
  const { head, clipped } = clipMessageText(message.text);
  return (
    <li
      className={cn(
        'rounded border border-border p-2 text-xs break-words whitespace-pre-wrap',
        message.role === 'inbound' ? 'bg-background' : 'bg-muted',
      )}
    >
      <span className="mr-1 text-[10px] text-muted-foreground">
        {message.role === 'inbound' ? '人間' : 'クローン'}
      </span>
      {expanded || !clipped ? message.text : head}
      {clipped && (
        <button
          type="button"
          className="ml-1 text-[11px] whitespace-nowrap text-primary hover:underline"
          aria-expanded={expanded}
          onClick={() => setExpanded((current) => !current)}
        >
          {expanded ? '畳む' : '続きを読む'}
        </button>
      )}
      {message.note !== undefined && (
        <span className="block text-[11px] text-muted-foreground">{message.note}</span>
      )}
    </li>
  );
}
