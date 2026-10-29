// 読めない行の id（や kind）を並べる上限。列挙には上限を置き、切ったら言う。
export const UNREADABLE_IDS_SHOWN = 20;

// 「（id: a, b …ほか N 件は省略）」の部分だけを返す。各注記の主語と後ろの断り書きは呼び元が持つ。
// 並べるものが無ければ null（呼び元は `{…}` にそのまま置ける）。
export function unreadableIdsNote(label: 'id' | 'kind', all: readonly string[]): string | null {
  const shown = all.slice(0, UNREADABLE_IDS_SHOWN);
  if (shown.length === 0) return null;
  const rest = all.length - shown.length;
  return `（${label}: ${shown.join(', ')}${rest > 0 ? ` …ほか ${rest} 件は省略` : ''}）`;
}
