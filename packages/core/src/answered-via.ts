// `schema.ts` から型を引かない: zod を引き込み、サーバ専用の層がブラウザバンドルへ入るため
export type AnsweredViaLike =
  | { kind: 'operator'; auth: 'disabled' | 'operator-token' }
  | { kind: 'account'; accountId: string };

export function describeAnsweredVia(via: AnsweredViaLike): string {
  if (via.kind === 'account') return `account（${via.accountId}）`;
  return via.auth === 'disabled' ? 'operator（認証無効）' : 'operator（operator token）';
}
