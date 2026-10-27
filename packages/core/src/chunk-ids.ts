// id は1つも落とさない: 1つの id だけで予算を超えても単独の塊として返す（予算のほうを譲る）
export function chunkIdsByChars(ids: readonly string[], budget: number): string[][] {
  const chunks: string[][] = [];
  let current: string[] = [];
  let width = 0;
  for (const id of ids) {
    const added = current.length === 0 ? id.length : id.length + 1;
    if (current.length > 0 && width + added > budget) {
      chunks.push(current);
      current = [];
      width = 0;
    }
    current.push(id);
    width += current.length === 1 ? id.length : added;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}
