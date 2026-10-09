export interface RecentMapOptions {
  limit: number;
  /** 黙って落とさない: 忘れた id の再送はもう一度表に出るので、忘れたことが記録に無いと原因へ辿れない。 */
  onForget?: (ids: string[]) => void;
}

export interface RecentMap<T> {
  has(id: string): boolean;
  get(id: string): T | undefined;
  set(id: string, value: T): void;
  delete(id: string): boolean;
  entries(): [string, T][];
  readonly size: number;
}

export function createRecentMap<T>(options: RecentMapOptions): RecentMap<T> {
  if (!Number.isInteger(options.limit) || options.limit < 1) {
    throw new Error(`RecentMap の limit は1以上の整数であること: ${String(options.limit)}`);
  }
  const limit = options.limit;
  const onForget = options.onForget;
  const entries = new Map<string, T>();

  return {
    has: (id) => entries.has(id),
    get: (id) => entries.get(id),
    set(id, value) {
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
    entries: () => [...entries.entries()],
    get size() {
      return entries.size;
    },
  };
}
