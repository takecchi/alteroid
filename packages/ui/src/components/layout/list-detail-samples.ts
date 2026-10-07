export interface SampleEntry {
  id: string;
  title: string;
  date: string;
  body: string;
}

export function sampleEntries(count: number): SampleEntry[] {
  return Array.from({ length: count }, (_, i) => ({
    id: String(i + 1),
    title: `${i + 1} 件目の記録`,
    date: `2026-09-${String(30 - (i % 30)).padStart(2, '0')}`,
    body: `${i + 1} 件目の本文。一覧で選んだ項目の内容がここに出る。`,
  }));
}
