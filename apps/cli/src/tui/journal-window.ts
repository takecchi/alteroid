// `JOURNAL_PAGE` をここに持つ: 元は `@alteroid/swr` の `use-journal-window.ts`（react と swr を持つ）に在り、logic には無いため
import type { JournalEntry } from '@alteroid/core';

// 件数ではなく文字数で締める: `tool_use` の入力のような大きい行が並んだとき、何件で壊れるかが運任せになるため
export const JOURNAL_RETAIN_CHARS = 400_000;
export const JOURNAL_DETAIL_CHARS = 60_000;

const SIZES = new WeakMap<JournalEntry, number>();

export function entryChars(entry: JournalEntry): number {
  let size = SIZES.get(entry);
  if (size === undefined) {
    size = JSON.stringify(entry).length;
    SIZES.set(entry, size);
  }
  return size;
}

export interface Budgeted {
  entries: JournalEntry[];
  chars: number;
  dropped: number;
}

export function trimToBudget(
  entries: JournalEntry[],
  budget: number = JOURNAL_RETAIN_CHARS,
): Budgeted {
  let chars = 0;
  for (const entry of entries) chars += entryChars(entry);
  let end = entries.length;
  while (chars > budget && end > 1) {
    end -= 1;
    const last = entries[end];
    if (last !== undefined) chars -= entryChars(last);
  }
  return {
    entries: end === entries.length ? entries : entries.slice(0, end),
    chars,
    dropped: entries.length - end,
  };
}

export interface ListWindow {
  start: number;
  end: number;
}

export function listWindow(
  count: number,
  selectedFromNewest: number,
  follow: boolean,
  height: number,
): ListWindow {
  const cap = Math.max(1, height);
  if (count <= cap) return { start: 0, end: count };
  if (follow) return { start: count - cap, end: count };
  const shown = count - 1 - selectedFromNewest;
  const start = Math.min(Math.max(0, shown - Math.floor(cap / 2)), count - cap);
  return { start, end: start + cap };
}
