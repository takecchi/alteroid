import { JournalAnchorNotFoundError } from './store.js';
import type { JournalEntry } from './schema.js';
import type { JournalQuery, JournalStore } from './store.js';

/**
 * OOM の本体（issue #1283）を歯にするための、日誌ストアの偽物。
 *
 * **`createMemoryStores`（`testing.ts`）を使わない理由。** あちらは実装として
 * 正しい `JournalStore` だが、`list()` が中身を素朴な配列（`entries`）として
 * 丸ごと保持している——「窓に大量の行が在るときにヒープへ載る量が抑えられて
 * いるか」を測る歯を書くには、こちらが million 行を実際に `push` することに
 * なり、**歯を書くための準備そのものが同じ穴を掘る**（テストプロセスの
 * ヒープを食う）。この偽物は行を**位置（`index`）から都度組み立てる**——
 * どれだけ `total` が大きくても、実際に `JournalEntry` オブジェクトとして
 * 生きるのは、いま検査している1件（と、呼び出し側が保持を選んだ範囲）だけ
 * である。
 *
 * **`index` の意味。** `0` がいちばん新しい行、`total - 1` がいちばん古い行。
 * `at` は `baseTimeMs - index`（ミリ秒）——`index` が増えるほど過去へ進む。
 * `id` は `index` を逆算できる形（`synthetic-<0埋め12桁>`）にしてあり、
 * `after` の錨をこの偽物自身が `id` から `index` へ戻して検算できるように
 * してある（本物の3実装が `id` と `at` の両方が一致する行を探す契約
 * ——`store.ts` の `JournalQuery.after` の doc——を、この偽物でも同じ強さで
 * 再現するため）。
 *
 * **`limit` が有限でなければ例外を投げる。** 本番の穴（pg 実装が `limit`
 * 省略時に `Number.MAX_SAFE_INTEGER` を渡す。
 * `grep -Fn -- 'query.limit ?? Number.MAX_SAFE_INTEGER' packages/storage-pg/src/journal.ts`）
 * と同じ形を呼び出し側が再現したら、この偽物はそれを**歯を書く前に検算
 * ミスとして落とす**——「歯が赤くなったのは実装のバグのためか、歯自体の
 * 書き間違いか」を混同しないため。この偽物を呼ぶ全ての口が有限の `limit` を
 * 渡す設計（`scanJournalPages`）になっていることの検算そのものでもある。
 */
export interface SyntheticJournalStoreOptions {
  /** 行の総数。 */
  total: number;
  /** `index`（`0` が最新）から、その行の `id` / `at` 以外の中身を作る。 */
  entryAt: (index: number) => Omit<JournalEntry, 'id' | 'at'>;
  /** `index === 0` の `at`（既定は固定の時刻——実時間に依存させない）。 */
  baseTimeMs?: number;
}

export interface SyntheticJournalStore {
  /**
   * **`JournalStore` の全メンバを持つ。** `list` だけが本物で、
   * `append` / `get` / `clear` は呼ばれたら例外を投げるスタブである——
   * `buildActivityDigest` / `deriveDistillGapFromJournal` はどちらも
   * `list` しか呼ばないので、この2つの歯にとっては「呼ばれないこと」自体が
   * 暗黙の検算になる（呼ばれれば歯がその場で落ちる）。`Stores` の型へ
   * そのまま渡せるよう、`Pick` ではなくフル実装の形にしてある。
   */
  store: JournalStore;
  /** `list()` に渡ってきたクエリを呼び出し順に記録したもの。 */
  calls: JournalQuery[];
  /** 全呼び出しを通じて実際に返した行の総数（ヒープへ載った量の代理指標）。 */
  totalReturned: number;
  /** `index` から実際の `JournalEntry` を組み立てる（歯の期待値の計算用）。 */
  entryOf: (index: number) => JournalEntry;
}

const ID_PREFIX = 'synthetic-';
const ID_DIGITS = 12;

export function createSyntheticJournalStore(
  options: SyntheticJournalStoreOptions,
): SyntheticJournalStore {
  const { total, entryAt } = options;
  const baseTimeMs = options.baseTimeMs ?? Date.parse('2026-01-01T00:00:00.000Z');
  const calls: JournalQuery[] = [];
  let totalReturned = 0;

  const idOf = (index: number): string => `${ID_PREFIX}${String(index).padStart(ID_DIGITS, '0')}`;
  const indexOfId = (id: string): number | undefined => {
    if (!id.startsWith(ID_PREFIX)) return undefined;
    const n = Number(id.slice(ID_PREFIX.length));
    return Number.isInteger(n) ? n : undefined;
  };
  const entryOf = (index: number): JournalEntry =>
    ({
      ...entryAt(index),
      id: idOf(index),
      at: new Date(baseTimeMs - index).toISOString(),
    }) as JournalEntry;

  /** `desc`: index 昇順（＝新しい順）。`asc`: index 降順（＝古い順）。 */
  function* indices(order: 'asc' | 'desc', anchorIndex: number | undefined): Generator<number> {
    if (order === 'desc') {
      const start = anchorIndex === undefined ? 0 : anchorIndex + 1;
      for (let i = start; i < total; i++) yield i;
    } else {
      const start = anchorIndex === undefined ? total - 1 : anchorIndex - 1;
      for (let i = start; i >= 0; i--) yield i;
    }
  }

  const list = async (query: JournalQuery = {}): Promise<JournalEntry[]> => {
    calls.push(query);

    if (query.limit === undefined || !Number.isFinite(query.limit) || query.limit <= 0) {
      // **本番の穴（`limit ?? Number.MAX_SAFE_INTEGER`）をこの偽物で再現
      // させない。** ここへ来た時点で、呼び出し側の設計が壊れている
      // （`journal-scan.test-support.ts` の doc）。
      throw new Error(
        `この偽ストアは有限の正の limit を要求する（渡ってきた値: ${String(query.limit)}）`,
      );
    }

    let anchorIndex: number | undefined;
    if (query.after !== undefined) {
      const after = query.after;
      const candidate = indexOfId(after.id);
      const anchorEntry = candidate === undefined ? undefined : entryOf(candidate);
      if (
        candidate === undefined ||
        candidate < 0 ||
        candidate >= total ||
        anchorEntry === undefined ||
        anchorEntry.at !== after.at
      ) {
        throw new JournalAnchorNotFoundError(
          `after で指定された行が見つからない: ${JSON.stringify(after)}`,
        );
      }
      anchorIndex = candidate;
    }

    const order = query.order ?? 'desc';
    const result: JournalEntry[] = [];
    for (const index of indices(order, anchorIndex)) {
      const entry = entryOf(index);
      if (query.since !== undefined && entry.at < query.since) continue;
      if (query.until !== undefined && entry.at > query.until) continue;
      if (query.types !== undefined && !query.types.includes(entry.type)) continue;
      if (query.with !== undefined) {
        if (entry.type !== 'exchange' || !query.with.includes(entry.with)) continue;
      }
      result.push(entry);
      if (result.length >= query.limit) break;
    }
    totalReturned += result.length;
    return result;
  };

  const notImplemented = (name: string) => (): never => {
    throw new Error(
      `この偽ストアの ${name}() はスタブである（呼ばれない前提）。呼ばれたのなら、` +
        'テスト対象が journal.list() 以外を呼んでいる——歯の設計を見直すこと。',
    );
  };

  return {
    store: {
      list,
      append: notImplemented('append'),
      get: notImplemented('get'),
      clear: notImplemented('clear'),
    },
    calls,
    get totalReturned() {
      return totalReturned;
    },
    entryOf,
  };
}
