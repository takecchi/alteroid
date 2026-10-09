// CLI の chat（chat.ts）と TUI（tui/）が、スラッシュコマンドの引数を同じ規則で読むための部品（#4356）。
// 規則は3つ: (1) 余分な語・知らない語は使い方の誤りとして断る（黙って捨てない・既定へ倒さない）
// (2) 件数・分の数は `/^\d+$/` と上限で読む（`1e1`・`0x10` を通さない）
// (3) キーワード引数（all・kept・more・yes …）は、コマンドの語と同じく大文字小文字を区別しない。

// キーワード引数の一致。`ALL` と `all` を同じに読む。
export function isKeyword(token: string | undefined, keyword: string): boolean {
  return token !== undefined && token.toLowerCase() === keyword.toLowerCase();
}

// 余分な語・知らない語を断る文。`usable` は使えるものの言い方（例: `/commitments、/commitments all`）。
export function surplusWordMessage(word: string, usable: string): string {
  return `使わない語です: ${word}（使えるのは ${usable}）`;
}

// 引数を取らないコマンドに語が付いたときの文。
export function noArgumentsMessage(command: string, word: string): string {
  return surplusWordMessage(word, `${command} だけ。引数は取りません`);
}

// スラッシュコマンドの語（先頭の語）だけを小文字にそろえる。引数（パス・本文）の大文字小文字は変えない。`//` で始まる行（本文として送る）は触らない。
export function normalizeCommandWord(line: string): string {
  return line.replace(/^\/(?!\/)\S+/, (word) => word.toLowerCase());
}

// 空白で割った引数の最初の非空の語。
export function firstWord(args: string): string | undefined {
  return args.split(/\s+/).find((word) => word.length > 0);
}

export type ParsedCount = { ok: true; value: number } | { ok: false; message: string };

// 件数・分の数。`/^\d+$/` だけを通し、`1e1`・`0x10`・`+5`・`1.0` は断る。`max` が無ければ上限はデーモンに任せる。
export function parseCountArg(token: string, max?: number): ParsedCount {
  const range = max === undefined ? '1 以上の' : `1〜${String(max)} の`;
  const value = /^\d+$/.test(token) ? Number(token) : NaN;
  if (!Number.isSafeInteger(value) || value < 1 || (max !== undefined && value > max)) {
    return { ok: false, message: `件数は ${range}整数で指定する（${token}）` };
  }
  return { ok: true, value };
}
