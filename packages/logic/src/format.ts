/** 表示用の整形。ロケールは端末任せにせず日本語で固定する（作者ひとりの道具なので）。 */

import type { MemoryCreatedAt } from '@alteroid/core';

const dateTime = new Intl.DateTimeFormat('ja-JP', {
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
});

/** `dateTime` に年を足しただけの書式。今年でない時刻にだけ使う。 */
const dateTimeWithYear = new Intl.DateTimeFormat('ja-JP', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
});

/**
 * 「今年か」を判定するためだけの書式。`dateTime` / `dateTimeWithYear`
 * と同じく、既定のタイムゾーン（閲覧者の端末）を構築時に捕まえる——
 * `Date.getFullYear()` は使わない。理由はこのファイルの他の Intl インスタンスと
 * 同じで、`process.env.TZ` を実行時に変えても効くかどうかが実装依存になる。
 * 年の数字だけを文字列で比較するので、ロケールの年の書式（"2026年" 等）を
 * 読み解く必要が無い。
 */
const yearOnly = new Intl.DateTimeFormat('ja-JP', { year: 'numeric' });

const timeOnly = new Intl.DateTimeFormat('ja-JP', { hour: '2-digit', minute: '2-digit' });

/**
 * 日時を絶対時刻で出す。**今年ではない時刻にだけ年を足す**——足さないと、
 * ちょうど1年違う時刻が同じ文字列になる（`09/29 16:00` が2025年も
 * 2026年も同じ）。今年かどうかは**閲覧者の端末の時刻**で決める（`now`、
 * 既定は `Date.now()`）。
 *
 * `now` を引数にできるのはテストで固定するため。
 */
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

/**
 * 「3分前」。
 *
 * 絶対時刻だけだと、動き続けている系を見たときに**それが今なのかが分からない**。
 */
export function formatRelative(iso: string, now: number = Date.now()): string {
  const at = new Date(iso).getTime();
  if (Number.isNaN(at)) return iso;

  const seconds = Math.round((now - at) / 1000);
  const future = seconds < 0;
  const abs = Math.abs(seconds);

  const suffix = future ? '後' : '前';
  if (abs < 45) return future ? 'まもなく' : 'たった今';
  // 丸めた後の値で単位を上げるかを決める。生の秒で境目を切ると、
  // 3570〜3599 秒が「60分前」、84600 秒以降が「24時間前」になる。
  const minutes = Math.round(abs / 60);
  if (minutes < 60) return `${minutes}分${suffix}`;
  const hours = Math.round(abs / 3600);
  if (hours < 24) return `${hours}時間${suffix}`;
  return `${Math.round(abs / 86400)}日${suffix}`;
}

/**
 * `MemoryCreatedAt` の2状態の網羅性を型で強制する。
 *
 * **`@alteroid/core` の `assertNeverMemoryCreatedAt` を呼ばず、ここで
 * 同じ形を私物として持つ。** `@alteroid/core` はランタイム値を1つでも
 * import すると（`sideEffects` を宣言していないため）バンドラが安全側に
 * 倒れ、パッケージ全体を tree-shake できずに client バンドルへ丸ごと
 * 混入する（この関数だけを import した状態で約1.2MBのチャンクができた）。
 * `MemoryCreatedAt` は型だけなので消えるが、値は消えない。
 * **型の網羅性チェックのためだけに約1.2MBを配らないため**、
 * ロジックは同じでも実体はここに置く（`memory.ts` の
 * `formatMemoryCreatedAt` とコードは重複するが、2箇所とも数行の
 * `switch` なので、二重管理のリスクより client バンドルの肥大のほうが
 * 重いと判断した）。
 */
function assertNeverCreatedAt(createdAt: never): never {
  throw new Error(`未知の記憶作成時刻の状態: ${JSON.stringify(createdAt)}`);
}

/**
 * 記憶の作成時刻を絶対時刻で出す（詳細画面）。
 *
 * `memory_list`（クローンの道具、`packages/core/src/memory.ts` の
 * `formatMemoryCreatedAt`）と語彙を揃える——根拠が無ければ**「不明」と
 * 明言する**。空欄にすると「取れないこと」が出力から消える
 * （AGENTS.md「踏みやすい地雷」の「取れない軸に 0 の行を作る」と同じ形）。
 */
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

/**
 * 記憶の作成時刻を相対時刻で出す（一覧）。同上——根拠が無ければ「不明」。
 */
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

/**
 * ミリ秒差を「1時間」「30日」のような字面にする（記憶一覧の鮮度の印専用）。
 *
 * **`packages/core/src/memory.ts` の `formatMemoryStaleness` と考え方は同じだが、
 * 実体は分けて持つ。** `@alteroid/core` から値を1つでも import すると client
 * バンドルへ丸ごと混入する（このファイル冒頭の `assertNeverCreatedAt` の doc と
 * 同じ理由）ので、ここでも私物として持つ。
 *
 * **`Math.max(seconds, 0)` は core 側とは違う理由で残す。** core の
 * `resolveMemoryDescriptionFreshness` は非負を保証してから返すが、ここが
 * 受け取るのは HTTP 経由の JSON（信頼境界の外）——型が保証しているだけの
 * 値を信じない、という境界防御である（同じプロセス内で2箇所が同じ異常を
 * 隠す、という core 側で避けた形とは異なる）。
 */
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
  // 丸めた後の値で単位を上げるかを決める。1,048,524 バイト以上が
  // 「1024.0 KB」にならないようにする。
  const kb = (bytes / 1024).toFixed(1);
  if (Number(kb) < 1024) return `${kb} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * 本文の変化量。`packages/core/src/schema.ts` の
 * `MemoryDescriptionDrift` と同じ形——`@alteroid/core` の値を import すると
 * client バンドルへ丸ごと混入する（このファイル冒頭の `assertNeverCreatedAt`
 * の doc と同じ理由）ので、ここでも私物として持つ。
 */
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

/** `MemoryDescriptionDrift` の網羅性を型で強制する。 */
function assertNeverMemoryDescriptionDrift(drift: never): never {
  throw new Error(`未知の要旨の変化量の状態: ${JSON.stringify(drift)}`);
}

/**
 * 変化量（バイト）を人間可読な文字列にする（`describeMemoryDescriptionDrift`
 * の `measured` 専用。`packages/core/src/memory.ts` の
 * `formatMemoryDescriptionDrift` と同じ考え方だが実体は分けて持つ）。
 *
 * **符号つきで出す。** 減った（削って書き直した等）ことと増えた（放置の
 * まま追記された）ことを同じ表示にしない。**`describedBytes === 0` の
 * ときは % を出さない**（0除算を「0%」に化けさせない）。
 */
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

/**
 * 変化量（バイト）を人間可読な文字列にする（`at-least` 専用。
 * `packages/core/src/memory.ts` の `formatMemoryDescriptionDriftAtLeast` と
 * 同じ考え方だが実体は分けて持つ）。
 *
 * **`%` を出さない**（母数が「要旨を書いた時点の大きさ」ではないので、
 * `measured` の `%` とは別の量になる）。**`baselineAt` も刷らない**（この
 * 文字列はクローンのプロンプトへ毎ターン焼かれるため、恒久的なトークン
 * 肥大化を避ける）。**`本文は` を持たない**（トークン収支の実測で削った。
 * 外側の `freshnessMark` が既に「要旨は本文より…古い」と言っている）。
 */
export function formatMemoryDescriptionDriftAtLeast(drift: {
  baselineBytes: number;
  currentBytes: number;
  deltaBytes: number;
}): string {
  const sign = drift.deltaBytes < 0 ? '-' : '+';
  const magnitude = Math.abs(drift.deltaBytes).toLocaleString('en-US');
  return `${sign}${magnitude}バイト以上変わった`;
}

/**
 * `MemoryDescriptionDrift`（3状態）を人間可読な文字列にする。
 */
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
