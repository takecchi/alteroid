import { z } from 'zod';

import type { RunnerOverview } from './manager.js';

/**
 * `runner_list` の継続点（issue #662）。
 *
 * ## なぜ要るか
 *
 * 一覧が予算（`RUNNER_LIST_BUDGET`、`tools.ts`）で切れると、この道具は
 * **落ちた器を名指しする手を1つも持っていなかった。** 断り書きは逐語
 * （#662 以前）: `…ほか ${rest} 台は省略（登録は ${total} 台あり、${shown} 台だけ出した）。`
 * ——**台数を名乗るだけで、続きの取り方を書いていない。** 引数にも `cursor`
 * も `offset` も無かった。
 *
 * 🔴 **そしてこれは「器が無い」と同じである。** 落ちた器の `runnerId` は
 * この一覧以外のどこからも得られないので、クローンは `manager_start` の
 * `runnerId` にその器を名指しできない——⟹ 予算の外に出た器は、置き先の
 * 候補から恒久的に消える。**実測（120台の名簿）では 65 台しか出ず、55 台が
 * 落ちた。**
 *
 * ## 錨は `label` 単体
 *
 * `RunnerRegistry` の実体は **`label` を鍵にした `Map`** である（当たる:
 * `grep -Fn -- 'readonly #entries = new Map<string, RegistryEntry>();' packages/core/src/runner-protocol.ts`）。
 * ⟹ `label` は名簿の中で一意であり、`entries()` はその `Map` の値をその順の
 * まま返す。
 *
 * ⛔ **`runnerId` を錨にしないこと。** `runnerId` は器が名乗るまで
 * `undefined` である（`RunnerOverview.runnerId` は optional で、一覧は
 * 「runnerId は未確定。まだ名乗っていない」と出す枝を持つ）——**まだ名乗って
 * いない器が錨になった瞬間に継続点が組めなくなる。** `label` は登録の時点で
 * 必ず在る。
 *
 * ## ⭐ `memory_list` の「重複を許す」契約は、ここでは要らない
 *
 * `memory-cursor.ts` は**描く順（木の DFS）と錨の順（`slug` 昇順）が一致
 * しない**ため、落ちた分を拾うのに「ここから（含む）」を採り、重複を契約に
 * した（逐語で当たる:
 * `grep -Fn -- '欠落と重複が両立しないなら、欠落しない側へ倒す。' packages/core/src/memory-cursor.ts`）。
 *
 * **`runner_list` はそうではない。** `tools.ts` は `overview.runners` を
 * **配列の順のまま1台1ブロックで積む**（並べ替えも絞り込みも挟まない）ので、
 * **描く順と錨の順は同一の配列そのものである。** ⟹ `slice(index + 1)` が
 * 過不足なく続きになる——重複も欠落もしない。**自分で確かめたうえで、
 * ここには重複の契約を置いていない。**
 *
 * ## ⚠️ 第二の手段に「比較」が無い（`token-cursor.ts` と違う点）
 *
 * `token-cursor.ts` は錨の行が消えていたとき `order` の比較へ落ちる。
 * **ここにはその比較に当たる鍵が無い。** 並びは `Map` の挿入順（登録順）で
 * あって、`RunnerOverview` のどのフィールドからも導けない——`label` は一意
 * だが、名簿が `label` 順に並んでいるわけではない。
 *
 * ⟹ ⭐ **錨が消えていたら、先頭から出し直す**（{@link ResolvedRunnerCursor}
 * の `restarted`）。器が名簿から外れることは実際に起きる
 * （`RunnerRegistry.unregister(label)` が `#entries.delete(label)` する）。
 *
 * **これは「欠落より重複が安全側」の当然の帰結である。** 錨の位置が分からない
 * 以上、1台も落とさないと言い切れる出し方は「全部出し直す」しか無い。
 * ⛔ **黙って先頭へ倒さない**——`restarted` を呼び出し側へ返し、
 * `runner_list` はそれを応答に書く（**黙って重複させない**）。
 * ⛔ **適当な位置から再開して埋め合わせない**——それは黙って欠落させる側で
 * ある。
 *
 * **輪にはならない**: 出し直した頁の末尾は実在する器なので、次の cursor は
 * 必ず当たる。払うのは高々1頁の重複である。
 *
 * ## `index.ts` へ export しない
 *
 * `schedule-cursor.ts` / `token-cursor.ts` と同じ理由——`runner_list` には
 * カーソル付きの HTTP 対応物が無いので、**出す先が無い export を足さない**。
 */
const runnerCursorSchema = z.object({ label: z.string().min(1) });

export type RunnerCursor = z.infer<typeof runnerCursorSchema>;

/** カーソルを不透明な文字列へ符号化する。呼び手は中身の構造を知らなくてよい。 */
export function encodeRunnerCursor(cursor: RunnerCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

export type DecodeRunnerCursorResult = { ok: true; cursor: RunnerCursor } | { ok: false };

/**
 * カーソルを decode する。**壊れていれば（base64/JSON として読めない、または
 * schema に合わない）`{ ok: false }`。** 実在検査はしない——錨が消えていた
 * ことは {@link resolveRunnerCursor} が `restarted` として扱う（decode の
 * 失敗とは別の状態である。混ぜると「壊れた cursor」と「消えた器」が同じ
 * 文言に潰れ、疑う先が分からなくなる）。
 */
export function decodeRunnerCursor(raw: string): DecodeRunnerCursorResult {
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    return { ok: false };
  }
  const parsed = runnerCursorSchema.safeParse(json);
  if (!parsed.success) return { ok: false };
  return { ok: true, cursor: parsed.data };
}

/**
 * {@link resolveRunnerCursor} の結果。
 *
 * `restarted` は **「錨の器が名簿に居なかったので、先頭から出し直した」**。
 * ⚠️ **`view` が先頭からであることを、呼び出し側は黙って飲まないこと**——
 * クローンから見ると同じ器がもう一度出るので、**そうと言わなければ「進んで
 * いない」のか「出し直した」のかが区別できない。**
 */
export type ResolvedRunnerCursor =
  { kind: 'ok'; view: RunnerOverview[]; restarted: boolean } | { kind: 'malformed' };

/**
 * `cursor` を受け取り、`entries`（`RunnerFleetOverview.runners`。`tools.ts`
 * が描くのと同じ配列・同じ順）から、その錨より後ろだけを残す。**純関数。
 * I/O を持たない**（`RunnerOverview[]` を渡すだけで呼べる）。
 *
 * - `cursorRaw` が `undefined`: 絞らない（先頭から。`restarted` は false）
 * - decode できない: `{ kind: 'malformed' }`——**黙って先頭からへは倒さない**
 *   （倒すと、呼び手は「続きを読んだつもり」で同じ器を繰り返し読む）
 * - 錨が居た: その**次**から（`restarted` は false）。0件のこともある
 *   （＝最後の頁。正常な終端であってエラーではない）
 * - 錨が居ない: **先頭から全部**（`restarted` は true）。上の doc のとおり、
 *   1台も落とさないと言い切れる出し方がこれしか無いため
 */
export function resolveRunnerCursor(
  entries: readonly RunnerOverview[],
  cursorRaw: string | undefined,
): ResolvedRunnerCursor {
  if (cursorRaw === undefined) return { kind: 'ok', view: [...entries], restarted: false };
  const decoded = decodeRunnerCursor(cursorRaw);
  if (!decoded.ok) return { kind: 'malformed' };
  const index = entries.findIndex((entry) => entry.label === decoded.cursor.label);
  // 錨が居た: 描く順と錨の順が同一なので、次から切れば過不足なく続きになる。
  if (index !== -1) return { kind: 'ok', view: entries.slice(index + 1), restarted: false };
  // 錨が消えていた（`unregister` された等）。比較に使える鍵が無いので出し直す。
  return { kind: 'ok', view: [...entries], restarted: true };
}
