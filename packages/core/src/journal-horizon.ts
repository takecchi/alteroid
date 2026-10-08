export function journalWindowCrossesHorizon(
  oldestAt: string | null,
  since: string | undefined,
): boolean {
  if (oldestAt === null) return false;
  // 文字列では比べない: 秒の省略やオフセットで辞書順が狂い、地平より前の since を後ろと取り違えるため
  const sinceMs = since === undefined ? Number.NaN : Date.parse(since);
  if (since !== undefined && !Number.isNaN(sinceMs) && !(sinceMs < Date.parse(oldestAt))) {
    return false;
  }
  return true;
}
