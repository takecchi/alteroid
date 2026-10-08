export function formatElapsedAgo(iso: string, now: number): string {
  const at = new Date(iso).getTime();
  if (Number.isNaN(at)) return '経過不明';
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  // 単位の上限を越えさせない: Math.round だけだと 3570〜3599 秒が `60分` になるため
  if (seconds < 3600) return `${Math.min(59, Math.round(seconds / 60))}分前`;
  if (seconds < 86_400) return `${Math.min(23, Math.round(seconds / 3600))}時間前`;
  return `${Math.round(seconds / 86_400)}日前`;
}
