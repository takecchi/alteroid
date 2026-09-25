/**
 * 承認への回答がどの経路を通ったか（Issue #1479）の**表示側**だけを持つ、
 * ブラウザが読める軽い口。
 *
 * **実行時の依存を1つも持たない。** これは意図的な分離である — `@alteroid/core/answered-via`
 * として subpath で出しており、`usage-format.ts` / `revision-format.ts` /
 * `permission-rule.ts` と同じ理由（`packages/core/tsup.config.ts` の doc）。
 *
 * 正本の zod スキーマ（`answeredViaSchema`）は `schema.ts` に在り、そちらは
 * zod を import する。`@alteroid/core` バレル（`index.ts`）から値を import
 * すると、サーバ専用のドメイン層ごとブラウザバンドルへ入る事故（#294 / #306）
 * になるため、`eslint.config.js` の `no-restricted-imports` がバレルからの
 * 値 import を禁じている——`apps/web/app/routes/approvals.tsx` は元々この
 * 理由で `describeAnsweredVia` を画面側に複製して持っていた（#1514）が、
 * 複製は2箇所が別々に腐りうる形なので、`permission-rule.ts` と同じ路線
 * （軽い口を1つ足して正本を1つにする）へ揃えた（#1520 の後続）。
 *
 * **`AnsweredViaLike` は `schema.ts` の `AnsweredVia`（zod スキーマから推論
 * した型）を手で書き写したものである。** ここから `schema.ts` を import する
 * と zod を引き込んでしまうので、`revision-format.ts` の
 * `describeRevisionStatus` が `RunnerRevisionStatus` を書き写して受けるのと
 * 同じ理由で、構造的に同一な union をここで独立に宣言する。**2つの定義が
 * ずれたら typecheck で落ちる**——検査は zod 側（`schema.ts` の
 * `_AssertAnsweredViaMatchesLikeType`）に置いてある（ここは zod を知らない
 * ので、ここでは検査できない）。
 */
export type AnsweredViaLike =
  | { kind: 'operator'; auth: 'disabled' | 'operator-token' }
  | { kind: 'account'; accountId: string };

/**
 * {@link AnsweredViaLike} を人間が読む1行にする（短く。`renderApprovalTrace` の
 * 出力や `human_answer` のターン入力はクローンのプロンプトへそのまま載るので、
 * 定型文に近い短さを保つ——`schema.ts` の `describeAnsweredVia` の doc から
 * 移設。本文は1文字も変えていない）。
 */
export function describeAnsweredVia(via: AnsweredViaLike): string {
  if (via.kind === 'account') return `account（${via.accountId}）`;
  return via.auth === 'disabled' ? 'operator（認証無効）' : 'operator（operator token）';
}
