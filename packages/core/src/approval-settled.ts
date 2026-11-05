import type { ApprovalList, JobStore } from './store.js';

// 承認を全部読んで答える写し（#5089）。決着の時刻の列を持たない器（fs・メモリ）は、これで `listApprovalsSettledAround` / `listApprovalSettledAts` を実装する。
// DB の側で絞れる器（pg）は、これを使わず SQL で引く。
// 範囲は見ない: 範囲の外の行が混ざってよい口なので、全件を返せば取りこぼさない。

export async function listApprovalsSettledAroundFromApprovals(
  store: Pick<JobStore, 'listApprovals'>,
  options: { conversationId?: string } = {},
): Promise<ApprovalList> {
  return store.listApprovals({
    pendingOnly: false,
    ...(options.conversationId === undefined ? {} : { conversationId: options.conversationId }),
  });
}

// 型に合わない行は数えない（`listApprovals` が `unreadable` へ回すため）。pg は列だけを読むので数える（意図した差）。
export async function listApprovalSettledAtsFromApprovals(
  store: Pick<JobStore, 'listApprovals'>,
): Promise<string[]> {
  const { entries } = await store.listApprovals({ pendingOnly: false });
  const settledAts: string[] = [];
  for (const approval of entries) {
    const settledAt = approval.answeredAt ?? approval.withdrawnAt;
    if (settledAt !== undefined && settledAt !== null) settledAts.push(settledAt);
  }
  return settledAts;
}
