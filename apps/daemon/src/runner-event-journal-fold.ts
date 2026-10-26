import { JournalFoldWindow, foldedRunText } from '@alteroid/core';

// 上限を超えた新しいキーは畳まない: Map を無限に太らせないため。畳まない側へ倒すのは、書かなかった行は戻らないが、余分に書いた行は後から減らせるため。
export const RUNNER_EVENT_JOURNAL_FOLD_MAX_KEYS = 256;

export interface RunnerEventJournalFoldVerdict {
  readonly write: boolean;
  // `foldedRunText` で作った要約の本文。先に書く（日誌は時系列で読まれ、次の1件目より後ろに出ると係り先がずれるため）。
  readonly summary?: string;
}

// 署名は summary そのもの: 本文が1文字でも違えば別の出来事（別の RPC・別の理由）で、畳むと証拠が消えるため。
// 窓の定数（idleGap / maxSpan / maxSuppressed）は既定のまま: 器の期限切れは tick 周期を持たず、周期に合わせる根拠が無いため。
export class RunnerEventJournalFold {
  readonly #windows = new Map<string, JournalFoldWindow>();

  observe(key: string, summary: string, atMs: number): RunnerEventJournalFoldVerdict {
    let window = this.#windows.get(key);
    if (window === undefined) {
      if (this.#windows.size >= RUNNER_EVENT_JOURNAL_FOLD_MAX_KEYS) return { write: true };
      window = new JournalFoldWindow();
      this.#windows.set(key, window);
    }
    const verdict = window.observe(summary, summary, atMs);
    return verdict.flush === undefined
      ? { write: verdict.write }
      : { write: verdict.write, summary: foldedRunText(verdict.flush) };
  }

  flushAll(): string[] {
    const out: string[] = [];
    for (const window of this.#windows.values()) {
      const flushed = window.flush();
      if (flushed !== undefined) out.push(foldedRunText(flushed));
    }
    return out;
  }
}

// 書く型をこの1つに固定する: 畳みの経路から、人間・クローンの行や決着の行を書ける口を作らないため（#1311）。
export interface RunnerEventJournalEntry {
  readonly type: 'external_event';
  readonly source: 'runner';
  readonly summary: string;
}

export interface RunnerEventJournalDropped {
  // `entry` = 1件目の行、`folded` = 畳んだ要約の行。
  readonly kind: 'entry' | 'folded';
  readonly summary: string;
  readonly error: unknown;
}

export interface RunnerEventJournalWriter {
  write(key: string, summary: string): Promise<void>;
  flushAll(): Promise<void>;
}

export function createRunnerEventJournalWriter(options: {
  journal: { append(entry: RunnerEventJournalEntry): Promise<unknown> };
  fold: RunnerEventJournalFold;
  now: () => number;
  onDropped: (dropped: RunnerEventJournalDropped) => void;
}): RunnerEventJournalWriter {
  const { journal, fold, now, onDropped } = options;

  // 追記の失敗を投げ直さない: 呼び手（RPC の期限切れの通知）を巻き込まないため。
  const append = async (kind: 'entry' | 'folded', summary: string): Promise<void> => {
    try {
      await journal.append({ type: 'external_event', source: 'runner', summary });
    } catch (error: unknown) {
      onDropped({ kind, summary, error });
    }
  };

  return {
    async write(key, summary) {
      const verdict = fold.observe(key, summary, now());
      if (verdict.summary !== undefined) await append('folded', verdict.summary);
      if (verdict.write) await append('entry', summary);
    },
    async flushAll() {
      for (const summary of fold.flushAll()) await append('folded', summary);
    },
  };
}
