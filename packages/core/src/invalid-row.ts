// `issue.message` は使わない: zod の既定メッセージが将来 `received`（実際の値）を含む形に変わると値が漏れるため
export function summarizeInvalidFields(
  issues: readonly { path: readonly PropertyKey[] }[],
): string {
  const fields = [
    ...new Set(issues.map((issue) => (issue.path.length > 0 ? String(issue.path[0]) : '(root)'))),
  ];
  return fields.length > 0 ? `不正な欄: ${fields.join(',')}` : '不正な行';
}

// 載せるのは識別子の欄（`keyName`）の値だけ: 行のほかの欄には人間の依頼文・トークン本体などがそのまま入りうるため。
// 呼び手は `reason` に `summarizeInvalidFields` の結果（欄名だけ）を渡し、生の行そのものは渡さない
export function describeSkippedRow(
  table: string,
  keyName: string,
  params: { index: number; reason: string; key?: string },
): string {
  const keyNote = params.key === undefined ? '' : ` ${keyName}=${JSON.stringify(params.key)}`;
  return (
    `alteroid: ${table} の不正な行を読み飛ばしました` +
    `（${params.index + 1} 行目、${params.reason}）${keyNote}`
  );
}

export function extractRowId(raw: unknown): string | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const id = (raw as Record<string, unknown>).id;
  return typeof id === 'string' ? id : undefined;
}
