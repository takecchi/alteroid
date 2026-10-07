export type ApprovalPagingKey = { id: string; createdAt: string };

// createdAt を文字列のまま比較する: `toISOString()` の固定形式（UTC・ミリ秒3桁・`Z` 終端）に乗っているため
export function compareApprovalPagingKeyAsc(a: ApprovalPagingKey, b: ApprovalPagingKey): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  return 0;
}

export function compareApprovalPagingKey(
  order: 'asc' | 'desc',
): (a: ApprovalPagingKey, b: ApprovalPagingKey) => number {
  return order === 'asc'
    ? compareApprovalPagingKeyAsc
    : (a, b) => compareApprovalPagingKeyAsc(b, a);
}
