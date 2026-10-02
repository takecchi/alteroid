/**
 * 日誌の表示の定数（種別の色・並び・検索の断り・頁の大きさ）。Web・swr・TUI が読む**1か所**
 * （#2558）。React にも Tailwind にも依存しない — 色は名前（`'warn'` など）で持ち、どの色に
 * 塗るかは読む側が決める。
 */
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
  // 「その場で壊れて動いていない」ことを表す種別ではない（Issue #976）。
  context_usage: 'neutral',
  // **`warn` にしてある。** この種別が出るのは枠に当たったときで、`rotated` でも
  // 「撒いた（走行中には届いていない）」までしか意味しない。`neutral` にすると
  // `exhausted`（全層が止まる）が普通の行と同じ色で並ぶ。**色は種別ごとに1つしか
  // 選べないので、いちばん重い側に合わせる。**
  token_rotation: 'warn',
  // **`warn` にしてある。** この種別は `outcome` に `woken`（起こし直した＝その場
  // で回復した）と `limit_reached`（上限に達して起こし直さなかった＝自動では
  // 再開しない。`runner.ts` の `#onSubagentStop` の doc）の2値を持つが、**色は
  // 種別ごとに1つしかない**ので、`token_rotation` と同じ理由でいちばん重い側
  // （`limit_reached`）に合わせる。`neutral` にすると、要対応の状態が「作業者が
  // 空回りしただけ」の行と同じ色で並んでしまう。**`danger` にはしていない** —
  // `danger` はこの画面の他所（`manager-detail.tsx` の「セッション切断」等）で
  // 「その場で壊れて動いていない」ことに使っており、`token_rotation` の
  // `exhausted`（全層が止まる、こちらのほうが重い）ですら `warn` に留めている
  // 釣り合いに合わせた。
  subagent_stall: 'warn',
  // **`neutral` にしてある。** この種別は器の記帳（受信箱の流量の計測。
  // Issue #783 段0）で、それ自体は「壊れている」ことを表さない —— 値が
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
export const SEARCH_SCOPE_NOTE =
  'tool_use の input・worker_wait・turn_usage・github_observation は探す対象に入っていない（そこにだけ書かれている語は当たらない）。';

/** 初期表示・1回の「もっと遡る」で読む件数。 */
export const JOURNAL_PAGE = 100;
