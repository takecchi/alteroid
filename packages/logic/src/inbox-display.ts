import type { InboxEventType } from './types.js';

// 日誌の種別（`JOURNAL_TYPE_LABEL`）とは別の軸なので、表を統合しない。宣言順が画面の表示順。
export const INBOX_TYPE_LABEL = {
  human_message: '人間の発言',
  human_answer: '人間の回答（承認待ちへの返事）',
  distill: '記憶の整理',
  timer: '定期ジョブ',
  external: '外からの通知',
  self_initiative: 'クローンの自発的な動き',
  manager_message: 'マネージャーの報告',
} satisfies Record<InboxEventType, string>;

export const INBOX_TYPES = Object.keys(INBOX_TYPE_LABEL) as InboxEventType[];

// `Object.hasOwn` で引く: `constructor` のような継承したキーを拾わない。
export function inboxTypeLabel(type: string): string {
  return Object.hasOwn(INBOX_TYPE_LABEL, type)
    ? (INBOX_TYPE_LABEL as Record<string, string>)[type]!
    : 'その他の種類';
}

export function inboxSourceLabel(source: string): string {
  if (source.startsWith('external:')) return `外部「${source.slice('external:'.length)}」`;
  if (source.startsWith('manager:')) return `マネージャー「${source.slice('manager:'.length)}」`;
  return source;
}

export function localDateTimeToIso(value: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed === '') return undefined;
  const date = new Date(trimmed);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}
