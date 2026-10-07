import { Button, CodeBlock } from '@alteroid/ui';

/**
 * 答えは通ったが、送らなかった下書きが残っている承認（issue #3515・#3625）。**黙って消さない。**
 * 承認はもう決着していて回答欄が無いので、残った文をここへ出す。写してから閉じられる。
 * 承認の画面と会話の画面が同じものを出す（#3861）。
 */
export function LeftoverDrafts({
  leftovers,
  onDiscard,
}: {
  leftovers: { id: string; source: { question: string }; text: string }[];
  onDiscard: (id: string) => void;
}) {
  if (leftovers.length === 0) return null;
  return (
    <ul className="mb-4 flex flex-col gap-3" aria-label="送らなかった下書きが残っている承認">
      {leftovers.map(({ id, source, text }) => (
        <li key={id} className="rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-sm">
          <p className="mb-2 break-words">
            <strong>答えは通ったが、送らなかった下書きが残っている。</strong>
            承認はもう決着しているので、ここから送り直すことはできない。必要なら写してから閉じる。
            <span className="mt-1 block text-xs text-muted-foreground">
              対象: {source.question}
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
