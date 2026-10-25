import { createPgStores, type PgStores, type DeferredIndexOutcome } from '@alteroid/storage-pg';

export const PG_URL =
  process.env['BENCH_PG_URL'] ?? 'postgres://postgres@127.0.0.1:55931/alteroid_bench';

/** 起動後に裏で作る索引（`createPgStores` の `onDeferredIndexes`）が作り終わるまで待って、器を返す */
export async function openStores(): Promise<{
  stores: PgStores;
  indexes: DeferredIndexOutcome[];
}> {
  let resolveIndexes: (outcomes: DeferredIndexOutcome[]) => void = () => undefined;
  const indexesDone = new Promise<DeferredIndexOutcome[]>((resolve) => {
    resolveIndexes = resolve;
  });
  const stores = await createPgStores({ url: PG_URL, onDeferredIndexes: resolveIndexes });
  const indexes = await indexesDone;
  return { stores, indexes };
}

/**
 * 索引が既に有効かの確かめ（pg_class の問い合わせ数本。索引が在れば一瞬）が済むまで、最大 5 秒だけ待って器を開く。
 * 待たずに閉じると、確かめが閉じた接続に当たって「索引を作れなかった（Client was closed）」の警告が毎回出る（索引は有効）。
 * 待つのは索引の確かめだけで、日誌の表には触れないので、冷えの測りに影響しない。索引が無い DB では作りに行くので、その場合は待ちを切る。
 */
export async function openStoresNoWait(): Promise<PgStores> {
  let done: () => void = () => undefined;
  const checked = new Promise<void>((resolve) => {
    done = resolve;
  });
  const stores = await createPgStores({ url: PG_URL, onDeferredIndexes: () => done() });
  await Promise.race([checked, new Promise<void>((resolve) => setTimeout(resolve, 5000))]);
  return stores;
}

/** 器の接続（drizzle の `$client` = pg の Pool）で素の SQL を打つ */
export async function rawQuery<T = Record<string, unknown>>(
  stores: PgStores,
  text: string,
  values: unknown[] = [],
): Promise<T[]> {
  const client = (
    stores.db as unknown as {
      $client: { query: (t: string, v: unknown[]) => Promise<{ rows: T[] }> };
    }
  ).$client;
  return (await client.query(text, values)).rows;
}

export function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export function percentile(values: readonly number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)]!;
}

export function stats(values: readonly number[]): {
  n: number;
  median: number;
  p90: number;
  max: number;
  min: number;
} {
  return {
    n: values.length,
    median: round(median(values)),
    p90: round(percentile(values, 90)),
    max: round(Math.max(...values)),
    min: round(Math.min(...values)),
  };
}

export function round(value: number): number {
  return Math.round(value * 100) / 100;
}

export function nowIso(): string {
  return new Date().toISOString();
}
