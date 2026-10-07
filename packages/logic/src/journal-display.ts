/**
 * 日誌の表示の定数（種別の色・並び・検索の断り・頁の大きさ）。Web・swr・TUI が読む**1か所**。React にも Tailwind にも依存しない — 色は名前（`'warn'` など）で持ち、どの色に
 * 塗るかは読む側が決める。
 */
import {
  JOURNAL_SEARCH_UNCOVERED_LIST,
  JOURNAL_SEARCH_UNSEARCHABLE_TYPES,
} from '@alteroid/core/journal-search';

import type { JournalEntryType } from './types.js';

/** 種別ごとの見た目の強さ。 */
export type JournalTone = 'neutral' | 'ok' | 'warn' | 'danger' | 'accent';

/**
 * 種別ごとの見た目の強さ。**`satisfies Record<JournalEntryType, JournalTone>` で縛ってあるので、
 * 種別を足してここを足し忘れると型で落ちる**（core の `journalEntryTypeNames` と同じ作法）。
 *
 * 下の `JOURNAL_TYPES`（絞り込みチップの表示順）はここから導出する — **正本は1つだけ**。
 * core の `JOURNAL_ENTRY_TYPES` から導かないのは、宣言順が違うため（core は `token_rotation`
 * `subagent_stall` が `context_usage` `inbox_flow` より前）。表示順を変えない約束なので、
 * 順の正本はここの宣言順である。集合が core と同じであることは Web の `journal.test.tsx` が見る。
 */
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
  // `turn_usage` と同じ理由——失敗したターンの観測も含むが、それ自体は
  // 「その場で壊れて動いていない」ことを表す種別ではない。
  context_usage: 'neutral',
  // **`warn` にしてある。** この種別が出るのは枠に当たったときで、`rotated` でも
  // 「撒いた（走行中には届いていない）」までしか意味しない。`neutral` にすると
  // `exhausted`（全層が止まる）が普通の行と同じ色で並ぶ。**色は種別ごとに1つしか
  // 選べないので、いちばん重い側に合わせる。**
  token_rotation: 'warn',
  // **`warn` にしてある。** この種別は `outcome` に `woken`（起こし直した＝その場
  // で回復した）と `limit_reached`（上限に達して起こし直さなかった＝自動では
  // 再開しない）の2値を持つが、色は種別ごとに1つなので、`token_rotation` と同じ理由で
  // いちばん重い側（`limit_reached`）に合わせる。**`danger` にはしていない** —
  // `danger` はこの画面の他所（`manager-detail.tsx` の「セッション切断」等）で
  // 「その場で壊れて動いていない」ことに使っており、`token_rotation` の
  // `exhausted`（全層が止まる、こちらのほうが重い）ですら `warn` に留めている
  // 釣り合いに合わせた。
  subagent_stall: 'warn',
  // **`neutral` にしてある。** この種別は器の記帳（受信箱の流量の計測）で、
  // それ自体は「壊れている」ことを表さない —— 値が
  // 何を意味するかは読んだ人が窓どうしを並べて決めることで、行の色では
  // 言えない（`turn_usage` / `context_usage` と同じ理由）。
  inbox_flow: 'neutral',
  // **`neutral`。** 観測した側の申告の記録で、それ自体は壊れていることを表さない。
  github_observation: 'neutral',
} satisfies Record<JournalEntryType, JournalTone>;

/**
 * 絞り込みに出す種別の一覧。**`JOURNAL_TONE` の宣言順が正本**（`Object.keys` は文字列キーの
 * 宣言順を保つ）。表示順を変える意図があるときは `JOURNAL_TONE` の宣言順を変えること。
 * 絞り込みはサーバへ投げる（`GET /journal?type=`）ので、ここは表示順のためだけに在る。
 */
export const JOURNAL_TYPES = Object.keys(JOURNAL_TONE) as [JournalEntryType, ...JournalEntryType[]];

/**
 * 語で探しているとき、探す対象に入っていない欄が在ることの断り（`journal-search.ts` の
 * 「対象にしていない欄」）。**検索していないときは出さない**のは読む側の仕事。
 */
export const SEARCH_SCOPE_NOTE = `${JOURNAL_SEARCH_UNCOVERED_LIST} は探す対象に入っていない（そこにだけ書かれている語は当たらない）。`;

/** 初期表示・1回の「もっと遡る」で読む件数。 */
export const JOURNAL_PAGE = 100;

/**
 * 種別の日本語名（Web の種別チップと各行のバッジ）。**識別子（`exchange` など）は
 * 利用者に見せない**——行を開いた先の JSON と、バッジの `title`（補足）にだけ残す。
 * `satisfies Record<JournalEntryType, string>` で縛ってあるので、種別を足して名前を足し忘れると
 * 型で落ちる。CLI の TUI は識別子のまま出す（開発者向けの道具）ので、こちらは読まない。
 */
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
} satisfies Record<JournalEntryType, string>;

/** 種別の日本語名。知らない種別（新しいデーモンが先に出した値）は識別子のまま返す。 */
export function journalTypeLabel(type: string): string {
  return (JOURNAL_TYPE_LABEL as Record<string, string>)[type] ?? type;
}

/**
 * {@link SEARCH_SCOPE_NOTE} の Web 版。識別子の代わりに日本語名で言う。
 * 探す対象にしない種別の集合は core の `JOURNAL_SEARCH_UNSEARCHABLE_TYPES` が正本。
 */
export const SEARCH_SCOPE_NOTE_JA = `${['道具の入力', ...JOURNAL_SEARCH_UNSEARCHABLE_TYPES.map(journalTypeLabel)].join('・')}は探す対象に入っていない（そこにだけ書かれている語は当たらない）。`;
