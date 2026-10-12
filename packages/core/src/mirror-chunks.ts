/**
 * 生ログの写し（`mirror`）を、1件の出来事あたりの大きさに上限を付けて分ける（#4485）。
 *
 * SDK の生ログの書き出し1回分を丸ごと1件で送ると、数十 MB の SSE の1行になり、デーモンはそれを受けてから
 * 解析・NUL の除去・jsonb への直列化までを同期で行うので、その間ループが秒単位で塞がる（本番の `loop-stall` で 84MB・1.6 秒）。
 * 分けて送れば、デーモンは1件ずつ（フレームの間で読み取りを待つたびにループを返しながら）処理できる。
 *
 * 行（entry）の中身は切らない: 生ログは resume の土台で、欠けると会話が戻らない。上限を1行だけで超える行は、その行だけで1件にする。
 * 順は保つ（デーモン側も同じ生ログへの預けを届いた順に並べる。`manager.ts` の `case 'mirror'`）。
 */

/** 1件の `mirror` の `entries` の、JSON の文字数の上限の見積もり。 */
export const MIRROR_EVENT_MAX_CHARS = 1_000_000;

/**
 * 値を JSON にしたときの文字数の見積もり（下回らない側に倒す）。`JSON.stringify` で測らない: 測るために丸ごと1回写すと、
 * 送るときの直列化と合わせて runner の側で2倍の時間をループの上で使うため。文字列はエスケープで最大6倍になるが、
 * 制御文字・引用符・`\` を数えて足すので、エスケープの無い本文は長さ＋2で済む。
 */
export function approxJsonChars(value: unknown): number {
  if (typeof value === 'string') return stringChars(value);
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
    return String(value).length;
  }
  if (Array.isArray(value)) {
    let total = 2 + Math.max(0, value.length - 1);
    for (const item of value) total += item === undefined ? 4 : approxJsonChars(item);
    return total;
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    let total = 2;
    let first = true;
    for (const key of Object.keys(record)) {
      const item = record[key];
      if (item === undefined || typeof item === 'function') continue;
      total += (first ? 0 : 1) + stringChars(key) + 1 + approxJsonChars(item);
      first = false;
    }
    return total;
  }
  return 0;
}

function stringChars(value: string): number {
  let escapes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    // 制御文字と、孤立したサロゲート（対になっていれば素のまま出るが、区別せず多めに数える）は `\uXXXX`（6文字）になりうる。`"` と `\` は2文字
    if (code < 0x20 || (code >= 0xd800 && code <= 0xdfff)) escapes += 5;
    else if (code === 0x22 || code === 0x5c) escapes += 1;
  }
  return value.length + 2 + escapes;
}

/** 順を保ったまま、各塊の見積もりが `maxChars` を超えないように分ける。1行だけで超える行は単独の塊にする。空なら空。 */
export function chunkMirrorEntries<T>(entries: readonly T[], maxChars: number): T[][] {
  const chunks: T[][] = [];
  let current: T[] = [];
  let size = 2;
  for (const entry of entries) {
    const chars = approxJsonChars(entry);
    const added = (current.length === 0 ? 0 : 1) + chars;
    if (current.length > 0 && size + added > maxChars) {
      chunks.push(current);
      current = [];
      size = 2;
    }
    current.push(entry);
    size += (current.length === 1 ? 0 : 1) + chars;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}
