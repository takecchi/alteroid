// `issue.message` は使わない: zod の既定メッセージが将来 `received`（実際の値）を含む形に変わると値が漏れるため
export function summarizeInvalidFields(
  issues: readonly { path: readonly PropertyKey[] }[],
): string {
  const fields = [
    ...new Set(issues.map((issue) => (issue.path.length > 0 ? String(issue.path[0]) : '(root)'))),
  ];
  return fields.length > 0 ? `不正な欄: ${fields.join(',')}` : '不正な行';
}

export function extractRowId(raw: unknown): string | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const id = (raw as Record<string, unknown>).id;
  return typeof id === 'string' ? id : undefined;
}
