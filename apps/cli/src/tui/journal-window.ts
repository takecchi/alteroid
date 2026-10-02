/**
 * 日誌の窓（いま持っている一覧）の送り方。純粋（I/O 無し）。
 *
 * **Web の `packages/logic/src/journal-window.ts`（と `use-journal-window.ts`）と同じ規則**:
 * `id` で重複を除く・新しい順を保つ・`since` / `until` は inclusive なので「新規 0 件」だけでは
 * 終端と言えない（`pageOutcome`）・初期読み込みは窓を持たないので `limit` 未満なら終端と言い切れる。
 *
 * **なぜ写したか。** `@alteroid/logic` を apps/cli から import すると `tsc --noEmit` が落ちる
 * （logic は `.ts` を直接 export し、中の相対 import に拡張子が無い。apps/cli は node16 解決で
 * `TS2835`）。tsconfig を触る範囲は依頼の外なので、規則の写しをここに置く。**Web 側の規則を
 * 変えたらここも直すこと**（テストは Web の `journal-window.test.ts` の表と同じ値を見ている）。
 * 写したのは純関数だけで、データの形（`JournalEntry`）と照合（`matchesJournalSearch`）は
 * `@alteroid/core` のものをそのまま使う。
 */
import type { JournalEntry } from '@alteroid/core';

/** 初期表示・1 回の「もっと遡る」で読む件数（Web の `JOURNAL_PAGE`）。 */
export const JOURNAL_PAGE = 100;
/** サーバの `limit` の上限（`journalQuery`。Web の `JOURNAL_MAX_LIMIT`）。 */
export const JOURNAL_MAX_LIMIT = 1000;
/**
 * 持っておく日誌の文字数の予算（件数ではなく、エントリを JSON にした長さの合計）。
 * 件数で締めると、`tool_use` の入力のような大きい行が並んだときに何件で壊れるかが運任せになる
 * （`.claude/skills/listing-and-detail`）。
 */
export const JOURNAL_RETAIN_CHARS = 400_000;
/** 詳細 1 件で描く文字数の上限。超えたら省いた字数を言う。 */
export const JOURNAL_DETAIL_CHARS = 60_000;

export interface MergeResult {
  entries: JournalEntry[];
  /** 重複除去の後に残った、本当に新しい件数。 */
  freshCount: number;
}

/** 先頭（新着側）へ差し込む。 */
export function mergeFront(existing: JournalEntry[], incoming: JournalEntry[]): MergeResult {
  if (incoming.length === 0) return { entries: existing, freshCount: 0 };
  const known = new Set(existing.map((entry) => entry.id));
  const fresh = incoming.filter((entry) => !known.has(entry.id));
  return {
    entries: fresh.length === 0 ? existing : [...fresh, ...existing],
    freshCount: fresh.length,
  };
}

/** 末尾（過去側）へ差し込む。 */
export function mergeBack(existing: JournalEntry[], incoming: JournalEntry[]): MergeResult {
  if (incoming.length === 0) return { entries: existing, freshCount: 0 };
  const known = new Set(existing.map((entry) => entry.id));
  const fresh = incoming.filter((entry) => !known.has(entry.id));
  return {
    entries: fresh.length === 0 ? existing : [...existing, ...fresh],
    freshCount: fresh.length,
  };
}

/**
 * ページを撃った結果、次に何をすべきか（Web の `pageOutcome`）。`since` / `until` は inclusive で、
 * 境界の 1 件は毎回再度返る。
 * - 前進できた → `progress`
 * - 前進 0 かつ `limit` 未満 → `end`（探しうる範囲を全部見た）
 * - 前進 0 かつ `limit` ちょうど かつ上限未満 → `retryLarger`（同じ時刻の行が並んで詰まっている疑い）
 * - 上限まで上げても前進 0 → `blocked`（終端でも空でもない本物の限界。黙って終端に見せない）
 */
export type PageOutcome = 'progress' | 'end' | 'retryLarger' | 'blocked';

export function pageOutcome(
  pageLength: number,
  limit: number,
  freshCount: number,
  maxLimit: number = JOURNAL_MAX_LIMIT,
): PageOutcome {
  if (freshCount > 0) return 'progress';
  if (pageLength < limit) return 'end';
  return limit < maxLimit ? 'retryLarger' : 'blocked';
}

export interface PageApplication {
  entries: JournalEntry[];
  outcome: PageOutcome;
  freshCount: number;
}

/** 初期読み込み（窓なし）。`limit` 未満で返った時点で終端と言い切れる。 */
export function applyInitialPage(page: JournalEntry[], limit: number): PageApplication {
  return {
    entries: page,
    outcome: page.length < limit ? 'end' : 'progress',
    freshCount: page.length,
  };
}

export function applyOlderPage(
  existing: JournalEntry[],
  page: JournalEntry[],
  limit: number,
  maxLimit: number = JOURNAL_MAX_LIMIT,
): PageApplication {
  const merged = mergeBack(existing, page);
  return {
    entries: merged.entries,
    outcome: pageOutcome(page.length, limit, merged.freshCount, maxLimit),
    freshCount: merged.freshCount,
  };
}

export function applyNewerPage(
  existing: JournalEntry[],
  page: JournalEntry[],
  limit: number,
  maxLimit: number = JOURNAL_MAX_LIMIT,
): PageApplication {
  const merged = mergeFront(existing, page);
  return {
    entries: merged.entries,
    outcome: pageOutcome(page.length, limit, merged.freshCount, maxLimit),
    freshCount: merged.freshCount,
  };
}

/** 過去方向へ次に撃つ引数（一覧の末尾＝最古の `at`）。一覧が空なら撃たない。 */
export function olderPageQuery(entries: JournalEntry[]): { until: string } | undefined {
  const until = entries.at(-1)?.at;
  return until === undefined ? undefined : { until };
}

/** 新着方向へ次に撃つ引数（一覧の先頭＝最新の `at`）。一覧が空なら撃たない。 */
export function newerPageQuery(entries: JournalEntry[]): { since: string } | undefined {
  const since = entries[0]?.at;
  return since === undefined ? undefined : { since };
}

/**
 * 終端（`end`）が日誌の地平より前にかかっていたときの注記（Web の `journalHorizonNote`）。
 * `end` でなければ常に `undefined`（常に出ている注記は、本当に終端に達したときの目印にならない）。
 */
export function journalHorizonNote(
  outcome: PageOutcome,
  oldestAt: string | null | undefined,
  crossesHorizon: boolean | undefined,
): string | undefined {
  if (outcome !== 'end') return undefined;
  if (crossesHorizon !== true) return undefined;
  if (oldestAt === null || oldestAt === undefined) return undefined;
  return (
    `この記憶ストアの日誌の最古は ${oldestAt}。それより前に本当に何も無かったのか、` +
    '記録がそこまで遡れないだけなのかは、この一覧だけからは区別できない。'
  );
}

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
