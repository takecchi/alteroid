import { useDisplayText } from '@/lib/display-text';

// CLI・TUI の「（取り下げた発言）」（apps/cli/src/withdrawn-message.ts）と同じ語。入口ごとに言い方がずれないため
export const WITHDRAWN_MESSAGE_LABEL = '（取り下げた発言）';

// 普通の吹き出し（ChatMessage）にしない: 順番待ちのうちに取り下げられ、クローンへ配られていない発言のため。本文は畳んで薄く出す
export function ChatWithdrawnMessage({ text }: { text: string }) {
  const { body } = useDisplayText();
  return (
    <li data-withdrawn-message className="min-w-0 text-xs text-muted-foreground">
      <details>
        <summary className="cursor-pointer py-1">{WITHDRAWN_MESSAGE_LABEL}</summary>
        <p className="whitespace-pre-wrap break-words pl-3 opacity-70">{body(text)}</p>
      </details>
    </li>
  );
}
