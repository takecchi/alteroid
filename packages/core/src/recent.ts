/**
 * 直近の id を覚えておく、上限つきの帳面。
 *
 * 「もう解けた」という事実は、**どこかに残っていないと再送を新しい出来事として
 * 扱ってしまう**。同じ許可確認がクローンへ二度届く、というのがその形である
 * （`runner.ts` / `manager.ts`）。
 *
 * かといって無制限には覚えない。長く走る1本のセッションでメモリが伸び続ける。
 * **上限に達したら黙って落とさない** — 忘れた id の再送はもう一度表に出るので、
 * 忘れたこと自体が記録に残っていないと、誰も原因へ辿れない。
 */
export interface RecentMapOptions {
  /** 覚えておく件数の上限。溢れたら**古い側**から押し出す。 */
  limit: number;
  /**
   * 上限で押し出された id。**呼び出し側は必ず記録すること**（黙って忘れない）。
   */
  onForget?: (ids: string[]) => void;
}

export interface RecentMap<T> {
  has(id: string): boolean;
  get(id: string): T | undefined;
  set(id: string, value: T): void;
  delete(id: string): boolean;
  readonly size: number;
}

export function createRecentMap<T>(options: RecentMapOptions): RecentMap<T> {
  if (!Number.isInteger(options.limit) || options.limit < 1) {
    throw new Error(`RecentMap の limit は1以上の整数であること: ${String(options.limit)}`);
  }
  const limit = options.limit;
  const onForget = options.onForget;
  // 挿入順を持つ Map をそのまま使う（先頭がいちばん古い）。
  const entries = new Map<string, T>();

  return {
    has: (id) => entries.has(id),
    get: (id) => entries.get(id),
    set(id, value) {
      // 入れ直しは新しい側へ寄せる（触れたものから先に忘れない）。
      entries.delete(id);
      entries.set(id, value);
      if (entries.size <= limit) return;
      const forgotten: string[] = [];
      while (entries.size > limit) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        entries.delete(oldest);
        forgotten.push(oldest);
      }
      if (forgotten.length > 0) onForget?.(forgotten);
    },
    delete: (id) => entries.delete(id),
    get size() {
      return entries.size;
    },
  };
}
