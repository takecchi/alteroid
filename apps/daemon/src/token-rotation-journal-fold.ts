import { JournalFoldWindow, foldedRunText, type TokenRotationEntry } from '@alteroid/core';
import { TOKEN_WATCH_TICK_MS } from './token-watch.js';

// idleGap を tick 周期（60秒）と同じにしない: 60秒ちょうどの tick は毎回「途切れた」と判定され、1行も畳めないため。
// 2倍にしない: tick のジッタ次第で境界に近いままのため。3倍にしない: 2分以内の本物の再発まで畳んでしまうため。
export const TOKEN_ROTATION_JOURNAL_FOLD_IDLE_GAP_MS = TOKEN_WATCH_TICK_MS * 2.5;

// maxSpan を既定の5分にしない: 5時間の冷却で約60本の要約行が出て、行を減らす目的に合わないため。
export const TOKEN_ROTATION_JOURNAL_FOLD_MAX_SPAN_MS = 60 * 60_000;

export interface TokenRotationJournalFoldVerdict {
  readonly write: boolean;
  readonly summary?: TokenRotationEntry;
}

// 署名に区切り（`\u0000`）を挟む: 素朴に連結すると `event` と `text` の切れ目が違う組が同じ文字列になりうるため。
export function tokenRotationFoldSignature(entry: TokenRotationEntry): string {
  return `${entry.event}\u0000${entry.text}`;
}

export class TokenRotationJournalFold {
  readonly #window: JournalFoldWindow;
  // 要約の構造欄はこれを引き継ぐ: `JournalFoldWindow` は `text` しか覚えていないため。
  #lastEntry: TokenRotationEntry | undefined;

  constructor(options: { idleGapMs?: number; maxSpanMs?: number; maxSuppressed?: number } = {}) {
    this.#window = new JournalFoldWindow({
      idleGapMs: options.idleGapMs ?? TOKEN_ROTATION_JOURNAL_FOLD_IDLE_GAP_MS,
      maxSpanMs: options.maxSpanMs ?? TOKEN_ROTATION_JOURNAL_FOLD_MAX_SPAN_MS,
      ...(options.maxSuppressed === undefined ? {} : { maxSuppressed: options.maxSuppressed }),
    });
  }

  observe(entry: TokenRotationEntry, atMs: number): TokenRotationJournalFoldVerdict {
    const verdict = this.#window.observe(tokenRotationFoldSignature(entry), entry.text, atMs);
    const summary =
      verdict.flush === undefined
        ? undefined
        : { ...(this.#lastEntry ?? entry), text: foldedRunText(verdict.flush) };
    this.#lastEntry = entry;
    return summary === undefined ? { write: verdict.write } : { write: verdict.write, summary };
  }

  flush(): TokenRotationEntry | undefined {
    const flushed = this.#window.flush();
    if (flushed === undefined || this.#lastEntry === undefined) return undefined;
    return { ...this.#lastEntry, text: foldedRunText(flushed) };
  }
}
