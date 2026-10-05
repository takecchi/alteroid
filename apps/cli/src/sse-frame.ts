/**
 * SSE の1フレームの解釈（issue #2860。`chat.ts` から分けた）。
 *
 * `chat.ts` は core 全体を読むので、`topology.ts` が `tui/sse.ts` 経由で
 * `parseSSEChunk` だけを取るたびに起動で評価される形になっていた。
 * `chat.ts` はここから再 export するので、既存の import 元は変わらない。
 */
export interface SSEEvent {
  name: string;
  data: string;
  json<T>(): T | null;
}

/**
 * SSE の1フレーム（空行までの塊）を読む。**`null` は「読み飛ばす」の意味である。**
 *
 * `event:` / `data:` 以外の行は無視するので、コメント行（`:` 始まり。デーモンが
 * 無音死の掃除のために周期的に流す heartbeat）だけの塊は `data:` が1本も無く、
 * ここで `null` になって `readSSE` から yield されない。
 *
 * **export しているのは試験のためである**（`./chat.test.ts`）。デーモン側の
 * heartbeat が `alteroid chat` を壊さないことは、実装を読めば分かるが読むだけでは
 * 固定されない —— 誰かがこの関数を「未知の行はエラーにしよう」と直した日に、
 * 落ちるのは CLI の実行時であって型検査ではない。挙動は1文字も変えていない。
 */
export function parseSSEChunk(chunk: string): SSEEvent | null {
  let name = 'message';
  const dataLines: string[] = [];

  for (const line of chunk.split('\n')) {
    if (line.startsWith('event:')) name = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
  }
  if (dataLines.length === 0) return null;

  const data = dataLines.join('\n');
  return {
    name,
    data,
    json<T>(): T | null {
      try {
        return JSON.parse(data) as T;
      } catch {
        return null;
      }
    },
  };
}
