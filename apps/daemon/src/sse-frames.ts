/**
 * SSE の受け取った文字列を、空行（`\n\n`）で区切られたフレームに分ける（#4485）。
 *
 * 受け取るたびに1本の文字列へ足して先頭から区切りを探す形にしない: 数十 MB のフレーム（archive の本文など）が
 * 64KB ずつ届くと、足すたびに文字列全体がまとめ直され、探すたびに全体を走査するので、写しと走査が2乗で増える
 * （36MB で CPU 2.5 秒。その間、他の出来事も名乗りの確認の応答も待たされる）。かけらのまま持ち、区切りは新しく届いた分だけで探し、
 * フレームが揃ったときに1回だけ連結する（同じ 36MB で 77ms）。
 *
 * 区切りの規則は前と同じ（`\n\n` だけを見る。`\r\n` は扱わない）。かけらを跨いだ区切り（前のかけらの末尾の `\n` と、次の先頭の `\n`）も拾う。
 */
export class SseFrameSplitter {
  #pieces: string[] = [];
  // 持っているかけらの最後が `\n` で終わるか（次のかけらの先頭の `\n` と合わせて区切りになる）
  #tailNewline = false;

  /** 新しく届いた文字列を渡し、揃ったフレーム（区切りの空行を除いた本文）を古い順に返す。 */
  push(chunk: string): string[] {
    const frames: string[] = [];
    let text = chunk;
    for (;;) {
      if (this.#tailNewline && text.startsWith('\n')) {
        const joined = this.#pieces.join('');
        frames.push(joined.slice(0, -1));
        this.#pieces = [];
        this.#tailNewline = false;
        text = text.slice(1);
        continue;
      }
      const boundary = text.indexOf('\n\n');
      if (boundary === -1) break;
      this.#pieces.push(text.slice(0, boundary));
      frames.push(this.#pieces.join(''));
      this.#pieces = [];
      this.#tailNewline = false;
      text = text.slice(boundary + 2);
    }
    if (text.length > 0) {
      this.#pieces.push(text);
      this.#tailNewline = text.endsWith('\n');
    }
    return frames;
  }
}
