// 休止の既定（ミリ秒）の形: 整数で、0 より大きい。web の保存前の検査が使う入口。
// zod も node: も import しない: ブラウザの束に zod（約 100 KB）を入れないため。
// daemon の `PUT /tokens/policy` と保存する設定の zod スキーマ（`z.number().int().positive()`）は、
// この関数と同じ判定になる（token-cooldown-ms.test.ts が同じ入力の表を両方に通して突き合わせる）。
export function isTokenCooldownMs(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}
