/**
 * `Error.prototype.cause` の連鎖を、stderr の跡にもクローンへ返す本文にも
 * 安全に載せられる1行へ畳む（Issue #1229）。
 *
 * ## なぜ要るか
 *
 * `drizzle-orm@0.45.2`（`packages/storage-pg` が使う版）の `DrizzleQueryError`
 * は、元の PostgreSQL エラー（node-postgres の `DatabaseError`。SQLSTATE は
 * `.code`）を `this.cause` へそのまま保持している。だが alteroid 側はどの層でも
 * `.cause` を読んでいなかった（Issue #1229 の調査。⚠️ ただし `apps/daemon/src/
 * runner-client.ts` の `causeInfoOf` は例外——undici の `cause.code` を1段だけ
 * 読む前例が既に在る。**「0件」だったのは `packages/core/src` /
 * `packages/storage-pg/src` の側であって、`apps/daemon/src` 全体ではない**。
 * この関数はその前例（1段・`code` だけ）を、depth・duck typing の対象を
 * 広げて一般化したものである）。⟹ 書き込みが失敗しても、SQLSTATE のような
 * 「何が起きたか」を機械的に切り分けられる情報が、クローンにも人間にも
 * 一度も届いていなかった。
 *
 * ## 何を畳むか・何を畳まないか
 *
 * 各段（渡された error 自身と、その `.cause`、その `.cause.cause`、…）を
 * `name: message の1行目` へ切り詰め、その段が持つ構造化フィールドを
 * duck typing で拾って `key=value` の形で後ろへ並べる。段どうしは ` <- ` で
 * 繋ぐ。
 *
 * **1行目だけを取るのは、2行目に本文が化けて出ることがあるからである。**
 * `DrizzleQueryError` の `message` は `Failed query: <sql>\nparams:
 * <束縛パラメータ>` という形で、2行目に insert しようとした行の値がそのまま
 * 並ぶ（実測。`dropped-record.ts` の `reasonOf` の doc と同じ観測）。1行目
 * だけを取るこの関数は、この経路を通す限り2行目を出さない。
 *
 * **拾う構造化フィールドは `code` / `constraint` / `table` / `schema` /
 * `column` / `routine` / `severity` の7つだけ**（node-postgres が
 * `pg-protocol` のエラー応答から詰める欄。`pg-protocol/src/parser.ts` の
 * `parseErrorMessage` で実測）。string のものだけを、短く切って拾う。
 *
 * ⛔ **`detail` / `hint` / `where` / `internalQuery` / `query` は拾わない。**
 * これらは**行の値**を含みうる —— 一意制約違反の `detail` は
 * `Key (id)=(実際に insert しようとした値) already exists.` の形で、失敗した
 * 行の値そのものを転記する（PostgreSQL のエラーメッセージ仕様）。`where` /
 * `internalQuery` も PL/pgSQL の文脈やクエリ文字列を持ち込みうる。
 * `code` / `constraint` / `table` / `schema` / `column` / `routine` /
 * `severity` はどれもスキーマの識別子（列挙値・オブジェクト名）であって、
 * クローンやマネージャーが書いた本文の値ではない —— `journalEntryShape` /
 * `approvalShape`（`dropped-record.ts`）が「値を誰が決めるか」で線を引くのと
 * 同じ判断をここでも採っている。**この7つに絞ってあるのは網羅ではなく決裁
 * である**——PostgreSQL のエラー応答はここに挙げていない欄（`position` /
 * `internalPosition` / `file` / `line` 等）も持つが、切り分けに要る最小限
 * だけを通す。要る欄が増えたら、ここへ追加する前に「値を含まないか」を
 * 同じ基準で検算すること。
 *
 * ## 深さと循環
 *
 * 段数の上限は4（渡された error 自身 + `.cause` を最大3段）。`.cause` が
 * 巡回（`a.cause === a` 等）していても、見た参照を控えて2度目で打ち切るので
 * 無限ループしない。
 *
 * ## 既存の契約との関係
 *
 * **`dropped-record.ts` の `reasonOf`（stderr の跡）はこの関数へ委ねる。**
 * 元々 `reasonOf` が持っていた「1行目だけ・200字で切る」という契約は、
 * `.cause` を持たない error（このリポジトリの大半の例外）に対しては
 * 1文字も変わらない——この関数の1段目の切り詰め幅を `reasonOf` の
 * 既存の上限と同じ200字にしてあるためである。`.cause` を持つ error
 * （drizzle 経由の pg エラー等）に対してだけ、2段目以降が追加で出る。
 *
 * **クローンへ返す本文にもそのまま使ってよい。** `dropped-record.ts` の
 * `reasonOf` 自体は「応答へ返す本文の安全をこの関数に肩代わりさせないこと」
 * と釘を刺しているが、それは reasonOf が `error.message` を無条件に
 * 使うことの危うさ（2行目に値が化けて出る経路がドライバ依存であること）
 * についての注意であって、**この関数はその危うさそのものを塞ぐために
 * 作った**——1行目だけを取り、かつ値を含みうる欄（`detail` 等）を最初から
 * 拾わない。だから `packages/core/src/tools.ts` の
 * `formatJournalNotRecordedMessage`（クローンへ返す「理由:」行）も
 * この関数を直接使う。
 *
 * ## 伏せ字（issue #2415）
 *
 * **各段の message は、1行目を取る前に `redactErrorText`（`denial-input-head.ts`）を
 * 通す。** 「1行目だけ」はドライバの改行の位置に頼った守りで、設計上の保証では
 * ない。1行目に値が載る形（`params:` が同じ行に続く、URL の資格、`Bearer <token>`、
 * `NAME=value`）はここで伏せる。**切る前に伏せる**——200字の境界で割れたトークンの
 * 断片は、どの伏せ字にも合わなくなって残る（`denial-input-head.ts` の doc）。
 * 診断に要る部分（SQL 文・エラーの種類・URL の host）は残す。
 *
 * **段ごとに通す理由**: 最後の連結済みの文字列に通すより、段の境界（` <- `）を
 * またぐ規則の誤作動が無く、構造化フィールドの値（短い識別子）と `name` も同じ
 * 入口で伏せられる。ここを通る文は `reasonOf`（stderr の跡・`base.onError`・
 * `noteDroppedRecord` 等）と `formatJournalNotRecordedMessage` のすべてなので、
 * 各呼び出し側に足すより漏れがない。
 *
 * 環境変数の網には `process.env` を渡す（名前が `TOKEN` / `KEY` 等に合い、8文字
 * 以上の値だけが対象。`denial-input-head.ts` の doc）。
 */

import { redactErrorText } from './denial-input-head.js';

/** 伏せ字を通す前に読む message の上限。巨大な message で伏せ字の走査が伸びないように。 */
const REDACT_INPUT_LIMIT = 8192;

/** 段ごとの `name: message` の切り詰め上限。1段目は `reasonOf` の既存の
 * 上限（`dropped-record.ts` の `REASON_LIMIT`）と同じ値にして、`.cause` を
 * 持たない error に対する `reasonOf` の出力を変えない。 */
const HEAD_LIMIT = 200;

/** 2段目以降（`.cause` を辿った先）の切り詰め上限。1段目より短くして、
 * 段数が増えても全体が際限なく伸びないようにする。 */
const CHAIN_LEVEL_LIMIT = 120;

/** 構造化フィールド1つぶんの値の切り詰め上限（`dropped-record.ts` の
 * `TAG_LIMIT` と同じ考え方——id・列挙値の類が長くなることは無い想定）。 */
const FIELD_LIMIT = 64;

/** 出す段数の上限（渡された error 自身 + `.cause` を最大3段）。 */
const MAX_LEVELS = 4;

/**
 * 各段から duck typing で拾う構造化フィールド。**この7つに絞ってある理由は
 * このファイル冒頭の doc を見よ**——値を含みうる `detail` / `hint` / `where`
 * / `internalQuery` / `query` は意図して含めていない。
 */
const STRUCTURED_KEYS = [
  'code',
  'constraint',
  'table',
  'schema',
  'column',
  'routine',
  'severity',
] as const;

/**
 * `error` とその `.cause` の連鎖を1行へ畳む。
 *
 * このファイル冒頭の doc を見よ——1行目だけ・段ごとに切り詰め・構造化
 * フィールドは7つだけ・深さ上限4・循環ガード、のすべてがここに実装されている。
 */
export function collapseErrorCause(error: unknown): string {
  const levels: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  for (let depth = 0; depth < MAX_LEVELS; depth += 1) {
    if (current === null || current === undefined) break;
    if (seen.has(current)) {
      levels.push('(循環する cause を検出したためここで打ち切り)');
      break;
    }
    seen.add(current);
    levels.push(levelText(current, depth === 0 ? HEAD_LIMIT : CHAIN_LEVEL_LIMIT));
    if (!(current instanceof Error)) break;
    const next: unknown = current.cause;
    if (next === undefined) break;
    current = next;
  }
  return levels.join(' <- ');
}

/** 1段ぶんの表示（`name: message の1行目` + 構造化フィールド）。 */
function levelText(value: unknown, limit: number): string {
  const head =
    value instanceof Error
      ? clip(safeLine(`${value.name}: ${value.message}`), limit)
      : clip(safeLine(String(value)), limit);
  const fields = structuredFieldsOf(value);
  return fields === '' ? head : `${head} ${fields}`;
}

/** 伏せ字を通してから1行目を取る（切るのはこの後。境界で割れた断片を残さない）。 */
function safeLine(text: string): string {
  return firstLine(redactErrorText(text.slice(0, REDACT_INPUT_LIMIT), process.env));
}

/**
 * 構造化フィールドを duck typing で拾う。**型で判定しない**——
 * `DatabaseError`（`pg`）を import して instanceof で判定すると、
 * `@alteroid/core` が `pg` に依存することになる（この package は
 * ドライバを問わない設計——`packages/storage-fs` / インメモリ実装は `pg` を
 * 持たない）。値の形だけで判定すれば、どのドライバの例外でも同じ関数が使える。
 */
function structuredFieldsOf(value: unknown): string {
  if (typeof value !== 'object' || value === null) return '';
  const record = value as Record<string, unknown>;
  return STRUCTURED_KEYS.flatMap((key) => {
    const raw = record[key];
    return typeof raw === 'string' && raw !== ''
      ? [`${key}=${clip(safeLine(raw), FIELD_LIMIT)}`]
      : [];
  }).join(' ');
}

function firstLine(text: string): string {
  return text.split('\n', 1)[0] ?? '';
}

function clip(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}
