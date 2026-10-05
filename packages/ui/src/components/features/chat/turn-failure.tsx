import { AlertTriangle, RotateCw } from 'lucide-react';
import type { ReactNode } from 'react';

import { Alert, AlertDescription } from '@/components/ui/alert';
import { useDisplayText } from '@/lib/display-text';
import { cn } from '@/lib/utils';

import { Button } from '../../common';

/**
 * 送信が失敗した理由の種類。**画面が次の一手を変えるための粗い分け**であって、原因の
 * 診断ではない。
 *
 * - `auth` —— クローンの認証が通らない（再ログイン・トークンの確認が要る）
 * - `quota` —— 利用上限に当たっている（待つ・別のトークンへ回る）
 * - `other` —— 上のどれとも言えない
 */
export type TurnFailureKind = 'auth' | 'quota' | 'other';

/**
 * 失敗の文（SSE の `error` イベントの `message`）から種類を読む。
 *
 * **⚠️ 文面で見分けている（弱い）。** `error` イベントは `{ type: 'error', message }` だけで、
 * 原因の種類を構造では運んでいない。認証切れは SDK が `result` の本文
 * （`Not logged in · Please run /login`）として運び、`subtype` は `success`・`is_error`
 * が立つだけなので、SDK 側にも種類の印が無い（`packages/core/src/sdk-failure.ts` の
 * `result_is_error`）。**CLI の文言が変わると `other` に落ちる**——そのときも
 * 文面（`summary`）は「返事を作れなかった」を言うので、嘘にはならず、次の一手の
 * 案内が汎用になるだけである。
 *
 * **`overloaded` は `quota` に入れない。** サーバ側の一時的な混雑で、利用者の上限ではない
 * （「利用上限に当たっていて」は嘘になる）ので `other` に落とす。`rate_limit` は入れてある:
 * SDK の `assistant.error` の `rate_limit` は利用者の枠（時間窓の使用量。`usage-limits.ts` の
 * `limitRecoveryOfAssistantError` が `time`＝待てば開くと扱っている側）で、混雑ではない。
 */
export function classifyTurnFailure(message: string): TurnFailureKind {
  if (
    /not logged in|please run \/login|authentication_failed|authentication[_ ]error|invalid (api key|bearer token|x-api-key)|oauth token (has )?(expired|revoked)|invalid authentication credentials|\b401\b/i.test(
      message,
    )
  ) {
    return 'auth';
  }
  if (/hit your .*limit|usage limit|spend limit|rate[_ ]limit|quota|billing_error/i.test(message)) {
    return 'quota';
  }
  return 'other';
}

/** 種類ごとの、何が起きたかと次にやること（1文ずつ）。 */
export const TURN_FAILURE_COPY: Record<TurnFailureKind, { what: string; next: string }> = {
  auth: {
    what: 'クローンの認証が通らず、返事を作れませんでした。',
    next: '認証トークンの画面で、使えるトークンが登録されているか確かめてください。',
  },
  quota: {
    what: '利用上限に当たっていて、返事を作れませんでした。',
    next: '上限が開いたあとに、もう一度送ってください。',
  },
  other: {
    what: '返事を作れませんでした。',
    next: '少し待ってから、もう一度送ってください。',
  },
};

/**
 * 入力欄の上に出す、送信失敗の帯。
 *
 * **生の文（`message`）は「詳細」に畳む。** 利用者に見せる1文は {@link TURN_FAILURE_COPY}
 * が持ち、原因の種類を読めたときは、その画面へ行く導線（`action`。呼ぶ側が `<Link>` を
 * 置く——ここはルーターに依存しない）を添える。
 */
export function TurnFailureNote({
  message,
  action,
  className,
}: {
  message: string;
  /** 次にやることの導線（認証トークンの画面へのリンクなど）。 */
  action?: (kind: TurnFailureKind) => ReactNode;
  className?: string;
}) {
  const display = useDisplayText();
  const kind = classifyTurnFailure(message);
  const copy = TURN_FAILURE_COPY[kind];
  return (
    <Alert variant="destructive" className={cn('border-destructive/40', className)}>
      <AlertTriangle aria-hidden />
      <AlertDescription className="min-w-0 break-words">
        <p>
          {copy.what}
          {copy.next}
        </p>
        {action?.(kind)}
        <details className="mt-1 text-xs">
          <summary className="cursor-pointer py-1">詳細</summary>
          <p className="whitespace-pre-wrap break-words">{display.error(message)}</p>
        </details>
      </AlertDescription>
    </Alert>
  );
}

/**
 * 会話の中の「返せなかった」知らせ（`<li>`。`ChatMessageList` の中に置く）。
 *
 * **クローンの返答と見分けるため、返答の見た目（地の上の本文）を使わない。** 左に太い
 * 赤い線・警告の印・赤い見出しの文で、ひと目でエラーと読める。
 *
 * - `failed` —— ターンの失敗。`onRetry` を渡すと「もう一度送る」を置く（渡さなければ
 *   出さない。再送できない状態——送信中・直前が自分の発言でない等——を呼ぶ側が決める）
 * - `held` —— 利用上限での保持。クローンが自分で試し直すので、再送は置かない
 *
 * `failed` の本文は画面の文（日誌の固定文には「ターン」など内部の語が入る）。サーバが
 * 書いた文は「詳細」に畳む。`held` の文は利用者向けに書かれているのでそのまま出す。
 */
export function ChatTurnFailure({
  kind,
  text,
  onRetry,
  retrying = false,
}: {
  kind: 'failed' | 'held';
  text: string;
  onRetry?: () => void;
  retrying?: boolean;
}) {
  const { body } = useDisplayText();
  const shown = body(text);
  return (
    <li
      data-turn-failure={kind}
      className="flex min-w-0 flex-col items-start gap-2 border-l-4 border-destructive bg-destructive/5 py-2 pl-3 pr-2 text-sm"
    >
      <div className="flex min-w-0 max-w-[46rem] items-start gap-2 text-destructive">
        <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
        {kind === 'failed' ? (
          <div className="min-w-0 break-words">
            <p className="font-medium">この発言には返事を作れませんでした。</p>
            <details className="text-xs text-muted-foreground">
              <summary className="cursor-pointer py-1">詳細</summary>
              <p className="whitespace-pre-wrap break-words">{shown}</p>
            </details>
          </div>
        ) : (
          <p className="min-w-0 whitespace-pre-wrap break-words font-medium">{shown}</p>
        )}
      </div>
      {kind === 'failed' && onRetry !== undefined && (
        <Button variant="default" loading={retrying} onClick={onRetry}>
          <RotateCw className="size-3.5" aria-hidden />
          もう一度送る
        </Button>
      )}
    </li>
  );
}
