/** 表示用の整形。ロケールは端末任せにせず日本語で固定する（作者ひとりの道具なので）。 */

import type { MemoryCreatedAt } from '@alteroid/core';

const dateTime = new Intl.DateTimeFormat('ja-JP', {
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
});

const timeOnly = new Intl.DateTimeFormat('ja-JP', { hour: '2-digit', minute: '2-digit' });

export function formatDateTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : dateTime.format(date);
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
  if (abs < 3600) return `${Math.round(abs / 60)}分${suffix}`;
  if (abs < 86400) return `${Math.round(abs / 3600)}時間${suffix}`;
  return `${Math.round(abs / 86400)}日${suffix}`;
}

/**
 * `MemoryCreatedAt` の2状態の網羅性を型で強制する。
 *
 * **`@alteroid/core` の `assertNeverMemoryCreatedAt` を呼ばず、ここで
 * 同じ形を私物として持つ。** `@alteroid/core` はランタイム値を1つでも
 * import すると（`sideEffects` を宣言していないため）バンドラが安全側に
 * 倒れ、パッケージ全体を tree-shake できずに client バンドルへ丸ごと
 * 混入する——実測（2026-08-22 観測、`pnpm build` の出力）: この関数だけを
 * core から import した状態で `apps/web` の生成物に `format-*.js`
 * （1,193.04 kB）という、他のどの route チャンクよりも桁違いに大きい
 * チャンクが生まれた。`MemoryCreatedAt` は型だけなので消えるが、値は
 * 消えない。**型の網羅性チェックのためだけに約1.2MBを配る家庭用の道具に
 * しないため**、ロジックは同じでも実体はここに置く（`memory.ts` の
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

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
