// `@alteroid/core` 本体の値を import しない（型だけ。値は下の軽い出口から取る）: 本体から値を1つでも import すると `sideEffects` 未宣言のため
// tree-shake されず、core 全体が client バンドルへ入る（assertNever 1つで約1.2MB のチャンクができた）。
import type { MemoryCreatedAt } from '@alteroid/core';

// 要旨の鮮度の整形は core の軽い出口に1本だけ置く（写さない）。名前を変えずに再 export して、呼び手の import を変えない。
// 軽い出口は何も import しないので、値を取っても core 本体は client バンドルへ入らない。
export {
  describeMemoryDescriptionDrift,
  formatMemoryDescriptionDrift,
  formatMemoryDescriptionDriftAtLeast,
  formatMemoryStaleness,
} from '@alteroid/core/memory-freshness-format';

const dateTime = new Intl.DateTimeFormat('ja-JP', {
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
});

const dateTimeWithYear = new Intl.DateTimeFormat('ja-JP', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
});

// `Date.getFullYear()` を使わない: 他の Intl インスタンスと同じく、タイムゾーンを構築時に捕まえる形に揃える
// （`process.env.TZ` を実行時に変えても効くかが実装依存になる）。
const yearOnly = new Intl.DateTimeFormat('ja-JP', { year: 'numeric' });

const timeOnly = new Intl.DateTimeFormat('ja-JP', { hour: '2-digit', minute: '2-digit' });

// 今年ではない時刻にだけ年を足す: 足さないと、ちょうど1年違う時刻が同じ文字列になる。
export function formatDateTime(iso: string, now: number = Date.now()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const isThisYear = yearOnly.format(date) === yearOnly.format(new Date(now));
  return isThisYear ? dateTime.format(date) : dateTimeWithYear.format(date);
}

export function formatTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : timeOnly.format(date);
}

export function formatRelative(iso: string, now: number = Date.now()): string {
  const at = new Date(iso).getTime();
  if (Number.isNaN(at) || Number.isNaN(now)) return iso;

  const seconds = Math.round((now - at) / 1000);
  const future = seconds < 0;
  const abs = Math.abs(seconds);

  const suffix = future ? '後' : '前';
  if (abs < 45) return future ? 'まもなく' : 'たった今';
  // 丸めた後の値で単位を上げるか決める: 生の秒で切ると 3570〜3599 秒が「60分前」、84600 秒以降が「24時間前」になる。
  const minutes = Math.round(abs / 60);
  if (minutes < 60) return `${minutes}分${suffix}`;
  const hours = Math.round(abs / 3600);
  if (hours < 24) return `${hours}時間${suffix}`;
  return `${Math.round(abs / 86400)}日${suffix}`;
}

function assertNeverCreatedAt(createdAt: never): never {
  throw new Error(`未知の記憶作成時刻の状態: ${JSON.stringify(createdAt)}`);
}

// 根拠が無いときは空欄にせず「不明」と明言する: 空欄だと「取れないこと」が出力から消える。
export function formatCreatedAt(createdAt: MemoryCreatedAt): string {
  switch (createdAt.kind) {
    case 'known':
      return formatDateTime(createdAt.at);
    case 'unknown':
      return '不明';
    default:
      return assertNeverCreatedAt(createdAt);
  }
}

export function formatCreatedAtRelative(createdAt: MemoryCreatedAt): string {
  switch (createdAt.kind) {
    case 'known':
      return formatRelative(createdAt.at);
    case 'unknown':
      return '不明';
    default:
      return assertNeverCreatedAt(createdAt);
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  // 丸めた後の値で単位を上げるか決める: 1,048,524 バイト以上が「1024.0 KB」になる。
  const kb = (bytes / 1024).toFixed(1);
  if (Number(kb) < 1024) return `${kb} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
