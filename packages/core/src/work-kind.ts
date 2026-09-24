/**
 * 評定を**仕事の種類ごとに束ねる**ときの寄せ方（issue #1308 段B）。
 *
 * 種類（`workKindSchema`）は器で列挙にしない自由文なので、表記ゆれ
 * （`実装` / `実装 ` / `ＲＥＶＩＥＷ` / `review`）が起こりうる。**弾くのは器ではなく
 * 束ねる側の仕事である**（`practiceKindSchema` の doc の方針）。ここはその寄せ方を
 * 1箇所に置き、段2 の束（`appraisal.ts`）と `appraisal_stats`（`appraisal-stats.ts`）が
 * 同じ規則で数えるようにする —— 2箇所で別々に寄せると、同じ評定が片方では1群、
 * もう片方では2群に数えられる。
 *
 * **寄せるのは機械的に同じと言える差だけである**（Unicode の互換正規化・前後の
 * 空白・大文字小文字）。`実装` と `実装作業` のような意味の近さは寄せない ——
 * それは判断であって、器が黙ってやってよい変換ではない。
 */

/** 種類を述べていない評定の群の名前。**どこかの種類へ寄せない**（#1308 の決定）。 */
export const UNCLASSIFIED_WORK_KIND_LABEL = '未分類';

/**
 * 束ねるときの鍵。種類が無い（または寄せた結果が空の）評定は `null` ＝ 未分類。
 */
export function workKindGroupKey(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  const key = raw.normalize('NFKC').trim().toLowerCase();
  return key === '' ? null : key;
}

/** 1つの群。`label` は最初に見た表記（未分類なら {@link UNCLASSIFIED_WORK_KIND_LABEL}）。 */
export interface WorkKindGroup<T> {
  /** 寄せた鍵。未分類は `null`。 */
  key: string | null;
  label: string;
  items: T[];
}

/**
 * `items` を種類ごとに束ねる。**件数の多い群から並べ、未分類は必ず最後に置く**
 * （未分類は種類の1つではないので、件数で他の群と競わせない）。件数が同じ群は
 * 鍵の辞書順（出力を入力の順序に依存させない）。
 */
export function groupByWorkKind<T>(
  items: readonly T[],
  kindOf: (item: T) => string | undefined,
): WorkKindGroup<T>[] {
  const groups = new Map<string | null, WorkKindGroup<T>>();
  for (const item of items) {
    const raw = kindOf(item);
    const key = workKindGroupKey(raw);
    let group = groups.get(key);
    if (group === undefined) {
      group = {
        key,
        label: key === null ? UNCLASSIFIED_WORK_KIND_LABEL : (raw ?? '').trim(),
        items: [],
      };
      groups.set(key, group);
    }
    group.items.push(item);
  }
  return [...groups.values()].sort((a, b) => {
    if (a.key === null) return b.key === null ? 0 : 1;
    if (b.key === null) return -1;
    return b.items.length - a.items.length || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  });
}
