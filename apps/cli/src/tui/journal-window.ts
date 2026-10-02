/**
 * 日誌の窓（いま持っている一覧）のうち、**TUI にだけ在る**部分。純粋（I/O 無し）。
 *
 * ページの送り方（`mergeFront` / `mergeBack` / `pageOutcome` / `apply*Page` / `*PageQuery` /
 * `journalHorizonNote` と `JOURNAL_MAX_LIMIT`）は Web と同じ規則なので、写さずに
 * `@alteroid/logic` から import する（#2558。呼ぶ側が直接 import する）。ここに残すのは、
 * 端末の都合で持つもの — 文字数の予算（`trimToBudget`）と、古い→新しいの向きの可視窓
 * （`listWindow`。Web は virtua が持つので logic に同じものは無い）。`JOURNAL_PAGE` も残す — 元は
 * `@alteroid/swr` の `use-journal-window.ts`（react と swr を持つ）に在り、logic には無いため。
 */
import type { JournalEntry } from '@alteroid/core';

/**
 * 持っておく日誌の文字数の予算（件数ではなく、エントリを JSON にした長さの合計）。
 * 件数で締めると、`tool_use` の入力のような大きい行が並んだときに何件で壊れるかが運任せになる
 * （`.claude/skills/listing-and-detail`）。
 */
export const JOURNAL_RETAIN_CHARS = 400_000;
/** 詳細 1 件で描く文字数の上限。超えたら省いた字数を言う。 */
export const JOURNAL_DETAIL_CHARS = 60_000;

const SIZES = new WeakMap<JournalEntry, number>();

/** 1 件の大きさ（JSON にした長さ）。予算の単位。 */
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
  /** 予算を超えて、古い側から捨てた件数。 */
  dropped: number;
}

/** 文字数の予算で古い側から締める（最低 1 件は残す）。 */
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
  /** 古い→新しいの並びで描く範囲 `[start, end)`（表示位置。0 = 一番古い）。 */
  start: number;
  end: number;
}

/**
 * 可視窓。表示は古い→新しい（末尾が最新のログの形）。`selectedFromNewest` は新しい順での
 * 選択位置（0 = 最新）。追従中は末尾を見せ、遡っている間は選択を窓の中ほどに置く —
 * 選択は `id` で持つので、新着が末尾に足されても窓の位置は動かない。
 */
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
