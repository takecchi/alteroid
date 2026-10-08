import type { ApprovalLeftoverSource } from '@alteroid/logic';
import { Button, CodeBlock } from '@alteroid/ui';

/**
 * 承認が決着していて回答欄が無いのに、書いたものが残っている承認（issue #3515・#3625・#3869・#3927）。
 * **黙って消さない。** 残った文をここへ出す。写してから閉じられる。
 * 承認の画面と会話の画面が同じものを出す（#3861）。
 * 言い分けるのは、自分の答えが通った場合・409 で断られた場合・送らないまま一覧から外れた場合
 * （`source.origin`）。`source` が無いのは、一覧で見たことの無い id（再読み込み前の下書き）。
 */
export function LeftoverDrafts({
  leftovers,
  onDiscard,
}: {
  leftovers: { id: string; source: ApprovalLeftoverSource | undefined; text: string }[];
  onDiscard: (id: string) => void;
}) {
  if (leftovers.length === 0) return null;
  return (
    <ul className="mb-4 flex flex-col gap-3" aria-label="送らなかった下書きが残っている承認">
      {leftovers.map(({ id, source, text }) => (
        <li key={id} className="rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-sm">
          <p className="mb-2 break-words">
            <strong>
              {source?.origin === undefined && source !== undefined
                ? '答えは通ったが、送らなかった下書きが残っている。'
                : source?.origin === 'conflict'
                  ? '回答は送ったが、承認が先に決着していて断られた（409）。書いた答えは残してある。'
                  : 'この承認は先に決着した（または一覧から外れた）。書きかけは残してある。'}
            </strong>
            承認はもう決着しているので、ここから送り直すことはできない。必要なら写してから閉じる。
            <span className="mt-1 block text-xs text-muted-foreground">
              対象: {source === undefined ? `本文の写しが無い（id: ${id}）` : source.question}
            </span>
          </p>
          <CodeBlock label="残った文" maxHeight="12rem">
            {text}
          </CodeBlock>
          <div className="mt-2">
            <Button size="sm" onClick={() => onDiscard(id)}>
              閉じる（捨てる）
            </Button>
          </div>
        </li>
      ))}
    </ul>
  );
}
