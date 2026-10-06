import { Pencil } from 'lucide-react';
import type { ReactNode } from 'react';

import { useDisplayText } from '@/lib/display-text';
import { cn } from '@/lib/utils';

import { Button } from '../../common';
import { Markdown } from '../../markdown';

/**
 * 発言の主。`apps/web/app/routes/chat.tsx` の `Line['role']` と同じ3値である。
 *
 * - `human` —— 人間が打った発言（右寄せ・主色の面）
 * - `clone` —— クローンの応答（左寄せ・枠の面・Markdown で描く）
 * - `system` —— 画面が差し込む事情（確認への回答・取り下げ・枠に当たった等）
 */
export type ChatRole = 'human' | 'clone' | 'system';

/**
 * やりとりの並び（`<ul>`）。`ChatMessage` はこの中に置く。
 *
 * 読み上げの名前は「やりとり」（画面の試験がこの名前で引いている）。
 */
export function ChatMessageList({ children }: { children: ReactNode }) {
  return (
    <ul aria-label="やりとり" className="flex flex-col gap-3">
      {children}
    </ul>
  );
}

/**
 * 版を行き来する口（発言を編集して置き換えたときだけ付く）。
 *
 * `hidden` は「古い版を見ているあいだ、その版のすぐ後に隠れていた往復」——
 * ここが「前の版へ戻って読める」の本体である。
 */
export interface ChatMessageVersions {
  /** いま見ている版（0 始まり）。 */
  index: number;
  total: number;
  onPrevious: () => void;
  onNext: () => void;
  hidden?: readonly { role: 'human' | 'clone' | 'approval'; text: string }[];
}

/**
 * やりとりの1行（`<li>`）。
 *
 * **クローンの本文だけを Markdown で描く。** 人間が打った本文は素のテキストのまま
 * （`*` や `#` を打ったとおりに見せる）。`system` も素のまま。
 *
 * - `transient` —— 進行中の合図（「考えている…」「Bash を実行中…」）。落ち着いたら
 *   画面が消す。**受信の印（`LiveIndicator`）と同じ心拍を付ける**——クローンが
 *   いま手を動かしている、という同じ事実だからである
 * - `onEdit` —— 渡したときだけ鉛筆を出す。**サーバで確定した人間の発言にだけ渡すこと**
 *   （送信中の楽観行はまだサーバに無いので、編集の入口を出してはいけない）
 * - `attachments` —— 発言に添えられたものを本文の下に描く（描く部品は呼ぶ側が渡す。ここは通信を知らない）。
 *   編集中は出さない
 * - `hasDraft` —— その発言に編集の書きかけが残っているとき。鉛筆を常に見せ、小さな点と名前で知らせる（#3565）
 * - `children` —— 渡すと本文の代わりに描く（編集中の下書き `ChatMessageEditor` など）
 *
 * クローンの本文が空（最初のチャンクがまだ届いていない）なら「…」を出す。
 */
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
  /** 鉛筆の目印（`data-edit-key`）。編集を閉じたあとのフォーカスの戻し先を、呼ぶ側が引くために付ける。 */
  editKey?: string;
  hasDraft?: boolean;
  versions?: ChatMessageVersions;
  attachments?: ReactNode;
  children?: ReactNode;
}) {
  // 伏せるのは描画の直前だけ（`text` も編集の下書きも元のまま持つ。issue #2600）。
  const { body } = useDisplayText();
  const shown = body(text);
  const editing = children !== undefined;
  const viewingOld = versions !== undefined && versions.index < versions.total - 1;
  // 添付だけで本文が空の人間の発言は、空の吹き出しを出さず添付だけを出す。
  const attachmentOnly = role === 'human' && text === '' && attachments !== undefined && !editing;

  return (
    <li className={cn('group flex flex-col gap-1', role === 'human' ? 'items-end' : 'items-start')}>
      {!attachmentOnly && (
        <div
          className={cn(
            'flex min-w-0 max-w-full items-start gap-1',
            role === 'clone' && 'w-full',
            // 編集欄が入ると外側は中身の幅に縮む（`items-end` の li の中）ので、
            // 元の吹き出しより狭くなる。編集中は読む幅の上限（46rem）まで広げる。
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
              // `break-words`: クローンの行は `Markdown`（components/markdown.tsx）
              // が自前で `min-w-0 ... break-words` を持つが、人間・システムの行は
              // 素のテキストを直接ここへ置くだけなので、同じ指定がここに無いと
              // 長い一続きの文字列（URL・パス等）で吹き出しがはみ出す。
              'min-w-0 text-sm leading-relaxed break-words',
              // 読む幅の上限は吹き出し（人間）と事情の行（システム）にだけ掛ける。
              // クローンの応答は地の上の本文なので、会話欄の幅いっぱい（`w-full`）に置く。
              role !== 'clone' && 'max-w-[46rem]',
              // クローンの本文だけ Markdown で描く（下のコメント参照）。
              // 人間・システムの行は素のテキストのままなので、これまでどおり
              // 改行をそのまま見せる。
              role !== 'clone' && 'whitespace-pre-wrap',
              /*
               * **吹き出しにするのは人間の発言だけ。** 主色で塗った吹き出しにして、
               * 「自分の発言」が一目で分かるようにする。
               *
               * **クローンの応答は吹き出しにしない**——地の上にそのまま本文として置く。
               * 応答は見出し・表・コードを含む長い Markdown になりがちで、枠に入れると
               * 読む幅が枠の内側へ削られ、縦に長い箱が積み重なって読みにくくなる
               * （人間の言葉で「AIのメッセージはバブルになってなくて良い」）。
               */
              // `selection:`: 吹き出しが `bg-primary` なので、既定の `::selection`
              // （主色の35%、`styles.css`）だと選択範囲が地と同じ色に溶けて、
              // 範囲選択しても何も見えない（選択自体はできている）。反転色で塗る。
              role === 'human' &&
                'rounded-lg bg-primary px-3 py-2 text-primary-foreground selection:bg-primary-foreground selection:text-primary',
              editing && role !== 'clone' && 'flex-1',
              role === 'clone' && 'w-full py-1',
              /*
               * 事情の行は板にしない（発言ではないので）。左の細い線で「差し込み」で
               * あることを示す。斜体にしないのは、和文の斜体は字形を歪めるだけで
               * 読みにくくなるからである。
               */
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
                /*
                 * **クローンの行だけを Markdown にする。** 人間が打った本文
                 * （`role === 'human'`）は素のテキストのままにする —
                 * 自分が書いた文字が勝手に化けないため。
                 *
                 * **受信中かどうかを見分ける信号は無い。** `Line` には
                 * `role` / `text` / `transient` しか無く、`transient` は
                 * 「考えている…」のような進行中の合図（`role: 'system'`）
                 * にしか立たない。クローンの返信行（`role: 'clone'`）は
                 * チャンクが届くたびに `text` を継ぎ足すだけで、「まだ
                 * 受信中か」を示す専用のフィールドを持たない。信号を
                 * 新設するには `packages/` や API 側の変更が要るが、
                 * それは今回の対象外（画面側だけで完結させる）。
                 *
                 * だから毎チャンク、届いた分だけの文字列を Markdown として
                 * パースし直すことになる。**まだ閉じていない ``` や `**`
                 * が受信の途中では正しく解釈されず、閉じた瞬間に表示が
                 * 変わって見える揺れが起きうる**（受信が終われば安定する）。
                 */
                <Markdown headingOffset={2}>{shown}</Markdown>
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

      {/*
        **ChatGPT 風の版切り替え（`< 2/2 >`）。** `versions` は編集で
        置き換えられた発言にしか付かない（`editVersions` の doc）ので、
        普通の発言では何も描かれず見た目は1文字も変わらない。
        編集中はいったん隠す——確定前の下書きと古い版の閲覧を同時に
        出すと、どちらを直しているのか読みにくくなるため。
      */}
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
          {/*
            **前の版へ戻ると、畳まれた発言が読める。** 古い版を見て
            いるあいだだけ、その版のすぐ後に隠れていた往復
            （`hiddenFollowUps`）も出す——ここが「前の版へ戻って
            読める」の本体である。
          */}
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
