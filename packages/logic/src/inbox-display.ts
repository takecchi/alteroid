/**
 * 受信箱（`/inbox`）の表示の写し。React にも依存しない。
 *
 * **送る値・URL の値・API の値は変えない。** ここは画面に出す名前だけを持つ
 * （`journal-display.ts` の `JOURNAL_TYPE_LABEL` と同じ作法）。
 */
import type { InboxEventType } from './types.js';

/**
 * 受信箱の合図の種類の日本語名（並びがそのまま画面の表示順）。値の意味は
 * `packages/core/src/schema.ts` の `inboxEventSchema` に拠る。
 * `satisfies Record<InboxEventType, string>` で縛ってあるので、種類が増えて
 * 名前を足し忘れると型で落ちる。日誌の種別（`JOURNAL_TYPE_LABEL`）とは別の軸の値
 * （受信箱の合図の種類）なので、表は別に持つ。
 */
export const INBOX_TYPE_LABEL = {
  human_message: '人間の発言',
  human_answer: '人間の回答（承認待ちへの返事）',
  distill: '記憶の整理',
  timer: '定期ジョブ',
  external: '外からの通知',
  self_initiative: 'クローンの自発的な動き',
  manager_message: 'マネージャーの報告',
} satisfies Record<InboxEventType, string>;

/** 表示順。`INBOX_TYPE_LABEL` の宣言順が正本。 */
export const INBOX_TYPES = Object.keys(INBOX_TYPE_LABEL) as InboxEventType[];

/**
 * 種類の日本語名。知らない種類（新しいデーモンが先に出した値）は、識別子を出さずに
 * 一般的な言い方にする。`Object.hasOwn` で引く（`constructor` のような継承したキーを拾わない）。
 */
export function inboxTypeLabel(type: string): string {
  return Object.hasOwn(INBOX_TYPE_LABEL, type)
    ? (INBOX_TYPE_LABEL as Record<string, string>)[type]!
    : 'その他の種類';
}

/**
 * 送信元（`external:<名前>` / `manager:<名前>`。`inboxBacklogSourceFor` の表記）を読める形にする。
 * 絞り込みへ送る値は変えない（これは表示だけ）。
 */
export function inboxSourceLabel(source: string): string {
  if (source.startsWith('external:')) return `外部「${source.slice('external:'.length)}」`;
  if (source.startsWith('manager:')) return `マネージャー「${source.slice('manager:'.length)}」`;
  return source;
}

/**
 * `<input type="datetime-local">` の値（`YYYY-MM-DDTHH:mm`。利用者の地域の時刻）を、
 * 送る形（`Date#toISOString()` と同じ UTC の ISO 8601）へ変える。空・読めない値は `undefined`。
 */
export function localDateTimeToIso(value: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed === '') return undefined;
  const date = new Date(trimmed);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}
