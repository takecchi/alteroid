import type { JournalEntryType } from './schema.js';

/**
 * 照合にかける日誌1件。**`JournalEntry` そのものではなく、構造で受ける。**
 *
 * この口は4口すべてが通る（issue #250）が、`apps/web` が持っている日誌の型は
 * `@alteroid/core` の `JournalEntry` ではなく **OpenAPI から生成した
 * `@alteroid/api-client` の型**である（`apps/web/app/lib/types.ts`）。同じ形の
 * 別の型なので、`JournalEntry` で受けると **web だけがキャストを書くことに
 * なる** —— キャストは「本当に同じ形か」を誰も検算しないまま黙らせる。
 *
 * **この関数が実際に必要としているのは「文字列の欄を名前で引けること」だけ**
 * なので、必要なぶんだけを型で言う。**どの欄を見るかの安全は
 * `SEARCHABLE_FIELDS_BY_TYPE` の `satisfies Record<JournalEntryType, …>` が
 * 持っていて、そちらは1文字も緩めていない。**
 */
export type JournalSearchTarget = Readonly<Record<string, unknown>>;

/**
 * 日誌を語で探す（`JournalQuery.q`。issue #250）ときに、**どの欄を本文として
 * 見るか**の唯一の正本。
 *
 * **意味論は `conversation_read` の `q` をそのまま踏襲する。新しい検索の
 * 意味論を発明しない**（`conversation.ts` の `searchExchanges` —「大文字小文字
 * を区別しない単純な部分一致だけを持つ。正規表現も AND/OR も持たない」）。
 * 引数の説明文も同じ言い方（「語で探す（大文字小文字を区別しない部分一致）」）
 * に揃えてある。
 *
 * ## なぜ「種別ごとの欄」を宣言してから平らな一覧へ落とすのか
 *
 * **種別を足した人に、探せるかどうかの判断を強制するため。** 下の
 * `SEARCHABLE_FIELDS_BY_TYPE` は `satisfies Record<JournalEntryType, ...>` で
 * 縛ってあるので、`journalEntrySchema` に種別を足してここを足し忘れると**型で
 * 落ちる**（`apps/web/app/routes/journal.tsx` の `TONE`、`schema.ts` の
 * `journalEntryTypeNames` と同じ作法）。「自由文が無い」も `[]` と書いて
 * 明示すること —— 書き忘れと区別が付かなくなる。
 *
 * ただし**照合に使うのは平らにした `JOURNAL_SEARCH_FIELDS` のほうである**。
 * 理由は次の節（3実装で同じ答えを出すため）。
 *
 * ## なぜ「その行の種別の欄だけ」ではなく「全種別の欄を並べたもの」を見るのか
 *
 * **pg が SQL の中で行ごとの種別を分岐せずに済むようにするためである。**
 * この照合は3実装（`testing.ts` のインメモリ / `storage-fs` / `storage-pg`）で
 * **同じ答えでなければならない**（`journal-search-contract.ts` が測る）。
 * pg 側は `entry->>'<欄>'` を `coalesce(…, '')` で繋いだ式に `ILIKE` を当てる
 * ——**JS 側も同じ順序・同じ区切りで、無い欄を空文字列として繋ぐ**ことで、
 * 両者が組み立てる文字列そのものが1バイトも違わなくなる。
 *
 * 行の種別ごとに欄を選ぶ形にすると、pg 側は `case entry->>'type' when …` の
 * 分岐を持つことになり、**JS 側の分岐と食い違っても誰も気づけない**（食い違いは
 * 特定の種別 × 特定の語のときだけ出る）。**平らにして両側から同じ定数を読ませる
 * ほうが、ずれる余地が構造的に無い。**
 *
 * ⚠️ **だから並び順は意味を持つ。** `q` に改行を含めると、繋ぎ目に入る `\n` に
 * 当たりうる（例: `"…text\n…"`）。3実装が同じ順序で繋ぐ限り**答えは揃う**が、
 * 「本文の中の改行」と「欄の繋ぎ目の改行」は区別が付かない。
 *
 * ## 対象にしていない欄（**「無い」と読まないための記録である**）
 *
 * - **`tool_use` の `input`。** ここが日誌でいちばん数の多い種別なので、
 *   探せないのは痛い。それでも外しているのは、**3実装で同じ答えにならない**
 *   からである —— `input` は `z.unknown()` の入れ子で、pg の `entry->>'input'`
 *   が返す jsonb のテキスト化（鍵が長さ順・`{"a": 1}` のように `:` の後に
 *   空白）と JS の `JSON.stringify`（挿入順・空白なし）は**同じ文字列に
 *   ならない**。「だいたい当たる」検索を3実装に配ると、当たらなかったときに
 *   「無い」なのか「実装が違う」なのかが区別できなくなる
 *   （AGENTS.md「静かに失敗する道具」）。
 * - **`worker_wait` / `turn_usage` の本文。** この2種別の「本文」は数から
 *   組み立てた文（`tools.ts` の `renderJournalEntry`）であって、日誌の行には
 *   自由文として保存されていない。**保存されていないものは探せない。**
 * - **`id` / `at` / `type` と、識別子・列挙値の欄**（`actor` / `tool` /
 *   `slug` / `approvalId` / `managerId` / `conversationId` / `with` / `role`
 *   / `cause` / `source` など）。ここを混ぜると `q: "human"` が
 *   `with: 'human'` の全行に当たる —— **本文を探す口が、種別で絞る口の
 *   代わりに使われてしまう**（絞る口は `types` / `with` として既に在る）。
 *
 * **⟹ `q` が当たらないことは「日誌にその語が無い」を意味しない。** 上の欄に
 * だけ書かれている語は、`q` からは見えない。呼び出し口（`journal_read` の
 * 説明文・`GET /journal` の description）はこれを黙らないこと。
 */
const SEARCHABLE_FIELDS_BY_TYPE = {
  exchange: ['text'],
  decision: ['decision', 'grounds'],
  token_rotation: ['text', 'noticeText'],
  escalation: ['question', 'answer'],
  /** `input` は対象外（上の doc）。他に自由文の欄が無い。 */
  tool_use: [],
  memory_update: ['summary'],
  daily_report: ['body', 'unavailable'],
  external_event: ['summary'],
  /** 自由文の欄を持たない（本文は数から組み立てた文である）。 */
  worker_wait: [],
  /** 同上。 */
  turn_usage: [],
} as const satisfies Record<JournalEntryType, readonly string[]>;

/**
 * 照合の対象になる欄の名前を、**重複を潰して名前順に並べた平らな一覧**。
 *
 * **JS 側（インメモリ / fs）と SQL 側（pg）が、どちらもこの定数から式を
 * 組み立てる。** 片側に欄名を書き写さないこと —— 書き写した瞬間に、片方だけ
 * 直して他方を忘れる形ができる（`journalSearchText` の doc）。
 *
 * 名前順にしてあるのは、宣言順（`SEARCHABLE_FIELDS_BY_TYPE` の並び）に依存
 * させないためである。**繋ぐ順序が変われば、改行をまたぐ語の当たり方が変わる**
 * ので、順序は「読む人が再現できる規則」で決まっているほうがよい。
 */
export const JOURNAL_SEARCH_FIELDS: readonly string[] = [
  ...new Set(Object.values(SEARCHABLE_FIELDS_BY_TYPE).flat()),
].sort();

/**
 * 照合に使う「この行の本文」を組み立てる。
 *
 * `JOURNAL_SEARCH_FIELDS` の順に、**その欄が文字列ならその値・そうでなければ
 * 空文字列**を並べ、改行で繋ぐ。無い欄を飛ばさずに空文字列で埋めるのは、pg 側の
 * `coalesce(entry->>'<欄>', '')` と繋ぎ目まで一致させるためである
 * （`SEARCHABLE_FIELDS_BY_TYPE` の doc）。
 *
 * **`typeof value === 'string'` で見るのは防御ではなく契約である。** ここに
 * 並ぶ欄名はすべて `z.string()`（または `z.string().optional()`）だが、将来
 * 同じ名前の非文字列の欄を持つ種別が足されたとき、JS 側は `String(value)` で
 * 何かしらの文字列を作れてしまい、pg 側（`->>` は JSON 値のテキスト化）と
 * ずれる。**作れてしまう側を先に塞いでおく。**
 */
export function journalSearchText(entry: JournalSearchTarget): string {
  return JOURNAL_SEARCH_FIELDS.map((field) => {
    const value = entry[field];
    return typeof value === 'string' ? value : '';
  }).join('\n');
}

/**
 * 語で探す。**大文字小文字を区別しない単純な部分一致だけを持つ**
 * （`conversation.ts` の `searchExchanges` と同じ契約。正規表現も AND/OR も
 * 持たない）。
 *
 * **`q: ''`（空文字列）は全件に当たる＝絞らない。** `types: []` / `with: []`
 * が「どれにも当たらない＝0件」なのと**逆に見えるが、逆ではない** —— あちらは
 * *許す値の集合*で、空集合は何も許さない。こちらは*探す語*で、空の語はどの
 * 文字列にも含まれる（`''.includes('')` は `true`）。**先例もこう振る舞う**
 * （`conversation_read` は `q !== undefined` で分岐し、空文字列をそのまま
 * `searchExchanges` へ渡す）。
 *
 * **画面の都合でもこちら側が正しい。** 検索欄を空にした人が見たいのは
 * 「0件」ではなく「絞っていない一覧」である。
 */
export function matchesJournalSearch(entry: JournalSearchTarget, q: string): boolean {
  return journalSearchText(entry).toLowerCase().includes(q.toLowerCase());
}
