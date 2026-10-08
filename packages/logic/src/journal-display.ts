import {
  JOURNAL_SEARCH_UNCOVERED_LIST,
  JOURNAL_SEARCH_UNSEARCHABLE_TYPES,
} from '@alteroid/core/journal-search';

import type { JournalEntryType } from './types.js';

export type JournalTone = 'neutral' | 'ok' | 'warn' | 'danger' | 'accent';

// 宣言順が表示順の正本: core の `JOURNAL_ENTRY_TYPES` から導かないのは、宣言順が違うため。
// 色は種別ごとに1つしか選べないので、複数の状態を持つ種別はいちばん重い側に合わせる。
export const JOURNAL_TONE = {
  exchange: 'neutral',
  decision: 'accent',
  escalation: 'warn',
  tool_use: 'neutral',
  memory_update: 'ok',
  daily_report: 'accent',
  external_event: 'warn',
  worker_wait: 'neutral',
  turn_usage: 'neutral',
  context_usage: 'neutral',
  // `neutral` にしない: `exhausted`（全層が止まる）が普通の行と同じ色で並ぶ。
  token_rotation: 'warn',
  // `danger` にしない: `danger` は「その場で壊れて動いていない」ことに使っており、
  // より重い `token_rotation` の `exhausted` ですら `warn` に留めている釣り合いに合わせる。
  subagent_stall: 'warn',
  inbox_flow: 'neutral',
  github_observation: 'neutral',
  conversation_deleted: 'neutral',
} satisfies Record<JournalEntryType, JournalTone>;

export const JOURNAL_TYPES = Object.keys(JOURNAL_TONE) as [JournalEntryType, ...JournalEntryType[]];

export const SEARCH_SCOPE_NOTE = `${JOURNAL_SEARCH_UNCOVERED_LIST} は探す対象に入っていない（そこにだけ書かれている語は当たらない）。`;

export const JOURNAL_PAGE = 100;

// 識別子（`exchange` など）は利用者に見せない（JSON とバッジの `title` にだけ残す）。CLI の TUI は識別子のまま出すので、この表は読まない。
export const JOURNAL_TYPE_LABEL = {
  exchange: 'やりとり',
  decision: '判断',
  escalation: 'エスカレーション',
  tool_use: '道具の実行',
  memory_update: '記憶の更新',
  daily_report: '日報',
  external_event: '外からの出来事',
  worker_wait: '作業者の待機',
  turn_usage: 'ターンの消費',
  context_usage: '文脈の占有',
  token_rotation: 'トークンの交代',
  subagent_stall: '作業者の空回り',
  inbox_flow: '受信箱の流量',
  github_observation: 'GitHub の観測',
  conversation_deleted: '会話の削除',
} satisfies Record<JournalEntryType, string>;

export function journalTypeLabel(type: string): string {
  return (JOURNAL_TYPE_LABEL as Record<string, string>)[type] ?? type;
}

export const SEARCH_SCOPE_NOTE_JA = `${['道具の入力', ...JOURNAL_SEARCH_UNSEARCHABLE_TYPES.map(journalTypeLabel)].join('・')}は探す対象に入っていない（そこにだけ書かれている語は当たらない）。`;
