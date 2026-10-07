// `@alteroid/core` の値を import しない（型だけ）: 値を1つでも import すると `sideEffects` 未宣言のため
// tree-shake されず、core 全体が client バンドルへ入る（assertNever 1つで約1.2MB のチャンクができた）。
// このファイルの `assertNever*` と記憶まわりの整形が core と重複しているのはそのため。
import type { MemoryCreatedAt } from '@alteroid/core';

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
  if (Number.isNaN(at)) return iso;

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

// `Math.max(seconds, 0)` を外さない: 受け取るのは HTTP 経由の JSON（信頼境界の外）で、型の保証だけを信じない。
export function formatMemoryStaleness(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${Math.max(seconds, 0)}秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}分`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}時間`;
  const days = Math.floor(hours / 24);
  return `${days}日`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  // 丸めた後の値で単位を上げるか決める: 1,048,524 バイト以上が「1024.0 KB」になる。
  const kb = (bytes / 1024).toFixed(1);
  if (Number(kb) < 1024) return `${kb} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

type MemoryDescriptionDrift =
  | { kind: 'measured'; describedBytes: number; currentBytes: number; deltaBytes: number }
  | {
      kind: 'at-least';
      baselineBytes: number;
      baselineAt: string;
      currentBytes: number;
      deltaBytes: number;
    }
  | { kind: 'unrecorded' };

function assertNeverMemoryDescriptionDrift(drift: never): never {
  throw new Error(`未知の要旨の変化量の状態: ${JSON.stringify(drift)}`);
}

// 符号つきで出す: 減ったことと増えたことを同じ表示にしない。`describedBytes === 0` では % を出さない（0除算を「0%」にしない）。
export function formatMemoryDescriptionDrift(drift: {
  describedBytes: number;
  currentBytes: number;
  deltaBytes: number;
}): string {
  const sign = drift.deltaBytes < 0 ? '-' : '+';
  const magnitude = Math.abs(drift.deltaBytes).toLocaleString('en-US');
  if (drift.describedBytes === 0) return `本文は${sign}${magnitude}バイト変わった`;
  const percent = Math.round((Math.abs(drift.deltaBytes) / drift.describedBytes) * 100);
  return `本文は${sign}${magnitude}バイト（${sign}${percent.toLocaleString('en-US')}%）変わった`;
}

// `%` を出さない: 母数が要旨を書いた時点の大きさではなく、`measured` の `%` とは別の量になる。
// `baselineAt` と `本文は` も出さない: この文字列はクローンのプロンプトへ毎ターン焼かれ、トークンが恒久的に膨らむ。
export function formatMemoryDescriptionDriftAtLeast(drift: {
  baselineBytes: number;
  currentBytes: number;
  deltaBytes: number;
}): string {
  const sign = drift.deltaBytes < 0 ? '-' : '+';
  const magnitude = Math.abs(drift.deltaBytes).toLocaleString('en-US');
  return `${sign}${magnitude}バイト以上変わった`;
}

export function describeMemoryDescriptionDrift(drift: MemoryDescriptionDrift): string {
  switch (drift.kind) {
    case 'measured':
      return formatMemoryDescriptionDrift(drift);
    case 'at-least':
      return formatMemoryDescriptionDriftAtLeast(drift);
    case 'unrecorded':
      return '本文の変化量は記録されていない';
    default:
      return assertNeverMemoryDescriptionDrift(drift);
  }
}
