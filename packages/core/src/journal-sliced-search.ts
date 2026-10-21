import type { JournalEntry } from './schema.js';
import type { JournalCursor, JournalQuery, JournalStore } from './store.js';

/** 語の検索で、新しい側から1回に問い合わせる窓の幅（#5126）。 */
export const JOURNAL_SEARCH_SLICE_MS = 24 * 60 * 60 * 1000;
/** 語の検索の1回の呼び出しの時間の予算（#5126）。使い切ったら、探した範囲を名乗って止める。 */
export const JOURNAL_SEARCH_BUDGET_MS = 8_000;

export interface JournalSlicedSearchOptions {
  readonly sliceMs?: number;
  readonly budgetMs?: number;
  /** 予算を測る時計（ms）。試験が進め方を決めるための口。 */
  readonly clock?: () => number;
  /** `until` も継続点も無いときの上端。試験が「いま」を決めるための口。 */
  readonly now?: () => Date;
}

export type JournalSearchCoverage =
  /** `since`（無ければ日誌の最古）まで探し切った。 */
  | { readonly kind: 'complete' }
  /** 時間の予算を使い切った。`from`〜`to` は探した、`from` より古い側は見ていない。 */
  | { readonly kind: 'budget'; readonly from: string; readonly to: string };

export interface JournalSlicedSearchResult {
  readonly entries: JournalEntry[];
  /** 件数が埋まって、まだ当たりがありうるときの続きの位置（`afterId` / `afterAt` に渡す）。 */
  readonly next: JournalCursor | null;
  readonly coverage: JournalSearchCoverage;
}

/**
 * 語で探すとき、日誌を新しい側から窓（既定1日）で区切って遡る（#5126）。
 * 1本の問い合わせで日誌の先頭まで読むと、当たりの少ない語は本番の大きさで数十秒かかり、その間なにも返らないため。
 * 窓は `since` / `until` で閉じるので、時刻の索引に乗る。次の窓の上端は前の窓の下端の 1ms 手前にする: 下端は含む（`>=`）ので、重ねると境目の行が二重に出るため。
 * 予算は窓を1つ終えるたびに見る（窓の途中では切らない）。範囲を黙って狭めない: 打ち切ったら、探した範囲を `coverage` で返し、呼び手が名乗る。
 */
export async function searchJournalBackwardInSlices(
  journal: Pick<JournalStore, 'listPage' | 'oldestAt'>,
  query: JournalQuery & { readonly q: string; readonly limit: number },
  options: JournalSlicedSearchOptions = {},
): Promise<JournalSlicedSearchResult> {
  const sliceMs = options.sliceMs ?? JOURNAL_SEARCH_SLICE_MS;
  const budgetMs = options.budgetMs ?? JOURNAL_SEARCH_BUDGET_MS;
  const clock = options.clock ?? (() => performance.now());
  const started = clock();

  const oldest = query.since ?? (await journal.oldestAt());
  if (oldest === null) return { entries: [], next: null, coverage: { kind: 'complete' } };
  const floorMs = Date.parse(oldest);
  const top = query.after?.at ?? query.until ?? (options.now?.() ?? new Date()).toISOString();

  // 窓の境目（since / until / limit）と継続点は、ここで窓ごとに決め直す
  const { after, since: _since, until: _until, limit, ...filters } = query;
  void _since;
  void _until;

  const entries: JournalEntry[] = [];
  let upper = top;
  let first = true;
  for (;;) {
    const lowerMs = Math.max(Date.parse(upper) - sliceMs, floorMs);
    const lower = new Date(lowerMs).toISOString();
    const page = await journal.listPage({
      ...filters,
      limit: limit - entries.length,
      since: lower,
      until: upper,
      // 継続点は最初の窓にだけ渡す: 錨はその窓の上端に在り、次の窓はもう錨より古い
      ...(first && after !== undefined ? { after } : {}),
    });
    first = false;
    entries.push(...page.entries);
    if (page.next !== null) {
      return { entries, next: page.next, coverage: { kind: 'complete' } };
    }
    const reachedFloor = lowerMs <= floorMs;
    if (entries.length >= limit) {
      const last = entries[entries.length - 1];
      return {
        entries,
        next: reachedFloor || last === undefined ? null : { id: last.id, at: last.at },
        coverage: { kind: 'complete' },
      };
    }
    if (reachedFloor) return { entries, next: null, coverage: { kind: 'complete' } };
    if (clock() - started >= budgetMs) {
      return { entries, next: null, coverage: { kind: 'budget', from: lower, to: top } };
    }
    upper = new Date(lowerMs - 1).toISOString();
  }
}

/** 予算で打ち切った窓の続きを打つときの `until`（探した範囲の下端の 1ms 手前）。 */
export function journalSearchContinuationUntil(from: string): string {
  return new Date(Date.parse(from) - 1).toISOString();
}
