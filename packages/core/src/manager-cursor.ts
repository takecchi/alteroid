import { z } from 'zod';

import { jobStatusSchema, type JobStatus } from './schema.js';
import type { ManagerSummary } from './manager.js';

/**
 * `manager_list`（絞った先）の継続点（issue #662 段1）。
 *
 * ## なぜ要るか
 *
 * `status` で群は掘れるが、**絞った先が予算（`LIST_BUDGET`、`tools.ts`）を
 * 超えたらそこで終わる。** 押し出された終端を辿る手段がここまで無く、
 * 台帳が膨らむほど「絞った先へ届かない」実害が大きくなる（396本のうち
 * 十数本しか出ず、絞った先へ届かなかった観測がある）。
 *
 * ## 群の順序は1バイトも変えない——`positionOf` を引数で受ける理由
 *
 * `manager_list` の並び（走行中・返事待ち → `lost` → その他の3群、各群の
 * 中は `startedAt` の新しい順）は #688 の実測（台帳10,000本で走行中が0件
 * しか出なかった）に基づく設計判断であり、**この cursor を足すために変えて
 * よいものではない。**
 *
 * だから「3群に分ける」という判断そのものは、この関数の外（`tools.ts` の
 * `managerAttentionRank`）に置いたまま動かさない。`managerAttentionRank`
 * の既存 doc が逐語で言っているとおりである（当たる:
 * `grep -Fn -- '群の数はこの一覧の側の判断であって、' packages/core/src/tools.ts`）。
 * ⟹ `resolveManagerCursor` は群の分け方を1行も知らない——呼び出し側
 * （`tools.ts`）が `positionOf: (entry: ManagerSummary) => ManagerPosition`
 * を渡し、この関数はその結果を比較するだけである。
 *
 * **同時に、並び替えと cursor が同じ比較を使うことは構造で保証する。**
 * `tools.ts` の `compareManagerAttention` は `compareManagerPosition` の
 * 呼び出しへ書き換えてある——別々に書くと、片方だけがずれたときに黙って
 * 行が飛ぶ（同じ形の事故が `commitment_list` の `order`/`includeClosed` に
 * 実例として在る）。
 *
 * ## 錨は複合（`rank` / `startedAt` / `managerId`）
 *
 * `rank` と `startedAt` が同値の2本は、`compareManagerAttention`（旧実装）
 * では順序が決まらなかった（`0` を返す）。keyset で頁を繋ぐと、同値のまま
 * では**同じ行を繰り返すか、間の行を飛ばす**——だから `managerId` を同値の
 * 破れ役として足した。**これはふるまいの変更である**：群の順序と
 * `startedAt` 降順は1バイトも変えていないが、**同値だったときの順序だけを
 * 新しく決めた**（keyset を繋ぐために必要な最小限の変更）。
 *
 * ## cursor は `status` を持つ（錨は刷られた一覧の中でしか意味を持たない）
 *
 * 錨（`rank`/`startedAt`/`managerId`）は「刷られた一覧」の中でしか意味を
 * 持たない——`status` で絞った一覧から出た錨を、別の絞りの一覧へそのまま
 * 繋ぐと、同じ行を繰り返すか間を飛ばす。`commitment-cursor.ts` が
 * `includeClosed` の食い違いを 400 相当で断っているのと同じ理由である
 * （逐語で当たる: `grep -Fn -- '錨は刷られた一覧の中でしか意味を持たないので、' packages/core/src/commitment-cursor.ts`）。
 * ⟹ `status` が食い違えば `status-mismatch` を返す。**黙ってどちらかへは
 * 倒さない。**
 *
 * ### 正規化: `manager_list` は `status: []` を「絞らない」へ倒す
 *
 * `tools.ts` の `manager_list` は `status` が未指定、または空配列のときに
 * 絞らない（`filtering = status !== undefined && status.length > 0`）——
 * この面の他の一覧（`journal_read` の `types`、`commitment_list` の
 * `origin`）とは逆の倒し方である（理由は `tools.ts` の `view` の doc に
 * 在る）。cursor の `status` 欄もこれに揃える: **絞っていない（未指定また
 * は `[]`）ときは `null`、絞っているときは `[...status].sort()`**
 * （{@link normalizeManagerCursorStatus}）。ソートするのは、呼び手が渡す
 * 配列の順序（`["running","waiting_human"]` と
 * `["waiting_human","running"]`）で意味の同じ絞りが別の cursor として
 * 食い違い扱いにならないようにするためである。
 *
 * ### `.default()` は使わない——ただし将来欄を足すときは要注意
 *
 * いまは新規の欄なので、既に発行済みの cursor と衝突する心配は無い
 * （`commitment-cursor.ts` の `order` 欄が `.default()` を使う理由とは
 * 前提が違う）。**将来ここへ欄を1つ足すときは、`commitment-cursor.ts` の
 * その doc を読むこと**（欄を無条件の必須にすると、足す前に発行済みの
 * cursor が一斉に malformed へ化ける——逐語で当たる:
 * `grep -Fn -- "z.enum(['oldest', 'newest']).default('oldest')\` にすること。" packages/core/src/commitment-cursor.ts`）。
 *
 * ## 実在検査はしない。ただし片道とは言い切らない
 *
 * `resolveManagerCursor` は比較（keyset）で辿る——錨が指していた委譲が
 * 別の群へ移っていても（`running` → `done`）続きは決まる。
 * `commitment-cursor.ts` はこの性質を「錨が指していた行が別の段へ移って
 * いても続きは正しく決まる」と書いているが、**あちらの2段（open→closed）
 * は片道**である。**こちらは往復しうる**——`running`/`waiting_human`
 * （rank 0）→ 終端（rank 2）は一方向だが、`lost`（rank 1）は「前の
 * セッションへ戻れなかった」という観測が立つだけの状態で、そこへ至る前後
 * 関係や、そこから先に status が動くかどうかを**ここでは確かめていない**。
 * ⟹ 「片道である」とは言い切らない——群が動くと、同じ行が再び窓に入るか
 * 間が飛ぶことは起こりうる。
 *
 * ## `index.ts` へ export しない
 *
 * `commitment-cursor.ts` / `approval-cursor.ts` が公開 API に出ているのは
 * `apps/daemon` の HTTP 側に対応する口（同じ契約を2箇所で実装している）が
 * 在るからである。HTTP 側の `GET /managers` には既に別の錨
 * （`apps/daemon/src/app.ts` の `compareManagerPagingKey`）が在るが、
 * **これはこの cursor の対応物ではない**——3群（走行中・返事待ち →
 * `lost` → その他）という並びそのものが `manager_list`（MCP 側）だけの
 * 判断で、HTTP 側は持たない。対応物が無い以上、出す先が無い export を
 * 足さない（#661 と同じ理由）。
 */
export interface ManagerPosition {
  rank: 0 | 1 | 2;
  /** `ManagerSummary.startedAt`（降順で比較する）。 */
  startedAt: string;
  managerId: string;
}

/**
 * `manager_list` の並び順そのもの。**rank 昇順 → `startedAt` 降順 →
 * `managerId` 昇順**（最後だけが今回の追加——上の doc「錨は複合」を参照）。
 *
 * `tools.ts` の `compareManagerAttention` はこの関数を呼ぶだけの薄い
 * ラッパーになっている——並び替えと cursor が別々の比較を持つと、片方だけ
 * がずれたときに黙って行が飛ぶ（上の doc「同時に、並び替えと cursor が
 * 同じ比較を使う」）。
 */
export function compareManagerPosition(a: ManagerPosition, b: ManagerPosition): number {
  if (a.rank !== b.rank) return a.rank - b.rank;
  if (a.startedAt !== b.startedAt) return a.startedAt < b.startedAt ? 1 : -1;
  if (a.managerId !== b.managerId) return a.managerId < b.managerId ? -1 : 1;
  return 0;
}

const managerCursorSchema = z.object({
  rank: z.union([z.literal(0), z.literal(1), z.literal(2)]),
  startedAt: z.string().min(1),
  managerId: z.string().min(1),
  /** 絞っていなければ `null`。絞っていれば正規化済み（ソート済み）の配列。 */
  status: z.array(jobStatusSchema).nullable(),
});

export type ManagerCursor = z.infer<typeof managerCursorSchema>;

/**
 * `status` を cursor の錨が持つ形へ正規化する。
 *
 * **未指定・空配列はどちらも「絞らない」＝ `null`。** `manager_list` の
 * 契約（`status: []` は絞らないへ倒す。上の doc「正規化」を参照）に揃えて
 * ある。絞っているときは `[...status].sort()`——渡す順序の違いを cursor の
 * 食い違いにしないため。
 */
export function normalizeManagerCursorStatus(
  status: readonly JobStatus[] | undefined,
): readonly JobStatus[] | null {
  if (status === undefined || status.length === 0) return null;
  return [...status].sort();
}

function sameStatusFilter(a: readonly JobStatus[] | null, b: readonly JobStatus[] | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.length !== b.length) return false;
  const as = [...a].sort();
  const bs = [...b].sort();
  return as.every((value, index) => value === bs[index]);
}

/** カーソルを不透明な文字列へ符号化する。呼び手は中身の構造を知らなくてよい。 */
export function encodeManagerCursor(cursor: ManagerCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

export type DecodeManagerCursorResult = { ok: true; cursor: ManagerCursor } | { ok: false };

/**
 * カーソルを decode する。**壊れていれば（base64/JSON として読めない、また
 * は schema に合わない）`{ ok: false }`。** 実在検査はしない——
 * `resolveManagerCursor` が比較（keyset）で辿るので、錨が指していた委譲が
 * 別の群へ移っていても続きは決まる（上の doc「実在検査はしない」）。
 */
export function decodeManagerCursor(raw: string): DecodeManagerCursorResult {
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    return { ok: false };
  }
  const parsed = managerCursorSchema.safeParse(json);
  if (!parsed.success) return { ok: false };
  return { ok: true, cursor: parsed.data };
}

/**
 * `cursor` を受け取り、`entries`（呼び出し側が `status` で絞った後・
 * `positionOf` の並びで既に整列済みのもの）から、その位置より後ろだけを
 * 残す。**純関数。I/O を持たない**（`ManagerSummary[]` の配列を渡すだけで
 * 呼べる——`manager-cursor.test.ts` はストアを1つも作らずにこれを直接叩く）。
 *
 * **`positionOf` を引数で受ける。** 群の分け方（3群にするという判断）は
 * この一覧（`tools.ts`）の側の判断であって、この関数の判断ではない（上の
 * doc「群の順序は1バイトも変えない」を参照）。
 *
 * - `cursorRaw` が `undefined`: 絞らない（先頭から）。`{ kind: 'ok', view:
 *   [...entries] }`
 * - decode できない: `{ kind: 'malformed' }`——黙って先頭からへは倒さない
 * - `status` が食い違う: `{ kind: 'status-mismatch', cursorStatus }`——
 *   黙ってどちらかへは倒さない（上の doc「cursor は status を持つ」）
 * - それ以外: `{ kind: 'ok', view }`。`view` は0件のこともある（カーソルが
 *   一覧の末尾を指していた＝最後の頁）——正常な終端であってエラーではない
 */
export function resolveManagerCursor(
  entries: readonly ManagerSummary[],
  positionOf: (entry: ManagerSummary) => ManagerPosition,
  statusFilter: readonly JobStatus[] | null,
  cursorRaw: string | undefined,
):
  | { kind: 'ok'; view: ManagerSummary[] }
  | { kind: 'malformed' }
  | { kind: 'status-mismatch'; cursorStatus: readonly JobStatus[] | null } {
  if (cursorRaw === undefined) return { kind: 'ok', view: [...entries] };
  const decoded = decodeManagerCursor(cursorRaw);
  if (!decoded.ok) return { kind: 'malformed' };
  if (!sameStatusFilter(decoded.cursor.status, statusFilter)) {
    return { kind: 'status-mismatch', cursorStatus: decoded.cursor.status };
  }
  const pivot: ManagerPosition = decoded.cursor;
  const view = entries.filter((entry) => compareManagerPosition(positionOf(entry), pivot) > 0);
  return { kind: 'ok', view };
}
