import { Pencil } from 'lucide-react';
import type { ReactNode } from 'react';

import { useDisplayText } from '@/lib/display-text';
import { cn } from '@/lib/utils';

import { Button } from '../../common';
import { Markdown } from '../../markdown';

export type ChatRole = 'human' | 'clone' | 'system';

export function ChatMessageList({ children }: { children: ReactNode }) {
  return (
    <ul aria-label="やりとり" className="flex flex-col gap-3">
      {children}
    </ul>
  );
}

export interface ChatMessageVersions {
  index: number;
  total: number;
  onPrevious: () => void;
  onNext: () => void;
  hidden?: readonly { role: 'human' | 'clone' | 'approval'; text: string }[];
}

// `onEdit` はサーバで確定した人間の発言にだけ渡す: 送信中の楽観行はまだサーバに無く、編集の入口を出してはいけないため
export function ChatMessage({
  role,
  text,
  transient = false,
  onEdit,
  editKey,
  hasDraft = false,
  versions,
  attachments,
  children,
}: {
  role: ChatRole;
  text: string;
  transient?: boolean;
  onEdit?: () => void;
  editKey?: string;
  hasDraft?: boolean;
  versions?: ChatMessageVersions;
  attachments?: ReactNode;
  children?: ReactNode;
}) {
  const { body } = useDisplayText();
  const shown = body(text);
  const editing = children !== undefined;
  const viewingOld = versions !== undefined && versions.index < versions.total - 1;
  const attachmentOnly = role === 'human' && text === '' && attachments !== undefined && !editing;

  return (
    <li className={cn('group flex flex-col gap-1', role === 'human' ? 'items-end' : 'items-start')}>
      {!attachmentOnly && (
        <div
          className={cn(
            'flex min-w-0 max-w-full items-start gap-1',
            role === 'clone' && 'w-full',
            // 編集中は読む幅の上限（46rem）まで広げる: 編集欄が入ると外側が中身の幅に縮み、元の吹き出しより狭くなるため
            editing && role !== 'clone' && 'w-full max-w-[46rem]',
          )}
        >
          {onEdit !== undefined && !editing && (
            <Button
              size="sm"
              variant="ghost"
              aria-label={hasDraft ? '発言を編集（書きかけあり）' : '発言を編集'}
              data-edit-key={editKey}
              className={cn(
                'relative mt-1 shrink-0 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-60 pointer-coarse:group-focus-within:opacity-100 pointer-coarse:focus-visible:opacity-100',
                hasDraft && 'opacity-100',
              )}
              onClick={onEdit}
            >
              <Pencil className="size-3.5" aria-hidden />
              {hasDraft && (
                <span
                  aria-hidden
                  className="absolute top-1 right-1 size-1.5 rounded-full bg-warn"
                />
              )}
            </Button>
          )}
          <div
            data-role={role}
            className={cn(
              // `break-words` を付ける: 人間・システムの行は素のテキストを直接置くだけで、長い一続きの文字列（URL・パス等）で吹き出しがはみ出すため
              'min-w-0 text-sm leading-relaxed break-words',
              // 読む幅の上限をクローンには掛けない: 応答は地の上の本文なので、会話欄の幅いっぱいに置くため
              role !== 'clone' && 'max-w-[46rem]',
              role !== 'clone' && 'whitespace-pre-wrap',
              // クローンの応答は吹き出しにしない: 長い Markdown になりがちで、枠に入れると読む幅が削られ、縦に長い箱が積み重なるため
              // `selection:` で反転色にする: 吹き出しが `bg-primary` なので、既定の `::selection` だと選択範囲が地と同じ色に溶けるため
              role === 'human' &&
                'rounded-lg bg-primary px-3 py-2 text-primary-foreground selection:bg-primary-foreground selection:text-primary',
              editing && role !== 'clone' && 'flex-1',
              role === 'clone' && 'w-full py-1',
              // 斜体にしない: 和文の斜体は字形を歪めるだけで読みにくくなるため
              role === 'system' &&
                'border-l-2 border-border py-0.5 pl-3 text-xs text-muted-foreground',
            )}
          >
            {editing ? (
              children
            ) : role === 'clone' ? (
              text === '' ? (
                <span className="text-muted-foreground">…</span>
              ) : (
                // クローンの行だけを Markdown にする: 人間が打った文字が勝手に化けないため
                // 外部の画像は開いた瞬間に読み込まない（#4063）: 読み込むと閲覧の時刻・IP・User-Agent・Referer が画像の置き場所へ伝わり、応答の本文は外のページを読んだ結果も含むため。押して初めて開く
                // 添付（`attachments`）は Markdown を通らないので、この口の影響を受けない
                <Markdown headingOffset={2} remoteImages={false}>
                  {shown}
                </Markdown>
              )
            ) : transient ? (
              <span className="inline-flex items-center gap-2">
                <span className="relative flex size-1.5" aria-hidden>
                  <span className="absolute inset-0 rounded-full bg-primary opacity-60 motion-safe:animate-ping" />
                  <span className="relative size-1.5 rounded-full bg-primary" />
                </span>
                {shown}
              </span>
            ) : (
              shown
            )}
          </div>
        </div>
      )}

      {attachments !== undefined && !editing && attachments}

      {/* 編集中は隠す: 確定前の下書きと古い版の閲覧を同時に出すと、どちらを直しているのか読みにくくなるため */}
      {versions !== undefined && !editing && (
        <div className="flex max-w-full min-w-0 flex-col gap-1">
          <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
            <button
              type="button"
              aria-label="前の版へ"
              disabled={versions.index <= 0}
              className="rounded-sm px-1 hover:text-foreground disabled:opacity-40"
              onClick={versions.onPrevious}
            >
              ‹
            </button>
            <span data-numeric>
              {versions.index + 1}/{versions.total}
            </span>
            <button
              type="button"
              aria-label="次の版へ"
              disabled={versions.index >= versions.total - 1}
              className="rounded-sm px-1 hover:text-foreground disabled:opacity-40"
              onClick={versions.onNext}
            >
              ›
            </button>
          </div>
          {viewingOld && versions.hidden !== undefined && versions.hidden.length > 0 && (
            <div className="flex max-w-[46rem] min-w-0 flex-col gap-1 rounded-lg border border-dashed border-border px-3 py-2 text-xs break-words whitespace-pre-wrap text-muted-foreground">
              {versions.hidden.map((entry, index) => (
                <p key={index}>
                  <span className="mr-1 font-semibold">
                    {entry.role === 'human'
                      ? '人間'
                      : entry.role === 'approval'
                        ? '確認'
                        : 'クローン'}
                  </span>
                  {body(entry.text)}
                </p>
              ))}
            </div>
          )}
        </div>
      )}
    </li>
  );
}
