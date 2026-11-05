// 契約（`*-contract.ts`）の中で使う比較。vitest に依存しない: 契約は storage-fs / storage-pg が core を実行時に読む素の関数のため。

/** キーの順を揃えて文字列にする: 器ごとにオブジェクトのキーの並びが違っても同じ値と読めるように。 */
export function stable(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return v;
    return Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  });
}

export function expectEqual(
  fail: (message: string) => never,
  label: string,
  actual: unknown,
  expected: unknown,
): void {
  if (stable(actual) !== stable(expected)) {
    fail(`${label}: 期待 ${stable(expected)} / 実際 ${stable(actual)}`);
  }
}
