import { z } from 'zod';

import type { Commitment } from './schema.js';

/**
 * `commitment_list`（一覧モード）の継続点（issue: 一覧モードから予算で
 * あふれた分へ到達できない）。
 *
 * **形は HTTP の `GET /commitments` に既にある `cursor` へ合わせた。**
 * 意味は「件数」ではなく「不透明な位置（keyset）」——`apps/daemon/src/app.ts`
 * の `commitmentsCursorSchema` の doc（逐語）:
 *
 * > 一覧は2段でできている（`CommitmentStore.list` の契約）: 未了
 * > （`closedAt === undefined`）を `at` の**昇順**、片付き
 * > （`closedAt !== undefined`）を `closedAt` の**降順**で、その順に連結
 * > したもの。2段を跨ぐ錨は作らない。代わりに**錨が自分の段を名乗る**
 * > （`segment`）。
 *
 * **`packages/core` は `apps/daemon` に依存できない**（依存の向きが逆—
 * `apps/daemon` が `@alteroid/core` を使う側）ので、このファイルは
 * `apps/daemon/src/cursor.ts` / `apps/daemon/src/app.ts` の実装を import
 * せず、同じ**契約**（`CommitmentStore.list` の順序）を独立に実装する。
 * 2箇所の実装が指す契約は同じなので、片方だけがずれたら
 * `packages/core/src/commitment-cursor.test.ts` と
 * `apps/daemon/src/app.test.ts`（`/commitments` の cursor まわり）の
 * どちらかが赤くなる——揃っているかどうかは歯で見張る形で、コードの共有
 * ではなく契約の一致で持たせている。
 *
 * **`offset` という名前は使わない。** `commitment_list` の `offset` は
 * 既に「`id` で全文を読むとき、何文字目から読むか」という別の単位
 * （文字数）を持っている（`tools.ts` の `offset` の doc、逐語:
 * 「id で全文を読むとき、何文字目から読むか」）。同じ名前に2つの単位を
 * 持たせると、`apps/daemon/src/cursor.ts` が HTTP 側で既に踏んだのと
 * 同じ形の紛れが道具の側にも生まれる——だから HTTP と同じく `cursor`
 * という別名を使う。
 */

/** 台帳の1行を、並び替えのための位置へ写す。 */
export interface CommitmentPosition {
  segment: 'open' | 'closed';
  /** `open` は `at`、`closed` は `closedAt`。 */
  key: string;
  id: string;
}

/**
 * `Commitment` から位置を取り出す。
 *
 * **かつて `apps/daemon/src/app.ts` に `commitmentPos` という同名の実装が
 * 別途在ったが、ここ（`@alteroid/core`）へ移設済み**（移設の経緯は同ファイルの
 * 逐語で当たる: `grep -Fn -- 'ここに `commitmentPos` / `compareCommitmentPos` という1バイト違わない実装が' apps/daemon/src/app.ts`）。
 */
export function commitmentPosition(
  entry: Pick<Commitment, 'id' | 'at' | 'closedAt'>,
): CommitmentPosition {
  return entry.closedAt === undefined
    ? { segment: 'open', key: entry.at, id: entry.id }
    : { segment: 'closed', key: entry.closedAt, id: entry.id };
}

/**
 * 段（segment）を持つ keyset の比較。**未了(open) が先、片付き(closed) が後。**
 * `open` の中は `key`（`at`）昇順 → 同値は `id` 昇順。`closed` の中は `key`
 * （`closedAt`）降順 → 同値は `id` 昇順。
 *
 * **かつて `apps/daemon/src/app.ts` に `compareCommitmentPos` という同名の実装が
 * 別途在ったが、ここ（`@alteroid/core`）へ移設済み**（移設の経緯は同ファイルの
 * 逐語で当たる: `grep -Fn -- 'ここに `commitmentPos` / `compareCommitmentPos` という1バイト違わない実装が' apps/daemon/src/app.ts`）。
 */
export function compareCommitmentPosition(a: CommitmentPosition, b: CommitmentPosition): number {
  if (a.segment !== b.segment) return a.segment === 'open' ? -1 : 1;
  if (a.segment === 'open') {
    if (a.key !== b.key) return a.key < b.key ? -1 : 1;
  } else {
    if (a.key !== b.key) return a.key > b.key ? -1 : 1;
  }
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  return 0;
}

/**
 * カーソルの中身。**`includeClosed` を含める。**
 *
 * 錨は「刷られた一覧の `includeClosed`」を持つ——HTTP の
 * `commitmentsCursorSchema` と同じ理由（逐語: 「錨を刷った一覧がどちらだった
 * かを持つ。錨は刷られた一覧の中でしか意味を持たないので、リクエストの
 * `includeClosed` と食い違えば 400 にする」）。**MCP 側は 400 を返せない
 * ので text で明示のエラーを返す**（`resolveCommitmentCursor` の
 * `'includeClosed-mismatch'`）。
 *
 * **`order` も同じ理由で持つ（`commitment_list` に `order` を足した分。段0で
 * 確認: 台帳が260件まで膨らみ、未了を古い順にしか出せないと、今夜作られた
 * 行へ予算の中で到達する手が無くなる）。** 錨は「刷った一覧がどちらの向きに
 * 辿っていたか」を持たないと、`oldest` の続きのつもりで `newest` の一覧へ
 * 繋いでしまう（辿る方向が食い違えば、同じ行を繰り返し返すか、間の行を
 * 飛ばす）。**`includeClosed` が食い違ったときとまったく同じ形の穴なので、
 * 同じ場所に同じ形で持たせる。**
 *
 * **⚠️ `z.enum(['oldest', 'newest']).default('oldest')` にすること。**
 * `order` を持たない欄を `z.enum(...)`（default 無し）にすると、`order` を
 * 足す前に発行済みのカーソル（`order` の欄そのものが無い JSON）が
 * `commitmentCursorSchema.safeParse` で落ち、`decodeCommitmentCursor` が
 * `{ ok: false }`（malformed）を返す——**その時点でまだ使われていただけの
 * カーソルが、この変更のせいで一斉に「壊れている」へ化ける。** `.default()`
 * にすれば、欄が無い（＝旧いカーソル）ときは `'oldest'` として読め、かつ
 * いまの振る舞い（既定は古い順）とも一致する。
 *
 * **`origin` / `q` も同じ理由で持つ（issue #1390）。** `includeClosed` /
 * `order` は一致を検査するのに、`commitment_list` の `origin`（出所で絞る）
 * と `q`（語で探す）は検査していなかった——**cursor の schema に欄その
 * ものが無く、比較のしようが無かった。** 別の絞り込みで取った cursor を
 * 渡すと、黙って別の絞りの続きとして使われる（同じ形の穴が4つ目まで
 * 空いていた、という意味で `includeClosed` / `order` と同列）。
 *
 * **旧いカーソル（この変更より前に発行され、`origin`/`q` の欄そのものが
 * 無い）の扱いは `order` を足したときの前例をそのまま踏まない。** `order`
 * は欄を足す前から「実質つねに `oldest`」だった（`order` という呼び方の
 * 選択肢自体が無かった）ので、`.default('oldest')` は当時の実際の挙動を
 * そのまま欄に写しただけである。**`origin`/`q` にはその前例が無い** ——
 * 欄が無かった時代のカーソルが実際にどの絞り込みから発行されたかは
 * わからない（`origin`/`q` は呼び手が毎回自由に選べる値で、`order` の
 * ような単一の既定挙動が無いため）。**だから安全側に倒す**：欄が無ければ
 * 「絞っていない」（`origin: undefined` / `q: undefined`。正規化すると
 * どちらも `q: ''` と同じに読む——下の正規化を参照）として読める――これは
 * *「旧いカーソルは絞っていなかった」と決めてかかる*のではなく、**旧い
 * カーソルは絞っていない呼びで使われたときだけ黙って続き、絞った呼びで
 * 使われたときは（旧いカーソルの実際の絞り込みが何であれ）必ず
 * `origin-mismatch` / `q-mismatch` として断られる**、という形にするための
 * 選択である（`resolveCommitmentCursor` の比較がそう作られている——
 * 詳細は同関数の doc）。**黙って別の絞りの続きにしてしまう事故は起きず、
 * 起きうるのは「本当は同じ絞りだったのに、記録が無いという理由だけで
 * 一度読み直しを求められる」という過剰な安全側の誤検知だけである。**
 *
 * **`origin` の正規化**: `commitment_list` の絞り込みは
 * `origin === undefined ? 絞らない : entries.filter(e => origin.includes(e.origin))`
 * （`tools.ts`）——**集合としての一致**であって並び順は見ない。同じ集合を
 * 順序違い・重複違いで渡しても同じ結果集合になるので、比較でもその違いは
 * 無視する（`normalizeCommitmentOrigin`）。`origin: []`（明示的に「どれにも
 * 当たらない」）は `undefined`（絞らない）とは区別する——`tools.ts` の
 * `origin: []` の契約（`journal_read` の `with` / `types` と同じ）と揃える。
 *
 * **`q` の正規化**: `commitment_list` の絞り込みは
 * `q === undefined ? 絞らない : entries.filter(... .toLowerCase().includes(q.toLowerCase()))`
 * （`tools.ts`）。**`q: ''` は任意の文字列に含まれる（`''.includes('')` も
 * 含め、空文字はどの文字列にも部分一致する）ので、`q === undefined` と
 * `q === ''` は常に同じ結果集合を作る**——だから両者を同一視する
 * （`normalizeCommitmentQ` が `undefined` を `''` へ寄せる）。**大文字小文字
 * の違いも同じ理由で同一視する**——`tools.ts` の絞り込みは両辺を
 * `toLowerCase()` してから比較するので、大文字小文字だけが違う `q` は
 * 常に同じ結果集合を作る。
 */
const commitmentCursorSchema = z.object({
  segment: z.enum(['open', 'closed']),
  key: z.string().min(1),
  id: z.string().min(1),
  includeClosed: z.boolean(),
  order: z.enum(['oldest', 'newest']).default('oldest'),
  /** `commitment_list` の `origin`。`undefined` = 絞っていない。 */
  origin: z.array(z.string()).optional(),
  /**
   * `commitment_list` の `q`。`undefined` = 絞っていない。**`order` とは
   * 違い `.default('')` にしない**——`q === undefined` と `q === ''` は
   * 比較の時点で `normalizeCommitmentQ` が同じ値へ正規化するので、schema
   * 側で既定値を持たせる必要が無い。`.optional()` のままにすることで、
   * 既存の `encodeCommitmentCursor` の呼び出し（`order` は毎回明示する
   * 契約だが `q` は明示しない箇所が大半）に `q: ''` を書き足させずに済む
   * ——`origin` と同じ扱い。
   */
  q: z.string().optional(),
});

/**
 * `origin` の正規化——`undefined`（絞っていない）はそのまま、配列は重複を
 * 除いて昇順に並べ替える（順序・重複違いを同じ集合として扱うため）。
 */
function normalizeCommitmentOrigin(origin: readonly string[] | undefined): string[] | undefined {
  if (origin === undefined) return undefined;
  return [...new Set(origin)].sort();
}

/** `origin` どうしが同じ絞り込みを表すか（正規化した集合の一致）。 */
function originsMatch(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
  const na = normalizeCommitmentOrigin(a);
  const nb = normalizeCommitmentOrigin(b);
  if (na === undefined || nb === undefined) return na === undefined && nb === undefined;
  if (na.length !== nb.length) return false;
  return na.every((value, index) => value === nb[index]);
}

/**
 * `q` の正規化——`undefined` を `''` へ寄せ、小文字化する（未指定と空文字、
 * 大文字小文字の違いを同じ絞りとして扱うため。理由は上の doc）。
 */
function normalizeCommitmentQ(q: string | undefined): string {
  return (q ?? '').toLowerCase();
}

export type CommitmentCursor = z.infer<typeof commitmentCursorSchema>;

/** カーソルを不透明な文字列へ符号化する。呼び手は中身の構造を知らなくてよい。 */
export function encodeCommitmentCursor(cursor: CommitmentCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

export type DecodeCommitmentCursorResult = { ok: true; cursor: CommitmentCursor } | { ok: false };

/**
 * カーソルを decode する。**壊れていれば（base64/JSON として読めない、また
 * は schema に合わない）`{ ok: false }`。** 実在検査はしない——
 * `resolveCommitmentCursor` が比較（keyset）で辿るので、錨が指していた行が
 * 別の段へ移っていても（未了→片付き）続きは正しく決まる。HTTP の
 * `decodeCursor` の doc と同じ理由（逐語: 「位置ではなく比較（keyset）で
 * 辿る口では、この実在検査は要らない」）。
 */
export function decodeCommitmentCursor(raw: string): DecodeCommitmentCursorResult {
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    return { ok: false };
  }
  const parsed = commitmentCursorSchema.safeParse(json);
  if (!parsed.success) return { ok: false };
  return { ok: true, cursor: parsed.data };
}

/**
 * `cursor` を受け取り、`entries`（すでに固定順——`CommitmentStore.list` の
 * 契約に加え、呼び出し側で `origin` / `q` を絞り、`order` に応じて並びを
 * 反転させた後のもの）から、その位置より後ろだけを残す。**純関数。I/O を
 * 持たない**（`Commitment[]` の配列を渡すだけで呼べる——
 * `commitment-cursor.test.ts` はストアを1つも作らずにこれを直接叩く）。
 *
 * **`order` は比較の向きだけを決める。`entries` を並べ替えるのは呼び出し側
 * （`tools.ts`）の仕事で、ここでは並べ替えない**（`CommitmentStore.list` の
 * 契約そのものは変えない——反転はツール層の見え方であって、ストアの契約では
 * ない）。`entries` が `order: 'newest'` 用にもう反転済みで渡ってくる前提で、
 * `oldest` は「pivot より後ろ（`compareCommitmentPosition(...) > 0`）」、
 * `newest` は「pivot より前（`compareCommitmentPosition(...) < 0`）」を残す
 * ——`entries` の見た目の並びに対して常に「pivot の次から」が取れるよう、
 * 比較の向きを逆にする。
 *
 * - `cursorRaw` が `undefined`: 絞らない（先頭から）。`{ kind: 'ok', view:
 *   [...entries] }`
 * - decode できない: `{ kind: 'malformed' }`
 * - `includeClosed` が食い違う: `{ kind: 'includeClosed-mismatch',
 *   cursorIncludeClosed }`——**黙って先頭からへは倒さない**（AGENTS.md
 *   「判定できないという3つ目の状態を持つ」と同じ理由）
 * - `order` が食い違う: `{ kind: 'order-mismatch', cursorOrder }`——
 *   **`includeClosed` が食い違ったときとまったく同じ理由で、黙って
 *   どちらか一方へは倒さない。** 辿る方向が食い違ったまま続きを解決すると、
 *   同じ行を繰り返し返すか、間の行を黙って飛ばす
 * - `origin` が食い違う（正規化した集合として一致しない）: `{ kind:
 *   'origin-mismatch', cursorOrigin }`——**`includeClosed` / `order` と
 *   まったく同じ理由（issue #1390）。** 別の出所の絞り込みで取った
 *   cursor を黙って別の絞りの続きとして使うと、呼び手が意図していない
 *   出所の行まで混ざる（またはその逆に、意図していた出所の行が黙って
 *   落ちる）
 * - `q` が食い違う（正規化した文字列として一致しない）: `{ kind:
 *   'q-mismatch', cursorQ }`——同じ理由。別の語で絞った cursor を黙って
 *   続けると、絞り込みの前提が呼び手の知らないところですり替わる
 * - それ以外: `{ kind: 'ok', view }`。`view` は0件のこともある（カーソルが
 *   一覧の末尾を指していた＝最後の頁）——これは呼び出し側が「もう続きは
 *   無い」として扱う、正常な終端であってエラーではない
 *
 * **チェックの順序は includeClosed → order → origin → q。** 早い段階の
 * 食い違いのほうが先に見つかった時点で返してよい（複数同時に食い違って
 * いても、呼び手はどのみち cursor を作り直すことになるので、どれを先に
 * 報告するかは呼び出し側の文言の都合以上の意味を持たない）。
 */
export function resolveCommitmentCursor(
  entries: readonly Commitment[],
  includeClosed: boolean,
  cursorRaw: string | undefined,
  order: 'oldest' | 'newest' = 'oldest',
  origin?: readonly string[],
  q?: string,
):
  | { kind: 'ok'; view: Commitment[] }
  | { kind: 'malformed' }
  | { kind: 'includeClosed-mismatch'; cursorIncludeClosed: boolean }
  | { kind: 'order-mismatch'; cursorOrder: 'oldest' | 'newest' }
  | { kind: 'origin-mismatch'; cursorOrigin: string[] | undefined }
  | { kind: 'q-mismatch'; cursorQ: string | undefined } {
  if (cursorRaw === undefined) return { kind: 'ok', view: [...entries] };
  const decoded = decodeCommitmentCursor(cursorRaw);
  if (!decoded.ok) return { kind: 'malformed' };
  if (decoded.cursor.includeClosed !== includeClosed) {
    return { kind: 'includeClosed-mismatch', cursorIncludeClosed: decoded.cursor.includeClosed };
  }
  if (decoded.cursor.order !== order) {
    return { kind: 'order-mismatch', cursorOrder: decoded.cursor.order };
  }
  if (!originsMatch(decoded.cursor.origin, origin)) {
    return { kind: 'origin-mismatch', cursorOrigin: decoded.cursor.origin };
  }
  if (normalizeCommitmentQ(decoded.cursor.q) !== normalizeCommitmentQ(q)) {
    return { kind: 'q-mismatch', cursorQ: decoded.cursor.q };
  }
  const pivot: CommitmentPosition = decoded.cursor;
  const view = entries.filter((entry) => {
    const cmp = compareCommitmentPosition(commitmentPosition(entry), pivot);
    return order === 'newest' ? cmp < 0 : cmp > 0;
  });
  return { kind: 'ok', view };
}
