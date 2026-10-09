import type { JournalEntryType } from './schema.js';

// `JournalEntry` で受けない: web が持つ日誌の型は OpenAPI 生成の別の型で、`JournalEntry` で受けると web だけがキャストを書くことになる。
export type JournalSearchTarget = Readonly<Record<string, unknown>>;

// 種別ごとに宣言してから平らな一覧へ落とす: 種別を足した人に探せるかの判断を強制するため（足し忘れは `satisfies` で型が落ちる。自由文が無い種別も `[]` と書く）。
// 照合は「その行の種別の欄」ではなく平らな `JOURNAL_SEARCH_FIELDS` に対して行う: pg が SQL で種別ごとに分岐せずに済み、3実装がずれる余地が無い。
// 対象にしない欄:
// - `tool_use` の `input`: pg の jsonb のテキスト化と JS の `JSON.stringify` が同じ文字列にならず、3実装で答えが揃わない。
// - `worker_wait` / `turn_usage` の本文: 数から組み立てた文で、自由文として保存されていない。
// - 識別子・列挙値の欄（`actor` / `tool` / `with` / `role` など）: 混ぜると `q: "human"` が `with: 'human'` の全行に当たり、種別で絞る口の代わりに使われる。
export const SEARCHABLE_FIELDS_BY_TYPE = {
  exchange: ['text'],
  decision: ['decision', 'grounds'],
  token_rotation: ['text', 'noticeText'],
  // `agentId` / `agentType` / `outcome` は入れない: 識別子・列挙値の欄で、混ぜると `q: "woken"` が `outcome: 'woken'` の全行に当たる。
  subagent_stall: ['text'],
  escalation: ['question', 'answer'],
  // `error` はトップレベルの素の文字列なので、pg の `entry->>'error'` と JS の直読みが一致して対象にできる（`input` とは違う）。
  tool_use: ['error'],
  memory_update: ['summary'],
  daily_report: ['body', 'unavailable'],
  external_event: ['summary'],
  worker_wait: [],
  // `contextUsage.error` は入れない: ネストした欄で、トップレベルの素の文字列だけを想定しているため。
  turn_usage: [],
  context_usage: [],
  inbox_flow: [],
  // `failed.reason` はネストした欄なので対象外。
  github_observation: [],
  conversation_deleted: [],
} as const satisfies Record<JournalEntryType, readonly string[]>;

// 表から導く: 断りを各所に手書きすると、表だけ直して断りが置き去りになる。
export const JOURNAL_SEARCH_UNSEARCHABLE_TYPES: readonly JournalEntryType[] = (
  Object.keys(SEARCHABLE_FIELDS_BY_TYPE) as JournalEntryType[]
).filter((type) => SEARCHABLE_FIELDS_BY_TYPE[type].length === 0);

// 先頭の `tool_use の input` だけは表に載らない: `tool_use` は `error` を持つので `[]` ではない。
export const JOURNAL_SEARCH_UNCOVERED_LIST: string = [
  'tool_use の input',
  ...JOURNAL_SEARCH_UNSEARCHABLE_TYPES,
].join('・');

export const JOURNAL_SEARCH_UNCOVERED_LIST_MD: string = [
  '`tool_use` の `input`',
  ...JOURNAL_SEARCH_UNSEARCHABLE_TYPES.map((type) => `\`${type}\``),
].join('・');

// JS 側と SQL 側はどちらもこの定数から式を組み立てる。欄名を片側へ書き写さないこと。
export const JOURNAL_SEARCH_FIELDS: readonly string[] = [
  ...new Set(Object.values(SEARCHABLE_FIELDS_BY_TYPE).flat()),
].sort();

// 欄を繋がず、欄ごとに別々に当てる: 全欄を `'\n'` で繋ぐと `q: '\n'` が全行に当たり、欄をまたぐ一致もできてしまう。
// `typeof value === 'string'` は契約: 将来、同名の非文字列の欄が足されたとき、JS 側の `String(value)` が pg の `->>` とずれる文字列を作ってしまう。
export function journalSearchValues(entry: JournalSearchTarget): string[] {
  const values: string[] = [];
  for (const field of JOURNAL_SEARCH_FIELDS) {
    const value = entry[field];
    if (typeof value === 'string') values.push(value);
  }
  return values;
}

export function matchesJournalSearch(entry: JournalSearchTarget, q: string): boolean {
  // 空の語は全件に当たる（絞らない）。欄ごとの照合に任せると、探す欄を持たない種別だけが落ちる。
  if (q === '') return true;
  const needle = q.toLowerCase();
  return journalSearchValues(entry).some((value) => value.toLowerCase().includes(needle));
}
