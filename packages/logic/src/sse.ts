// SSE の読み取りは `@alteroid/api-client` の `readSse` を唯一の実装にする。
// `apps/cli` は `@alteroid/api-client` を依存に持たないが、`@alteroid/logic` は持つ: ここから再 export して cli も同じ実装を使う（SSE パーサが2本あったのを1本にした）。
export { readSse, type SseMessage } from '@alteroid/api-client';

// `data` を JSON として読む。読めなければ `null`（黙って捨てる側。`readJsonSse` は投げる）: cli の画面は壊れた1件で落とさず読み飛ばす。
export function parseSseJson<T>(message: { data: string }): T | null {
  try {
    return JSON.parse(message.data) as T;
  } catch {
    return null;
  }
}
