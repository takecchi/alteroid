// CLI の chat（chat.ts）と TUI（tui/）が同じ規則で読むために、ここ1か所に置く。
// 余分な語・知らない語は使い方の誤りとして断る: 黙って捨てたり既定へ倒したりすると、綴り違いが別の意味で通るため。

export function isKeyword(token: string | undefined, keyword: string): boolean {
  return token !== undefined && token.toLowerCase() === keyword.toLowerCase();
}

export function surplusWordMessage(word: string, usable: string): string {
  return `使わない語です: ${word}（使えるのは ${usable}）`;
}

export function noArgumentsMessage(command: string, word: string): string {
  return surplusWordMessage(word, `${command} だけ。引数は取りません`);
}

// 先頭の語だけを小文字にそろえる: 引数（パス・本文）の大文字小文字は意味を持つため。`//` で始まる行は本文として送るので触らない
export function normalizeCommandWord(line: string): string {
  return line.replace(/^\/(?!\/)\S+/, (word) => word.toLowerCase());
}

export function firstWord(args: string): string | undefined {
  return args.split(/\s+/).find((word) => word.length > 0);
}

export type ParsedCount = { ok: true; value: number } | { ok: false; message: string };

// `Number()` に任せず `/^\d+$/` で読む: `1e1`・`0x10`・`+5`・`1.0` を数として通さないため。`max` が無ければ上限はデーモンに任せる
export function parseCountArg(token: string, max?: number): ParsedCount {
  const range = max === undefined ? '1 以上の' : `1〜${String(max)} の`;
  const value = /^\d+$/.test(token) ? Number(token) : NaN;
  if (!Number.isSafeInteger(value) || value < 1 || (max !== undefined && value > max)) {
    return { ok: false, message: `件数は ${range}整数で指定する（${token}）` };
  }
  return { ok: true, value };
}
