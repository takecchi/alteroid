// `schema.ts` から型を引かない: zod を引き込み、サーバ専用の層がブラウザバンドルへ入るため
// 承認の状態の判定（`approval-state.ts`）もこの軽い出口から再公開する: 新しい出口は package.json の exports を要するため、承認まわりの既存の軽い出口に同居させる
export { approvalStateOf, isApprovalFieldSet } from './approval-state.js';
export type { ApprovalState, ApprovalStateFields } from './approval-state.js';

export type AnsweredViaLike =
  | { kind: 'operator'; auth: 'disabled' | 'operator-token' }
  | { kind: 'account'; accountId: string };

export function describeAnsweredVia(via: AnsweredViaLike): string {
  if (via.kind === 'account') return `account（${via.accountId}）`;
  return via.auth === 'disabled' ? 'operator（認証無効）' : 'operator（operator token）';
}
