export function formatElapsedAgo(iso: string, now: number): string {
  const at = new Date(iso).getTime();
  if (Number.isNaN(at)) return '経過不明';
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  // 単位の上限を越えさせない: Math.round だけだと 3570〜3599 秒が `60分` になるため
  if (seconds < 3600) return `${Math.min(59, Math.round(seconds / 60))}分前`;
  if (seconds < 86_400) return `${Math.min(23, Math.round(seconds / 3600))}時間前`;
  return `${Math.round(seconds / 86_400)}日前`;
}

// 負の経過は「1分未満前」へ丸める: 経過を省くと「最後はいつだったか」の合図そのものが消えるため
export function formatMinutesAgo(elapsedMs: number): string {
  const minutes = Math.floor(elapsedMs / 60000);
  if (minutes < 1) return '1分未満前';
  if (minutes < 60) return `${minutes}分前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}時間${minutes % 60}分前`;
  return `${Math.floor(hours / 24)}日${hours % 24}時間前`;
}

// 日へは繰り上げない（`25時間3分`）: 背景処理待ち・消えた runner のように、時間で数える待ちの長さを言うため
export function formatDurationMinutes(elapsedMs: number): string {
  const totalMinutes = Math.floor(elapsedMs / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours < 1 ? `${String(minutes)}分` : `${String(hours)}時間${String(minutes)}分`;
}
