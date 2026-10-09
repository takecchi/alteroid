import type { JournalEntry } from './schema.js';
import type { JournalQuery, JournalStore } from './store.js';

// 500 は実データの分布から決めた値ではなく、安全側に倒した経験則。大きすぎるとページ1枚のヒープが太り、小さすぎると往復が増える。
export const JOURNAL_SCAN_PAGE_SIZE = 500;

export interface JournalScanOptions {
  pageSize?: number;
  // 省略時は無制限。印を見つけ次第 `onPage` が `false` を返して止める呼び出し以外は、必ずこの上限を渡すこと。
  maxScanned?: number;
}

export interface JournalScanResult {
  scanned: number;
  // 境界の1件だけ安全側に倒す: ちょうど `maxScanned` 件目で日誌が尽きていても `true` を返す。続きの有無を確かめる追加の問い合わせをしないため。
  // `onPage` が自分で止めたときは `false` のまま: 打ち切りと早期終了を同じ値に潰さない。
  truncated: boolean;
}

export type JournalScanPageHandler = (page: readonly JournalEntry[]) => void | boolean;

// 終端は `listPage()` の `next === null` だけで判断する。短いページも空ページも終端と読まない: store は `LIMIT` の後に壊れた行を捨てるので、ページが丸ごと壊れていれば空で返り、その先に古い行が残る。
export async function scanJournalPages(
  journal: Pick<JournalStore, 'listPage'>,
  query: Omit<JournalQuery, 'limit'>,
  onPage: JournalScanPageHandler,
  options: JournalScanOptions = {},
): Promise<JournalScanResult> {
  const pageSize = options.pageSize ?? JOURNAL_SCAN_PAGE_SIZE;
  if (!Number.isInteger(pageSize) || pageSize <= 0) {
    throw new Error(`pageSize は正の整数である必要がある: ${pageSize}`);
  }
  const { maxScanned } = options;
  const order = query.order ?? 'desc';

  // `after` の錨が見つからない例外は握り潰さない: 走査の途中で `journal.clear()` が挟まるとありうる。空へ倒さず呼び出し側へ伝える。
  let after = query.after;
  let scanned = 0;
  for (;;) {
    // `limit` は常に有限の正の整数にする: pg は `limit` 省略時に `Number.MAX_SAFE_INTEGER` を渡し、窓の大きい日にヒープへ全件を載せて落ちる。
    const budget = maxScanned === undefined ? pageSize : Math.min(pageSize, maxScanned - scanned);
    if (budget <= 0) return { scanned, truncated: true };

    const { entries: page, next } = await journal.listPage({
      ...query,
      order,
      after,
      limit: budget,
    });
    if (page.length > 0) {
      scanned += page.length;
      if (onPage(page) === false) return { scanned, truncated: false };
      if (maxScanned !== undefined && scanned >= maxScanned) return { scanned, truncated: true };
    }

    if (next === null) return { scanned, truncated: false };
    after = next;
  }
}
