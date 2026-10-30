import { Link } from 'react-router';

import { Button, ErrorNote, TurnFailureNote, type TurnFailureKind } from '@alteroid/ui';
import type { ApiError } from '@alteroid/swr';

import { expiredCarriedNames, isAttachmentMissing, type PendingAttachment } from './chat-lines';

export class TurnFailedError extends Error {
  constructor(
    message: string,
    readonly failureKind: TurnFailureKind,
    // このターンの手元の返信の組（FailedTurn の鍵）。履歴に同じ失敗が載ったかを引くのに使う
    readonly replyGroup?: string,
  ) {
    super(message);
  }
}

export const turnFailureAction = (kind: TurnFailureKind) =>
  kind === 'auth' ? (
    <Link to="/tokens" className="text-xs underline underline-offset-2">
      認証トークンの画面を開く
    </Link>
  ) : undefined;

interface NoteWithNames {
  count: number;
  names: readonly string[];
}

// 入力欄の上に出す知らせの帯。描くだけで state を持たない（出すか出さないかの判定と、押されたときの処理は親が持つ）。
// 排他にしない: どれかが出ているあいだ他が隠れると、選んだファイルが理由なく落ちたり、再送／破棄の操作が見えなくなったりする
export function ComposerNotices({
  attachNotice,
  shownLostPending,
  lostAttachmentsNote,
  unconfirmedText,
  shownFailure,
  retryAttachments,
  canResend,
  onDismissLostPending,
  onResendUnconfirmed,
  onDiscardUnconfirmed,
  onResendFailed,
}: {
  attachNotice: string | undefined;
  shownLostPending: NoteWithNames | undefined;
  lostAttachmentsNote: NoteWithNames | undefined;
  unconfirmedText: string | undefined;
  shownFailure: unknown;
  retryAttachments: readonly PendingAttachment[];
  canResend: boolean;
  onDismissLostPending: () => void;
  onResendUnconfirmed: () => void;
  onDiscardUnconfirmed: () => void;
  onResendFailed: () => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      {attachNotice !== undefined && (
        <p role="alert" className="text-xs break-words whitespace-pre-line text-warn">
          {attachNotice}
        </p>
      )}
      {shownLostPending !== undefined && (
        <div
          role="status"
          data-lost-pending-attachments
          className="flex flex-wrap items-center gap-2 text-xs text-warn"
        >
          <span>
            添えていたファイル {shownLostPending.count} 件
            {shownLostPending.names.length === 0 ? '' : `（${shownLostPending.names.join('、')}）`}
            は戻せませんでした。必要なら添え直す
          </span>
          <Button size="sm" variant="ghost" onClick={onDismissLostPending}>
            閉じる
          </Button>
        </div>
      )}
      {unconfirmedText === undefined && lostAttachmentsNote !== undefined && (
        <p role="status" data-lost-attachments className="text-xs text-warn">
          添えていたファイル {lostAttachmentsNote.count} 件
          {lostAttachmentsNote.names.length === 0
            ? ''
            : `（${lostAttachmentsNote.names.join('、')}）`}
          は、再読み込みで戻せなかった。必要なら添え直す。このまま送ると、そのファイルの無い版になる
        </p>
      )}
      {unconfirmedText !== undefined && (
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span>
            送れたか確かめられなかった。サーバが受け取っていれば会話に出る（二重に送らないよう、確かめてから再送する）
          </span>
          {lostAttachmentsNote !== undefined && (
            <span data-lost-attachments className="basis-full text-warn">
              添えていたファイル {lostAttachmentsNote.count} 件
              {lostAttachmentsNote.names.length === 0
                ? ''
                : `（${lostAttachmentsNote.names.join('、')}）`}
              は、再読み込みで戻せなかった。添え直してから再送するか、本文だけで再送する
            </span>
          )}
          <Button size="sm" onClick={onResendUnconfirmed}>
            再送
          </Button>
          <Button size="sm" variant="ghost" onClick={onDiscardUnconfirmed}>
            破棄
          </Button>
        </div>
      )}
      {shownFailure === undefined || shownFailure === null ? undefined : shownFailure instanceof
        TurnFailedError ? (
        <TurnFailureNote
          kind={shownFailure.failureKind}
          message={shownFailure.message}
          action={turnFailureAction}
        />
      ) : (
        <div>
          <ErrorNote error={shownFailure} />
          {isAttachmentMissing(shownFailure) && (
            <p role="alert" className="mt-2 text-xs text-warn">
              {(() => {
                const items = retryAttachments;
                const names = expiredCarriedNames(items, (shownFailure as ApiError).message);
                // 先頭3件と「ほか N 件」にする: 長い案内で本題を押し流さないため
                const named =
                  names.length === 0
                    ? ''
                    : `（${names.slice(0, 3).join('、')}${names.length > 3 ? ` ほか ${names.length - 3} 件` : ''}）`;
                if (items.some((item) => item.file !== undefined && item.meta === undefined)) {
                  return items.some((item) => item.file === undefined)
                    ? `添付が期限切れだった。手元のファイルは次の送信で上げ直す。引き継いだ添付${named}は上げ直せないので、期限切れなら外してから送る。`
                    : '添付が期限切れだった。次の「再送」か送信で、手元のファイルを上げ直す。';
                }
                return `添付が期限切れか、サーバに無い${named}。「再送」は同じ添付で送るので、添付を外して付け直してから送る。`;
              })()}
            </p>
          )}
          {canResend && (
            <Button size="sm" className="mt-2" onClick={onResendFailed}>
              再送
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
