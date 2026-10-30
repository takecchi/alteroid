// 何も import しない: CLI が `@alteroid/core/cli-light` から core 本体を評価せずに読むため。
// 書式を1か所に置く: core（クローンへ焼く目次）と CLI（人間の一覧）で写すと、片方だけ直り、人間とクローンが同じ記憶を見て違う判断をするため

/** `schema.ts` の `MemoryDescriptionDrift` と同じ形（ここでは型を import しない）。 */
type MemoryDescriptionDriftView =
  | {
      readonly kind: 'measured';
      readonly describedBytes: number;
      readonly currentBytes: number;
      readonly deltaBytes: number;
    }
  | {
      readonly kind: 'at-least';
      readonly baselineBytes: number;
      readonly baselineAt: string;
      readonly currentBytes: number;
      readonly deltaBytes: number;
    }
  | { readonly kind: 'unrecorded' };

/** `schema.ts` の `MemoryDescriptionFreshness` と同じ形（ここでは型を import しない）。 */
type MemoryDescriptionFreshnessView =
  | { readonly kind: 'fresh' }
  | {
      readonly kind: 'stale';
      readonly staleForMs: number;
      readonly drift: MemoryDescriptionDriftView;
    }
  | { readonly kind: 'unknown' }
  | { readonly kind: 'absent' };

export function assertNeverMemoryDescriptionFreshness(freshness: never): never {
  throw new Error(`未知の要旨の鮮度状態: ${JSON.stringify(freshness)}`);
}

export function assertNeverMemoryDescriptionDrift(drift: never): never {
  throw new Error(`未知の要旨の変化量の状態: ${JSON.stringify(drift)}`);
}

// `Math.max(seconds, 0)` を残す: CLI が受け取るのは HTTP 経由の JSON（信頼境界の外）で、型の保証だけを信じないため
function formatMemoryStaleness(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${Math.max(seconds, 0)}秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}分`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}時間`;
  const days = Math.floor(hours / 24);
  return `${days}日`;
}

// `describedBytes === 0` のときは % を出さない: 0除算を「0%」に化けさせないため
function formatMemoryDescriptionDrift(drift: {
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

// `%` と `baselineAt` を出さない: 母数が measured と別の量になり、この文字列は毎ターンプロンプトへ焼かれるのでトークン肥大を避けるため
function formatMemoryDescriptionDriftAtLeast(drift: {
  baselineBytes: number;
  currentBytes: number;
  deltaBytes: number;
}): string {
  const sign = drift.deltaBytes < 0 ? '-' : '+';
  const magnitude = Math.abs(drift.deltaBytes).toLocaleString('en-US');
  return `${sign}${magnitude}バイト以上変わった`;
}

// `at-least` と `unrecorded` を `measured` と同じ言葉にしない: 下限を確定値に見せず、記録が無いことを「0バイト変わった」に化けさせないため
function describeMemoryDescriptionDrift(drift: MemoryDescriptionDriftView): string {
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

// stale の有無という1bitの印にしない: 常に鳴る印に読み手が慣れて他の印まで見なくなるため。unknown を「0（最新）」に見せない: 欠測が「手を入れなくてよい」側に化けるため
// `stale` は期間に変化量も追記する: 時間差だけでは、いちばん手が入っている文書がいちばん新しく見えるため
export function memoryFreshnessMarker(freshness: MemoryDescriptionFreshnessView): string {
  switch (freshness.kind) {
    case 'fresh':
      return '要旨の後に本文は動いていない: ';
    case 'stale':
      return (
        `要旨は本文より${formatMemoryStaleness(freshness.staleForMs)}古い` +
        `（${describeMemoryDescriptionDrift(freshness.drift)}）: `
      );
    case 'unknown':
      return '要旨を書いた時刻が記録されていない: ';
    case 'absent':
      return '';
    default:
      return assertNeverMemoryDescriptionFreshness(freshness);
  }
}
