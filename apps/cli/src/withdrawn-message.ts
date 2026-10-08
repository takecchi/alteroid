// 取り下げた発言（`GET /conversations/:id` の `delivery: 'withdrawn'`）の出し方。CLI の `/conversation`・`conversations show`・TUI の履歴が共有する: 入口ごとに言い方がずれないため
// Web の `ChatWithdrawnMessage`（packages/ui）と同じ「（取り下げた発言）」の語を使う。apps 同士はパッケージを共有しないので、ここに書き写している
export const WITHDRAWN_MESSAGE_LABEL = '（取り下げた発言）';

const PREVIEW_CHARS = 60;

// 本文は薄く・畳んで出す: 配られていない発言を、普通の発言として読ませないため。全文は日誌に残っている
export function withdrawnMessageText(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat === '') return WITHDRAWN_MESSAGE_LABEL;
  const chars = [...flat];
  const shown = chars.length <= PREVIEW_CHARS ? flat : `${chars.slice(0, PREVIEW_CHARS).join('')}…`;
  return `${WITHDRAWN_MESSAGE_LABEL}${shown}`;
}
