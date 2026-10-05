/**
 * ストアの入口で、NUL（`\u0000`）の扱いを3実装（fs・pg・インメモリ）で揃える
 * ための共通部品（issue #2927。先例は #2233 の `archive-session-id.ts`）。
 *
 * ## 決め（teto の判断、2026-10-05）
 *
 * - **鍵（name・id・参照キー）と、環境変数になる値（credentials の value・
 *   profile の script）に NUL があれば、入口で {@link NulNotAllowedError} を
 *   投げて断る。** 鍵に NUL が混ざると、pg だけ落として除くと fs / インメモリと
 *   同じ文字列が別の行を指す。環境変数の値に NUL は入れられない（`execve` が
 *   途中で切る）ので、落として残すと別の値になる。
 * - **読むだけの口（`get`・`revoke`・`markUsed` など、鍵で引く口）は断らず、「無い」と同じ結果を返す**
 *   （issue #3005）。書き込みで NUL の鍵を断るので、NUL を含む鍵の行はどの器にも存在しえない。
 *   pg は DB に投げる前に入口で短絡する（DB は NUL を含む text を受け付けず、エラーで投げる）。
 *   例外は `UsageStore.aggregate()` の絞り込みで、書き込みが落として残している以上、落としてから引く。
 * - **それ以外の本文は、fs も含めて NUL を落として残す**（{@link stripNul}）。
 *   pg の `stripNulls`（`storage-pg/src/db.ts`）の「器の都合で記録を失うくらいなら、
 *   1文字を落として残す」に揃える。
 * - **例外: 外から来る鍵でも、記録そのものを失わない種類の台帳（消費の台帳 `UsageStore`）では
 *   落として残す**（teto の判断、2026-10-05）。`managerId`・`model`・`tokenId` は集計の切り口で、
 *   特定の1行を指して書き換える鍵ではない。`model` は SDK の `modelUsage` のキー（外から来る）で、
 *   断ると消費の記録が丸ごと台帳から消える（呼び出し側は失敗を握りつぶして日誌に残すだけ）。
 *   害が大きいのは記録を失うほうである。部品は `usage-input.ts`。
 * - **同じ例外: 引き受けた仕事の台帳（`CommitmentStore`）の `source`**（teto の判断、2026-10-06。issue #3011）。
 *   マネージャー id・会話 id・承認 id などの出所の注記で、行を指す鍵ではない（行を指すのは `id` で、こちらは断る）。
 *   断ると引き受けた仕事が台帳から消える。落として残し、畳み込み（同一マネージャー×同一本文）の判定も
 *   落とした値で3実装が揃う。
 *
 * **例外の文に値を載せない。** どこから来た値か分からない（資格かもしれない）ので、
 * 何が入っているかをログへ流さない。載せるのは「どの欄か」だけ。型で見分けること
 * （文言で見分けない）。
 */
export class NulNotAllowedError extends Error {
  /** どの欄か（`credential.name` など。値ではない）。 */
  readonly field: string;

  constructor(field: string) {
    super(`${field} に NUL（\\u0000）が含まれているので、受け付けない`);
    this.name = 'NulNotAllowedError';
    this.field = field;
  }
}

/** `value` に NUL が含まれるなら `NulNotAllowedError(field)` を投げる。 */
export function assertNoNul(field: string, value: string): void {
  if (value.includes('\u0000')) throw new NulNotAllowedError(field);
}

/** `value` に NUL が含まれるか。読むだけの口が、DB へ投げる前に「無い」と答えるのに使う（issue #3005）。 */
export function hasNul(value: string): boolean {
  return value.includes('\u0000');
}

/** 本文から NUL を落とす（無ければ同じ文字列をそのまま返す）。 */
export function stripNul(value: string): string {
  return value.includes('\u0000') ? value.replaceAll('\u0000', '') : value;
}

/**
 * 構造のある本文（日誌の1行など）の文字列と、オブジェクトの欄名から NUL を落とす（issue #3011）。
 * pg の `stripNulls`（`storage-pg/src/db.ts`）と同じ規則で、fs・インメモリが同じ結果になるように置く。
 * 鍵には使わない（鍵は {@link assertNoNul} で断る）。
 */
export function stripNulDeep<T>(value: T): T {
  if (typeof value === 'string') return stripNul(value) as T;
  if (Array.isArray(value)) return value.map((item) => stripNulDeep(item)) as T;
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const mapped: Record<string, unknown> = {};
    for (const key of Object.keys(source)) mapped[stripNul(key)] = stripNulDeep(source[key]);
    return mapped as T;
  }
  return value;
}
