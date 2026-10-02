import type { ChatStreamEvent } from './schema.js';

/**
 * 会話ごとの「進行中のターンの途中経過」（Issue #2652）。
 *
 * `Clone#emit` は、その時点で購読している者にしか出来事を渡さない。画面を離れた・
 * 読み込み直した人間は、進行中のターンの「考えている」と途中の文章を失い、続きにも
 * 戻れなかった。ここはその会話に emit された出来事を**順に**覚えておき、あとから
 * 繋いだ購読者に「いままでの分」を先に渡せるようにする。
 *
 * - 覚えるのは `ChatStreamEvent` そのもの（線の上の形と同じ）。隣り合う `text` は1つに
 *   まとめる（差分を1文字ずつ持たない）
 * - `done` / `error` は終端なので、記録を捨てる（終端自体は記録しない。購読者へは
 *   ふつうに渡る）
 * - 終端を出さずに終わるターンがあっても残り続けないよう、`Clone` は `#finishTurn()`
 *   でも {@link clear} を呼ぶ
 *
 * 状態は `Map` 1本だけで、await も約束も持たない。{@link attach} の継ぎ目の保証
 * （写しを取ることと購読を張ることが同じ同期区間に入る）は、呼び出し側が
 * `snapshot()` と `subscribe` の間に `await` を挟まないことで成り立つ。
 */
export class CloneProgress {
  readonly #events = new Map<string, ChatStreamEvent[]>();

  /** 出来事を1件記録する。`done` / `error` ならその会話の記録を捨てる。 */
  record(conversationId: string, event: ChatStreamEvent): void {
    if (event.type === 'done' || event.type === 'error') {
      this.#events.delete(conversationId);
      return;
    }
    const events = this.#events.get(conversationId);
    if (events === undefined) {
      this.#events.set(conversationId, [event]);
      return;
    }
    const last = events[events.length - 1];
    if (event.type === 'text' && last?.type === 'text') {
      // 渡された event は呼び出し側のものなので、書き換えずに作り直す。
      events[events.length - 1] = { type: 'text', text: last.text + event.text };
      return;
    }
    events.push(event);
  }

  /**
   * いままでの分の写し。進行中でなければ `null`。呼び出し側が後から変えても
   * 記録は動かない（配列は作り直す。要素の event は読み取り専用として扱う）。
   */
  snapshot(conversationId: string): ChatStreamEvent[] | null {
    const events = this.#events.get(conversationId);
    return events === undefined ? null : [...events];
  }

  /** その会話の記録を捨てる（ターンの終わり・会話の終了）。 */
  clear(conversationId: string): void {
    this.#events.delete(conversationId);
  }

  /** 全部捨てる（クローンを畳むとき）。 */
  clearAll(): void {
    this.#events.clear();
  }

  /** 記録を持っている会話の数（テスト・観測用）。 */
  get size(): number {
    return this.#events.size;
  }
}
