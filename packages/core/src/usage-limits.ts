import {
  ORG_POLICY_LIMIT_PREFIXES,
  USAGE_LIMIT_ERROR_PREFIXES,
  USAGE_TRANSITION_PREFIXES,
  USAGE_WARNING_PREFIXES,
} from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

/**
 * 「上限に当たった / 当たりそう」の検知。
 *
 * **文言のパターンを自前で書かない。** SDK が定数でエクスポートしている
 * （`USAGE_LIMIT_ERROR_PREFIXES` ほか）。文言は将来変わるので、手で書いた正規表現は
 * 必ず腐る — しかも腐り方が「検知しなくなる」なので、静かに効かなくなる。
 *
 * これらの定数は SDK 側で `@alpha` である。**消えたら型エラーで落ちる形にしてある**
 * （import しているだけ）ので、気づけないまま無効になることはない。
 *
 * ## なぜこれが要るのか
 *
 * 実際に支出上限へ当たったとき、走行中のマネージャーが2本同時に
 * `You've hit your individual spend limit` を返して終わった。上の1つめの定数の
 * 先頭が `"You've hit your"` で、まさにこれである。当たったこと自体は
 * 「結果なしで終了」として観測できていたが、**なぜ終わったのかが分からなかった。**
 *
 * さらに SDK は「当たる一歩前」も持っている。
 *
 * - {@link USAGE_WARNING_PREFIXES}（`You've used` / `You're close to`）= 接近警告
 * - {@link USAGE_TRANSITION_PREFIXES}（`You're now using extra usage` 等）
 *   = **枠を使い切って課金枠に移った瞬間**
 *
 * 後者がこの依頼の核心に一番近い。**支出上限の残額が取れなくても、この遷移を
 * 捉えられれば「そろそろ止まる」と判断できる。** どちらも API エラーとしては来ない
 * （SDK のコメント）ので、`system/notification` と `system/informational` を見る。
 */

/**
 * 何が起きたか。
 *
 * - `reached`: もう通らない。仕事は止まっている
 * - `transition`: 枠を使い切って課金枠（extra usage）に移った。**まだ動くが、次は止まる**
 * - `warning`: 上限に近い
 * - `org_policy`: 上限ではなく組織の方針で止められている（**上限と混ぜないこと**。
 *   待っても直らないし、増やす先も違う）
 */
export const usageLimitKindSchema = z.enum(['reached', 'transition', 'warning', 'org_policy']);

export type UsageLimitKind = z.infer<typeof usageLimitKindSchema>;

export const usageLimitNoticeSchema = z.object({
  kind: usageLimitKindSchema,
  /** SDK が出した文言そのまま。**言い換えないこと**（人間が検索できる形で残す）。 */
  text: z.string(),
});

export type UsageLimitNotice = z.infer<typeof usageLimitNoticeSchema>;

/**
 * 当てはまった接頭辞のうち**いちばん長いもの**を返す。当てはまらなければ `undefined`。
 *
 * **長いほうを採るのは、短い接頭辞が長い接頭辞を食うからである。** SDK の
 * {@link USAGE_LIMIT_ERROR_PREFIXES} には `"Your seat type doesn't include usage"` と
 * `"Your seat type doesn't include usage credits"` の両方が在り、前者は後者の
 * 接頭辞である。配列の順で最初に当たったものを採ると、**どちらの文言でも短い側が
 * 当たる** — 判定を接頭辞ごとに分けている側（{@link limitRecoveryOf}）では、それが
 * そのまま別の判定になる。
 *
 * 一致の規則（`startsWith` または `includes`）は {@link startsWithAny} と共有する
 * ——あちらがこれを呼ぶ形にしてあるので、片方だけ規則が動くことがない。
 *
 * ## ⚠️ export してあるのは、SDK の配列の並び順に依存せずに測るためである
 *
 * **いまの {@link USAGE_LIMIT_ERROR_PREFIXES} の並び順では、この規則を壊しても
 * 答えが変わらない。** 長いほう（`"…include usage credits"`）が配列で先に在るので、
 * 「最初に当たったものを採る」に取り違えても同じ値が返る——**変異試験で実測した
 * （その変異は生き残った）。**
 *
 * ⟹ **{@link matchedUsageLimitPrefix} 経由では測れない。** 並び順を自分で決められる
 * 形で呼べないと、この規則を守っている歯が1本も無いことになる（AGENTS.md
 * 「テストが書けない構造は、テストが無いのと同じ」）。だから引数で配列を受ける形の
 * まま export してある。
 *
 * **次に読む人へ: これは「内部の関数がうっかり漏れている」のではない。** 畳むと、
 * SDK が並び順を変えた瞬間に静かに壊れる側へ戻る。
 */
export function longestMatchingPrefix(
  text: string,
  prefixes: readonly string[],
): string | undefined {
  const trimmed = text.trimStart();
  let best: string | undefined;
  for (const prefix of prefixes) {
    if (!trimmed.startsWith(prefix) && !trimmed.includes(prefix)) continue;
    if (best === undefined || prefix.length > best.length) best = prefix;
  }
  return best;
}

function startsWithAny(text: string, prefixes: readonly string[]): boolean {
  return longestMatchingPrefix(text, prefixes) !== undefined;
}

/**
 * 文言を分類する。当てはまらなければ `undefined`。
 *
 * **順序に意味がある。** `reached`（もう通らない）を最優先に見る。接近警告と遷移の
 * 文言は前方一致の範囲が重なりうるので、重い側から判定しないと「止まっているのに
 * 警告として扱う」になる。組織方針は SDK 自身が「上限のカードへ回すな」と言って
 * いるので独立に見る。
 */
export function classifyUsageNotice(text: string): UsageLimitNotice | undefined {
  if (text.trim().length === 0) return undefined;
  if (startsWithAny(text, ORG_POLICY_LIMIT_PREFIXES)) return { kind: 'org_policy', text };
  if (startsWithAny(text, USAGE_LIMIT_ERROR_PREFIXES)) return { kind: 'reached', text };
  if (startsWithAny(text, USAGE_TRANSITION_PREFIXES)) return { kind: 'transition', text };
  if (startsWithAny(text, USAGE_WARNING_PREFIXES)) return { kind: 'warning', text };
  return undefined;
}

/**
 * クローンへ何と伝えるか。
 *
 * **「どうすべきか」は書かない。** 材料だけ渡して判断はクローンに残す
 * （`digest.ts` と同じ約束）。ただし**何が起きたのかは省略しない** — 「上限」だけ
 * では、待てば直るのか、人間に頼むのか、別の層へ回すのかが決まらない。
 */
export function describeUsageNotice(notice: UsageLimitNotice): string {
  const head =
    notice.kind === 'reached'
      ? '利用上限に当たった。この文言で仕事が止まっている'
      : notice.kind === 'transition'
        ? '枠を使い切って課金枠（extra usage）に移った。**まだ動くが、この先で止まる**'
        : notice.kind === 'warning'
          ? '利用上限に近づいている'
          : '組織の方針で止められている（利用上限ではないので、待っても増やしても直らない）';
  return `${head}: ${notice.text}`;
}

// ---------------------------------------------------------------------------
// 待てば戻るのか、人間が動かないと戻らないのか（Issue #393）
// ---------------------------------------------------------------------------

/**
 * 止まった原因が、**時間の経過だけで戻るか**。
 *
 * `kind`（{@link UsageLimitKind}）とは別の軸である。`reached` は「いま通らない」
 * しか言わず、**戻るかどうかを言わない** — 同じ `reached` の中に、リセットを待てば
 * 戻るものと、人間が入金や管理者への依頼をしないと永久に戻らないものが混ざっている。
 *
 * - `time`: リセット（5時間 / 週 / 請求期間）を待てば戻る
 * - `action`: 人間が動かないと戻らない（入金・管理者の設定・座席種別の変更）
 * - `unknown`: どちらとも言えない。**`action` の同義語ではない**（下記）
 *
 * ## `unknown` を「捨てる」側へ倒さないこと
 *
 * この値の消費者（Issue #393 PR3 の回し手）にとって、`action` と読むことは
 * **候補を1本永久に降ろす**判断になりうる。`time` と読み違えたときの代償は
 * 「冷却が明けてもう一度試して、また駄目で冷やし直す」だけで済むが、逆向きの
 * 読み違えは**まだ戻るトークンを捨てる。** ⟹ 迷ったら `time` 側、少なくとも
 * `unknown` へ倒し、`unknown` を `action` と同じ扱いにしない。
 *
 * ## ⚠️ 次に読む人へ: 散文より良い材料が既に来ている
 *
 * {@link RateLimitFacts.overageDisabledReason} は、SDK が**閉じた union として
 * 型宣言している構造化された値**である（実測 2026-08-25 観測、
 * `@anthropic-ai/claude-agent-sdk@0.3.241` の `sdk.d.ts`。逐語は
 * 「overageDisabledReason?: 'overage_not_provisioned'」 [sdk-verbatim SDKRateLimitInfo.overageDisabledReason] で始まる行。同じ構造は 0.3.261 でも変わらない）。
 * `org_level_disabled_until` のように、**時間の含みが値の名前に出ているもの**まで
 * 在る。
 *
 * **⟹ 回復の見込みを見るなら、散文の接頭辞より先にそちらを見るべきである。**
 * ここが文言を見ているのは、`classifyUsageNotice` が文言しか持たない経路
 * （`system/notification` / 失敗した `result`）からも呼べるようにするためであって、
 * **文言のほうが良い材料だからではない。**
 *
 * ただし `overageDisabledReason` が答えるのは「課金枠が使えない理由」だけで、
 * 枠そのものの状態ではない。**片方だけで足りる、とも読まないこと。**
 */
export const limitRecoverySchema = z.enum(['time', 'action', 'unknown']);
export type LimitRecovery = z.infer<typeof limitRecoverySchema>;

/**
 * `"You've hit your"` / `"You've reached your"` に当たったときだけ、続けて
 * **全文**を見て細分する（{@link LIMIT_RECOVERY_BY_PREFIX} のこの2つの鍵から
 * 呼ばれる）。
 *
 * ## なぜ表の1行では足りないのか
 *
 * この2つは SDK の {@link USAGE_LIMIT_ERROR_PREFIXES} の中でいちばん粗い
 * 接頭辞で、**中身の違う文言がまとめて1つの鍵に落ちる**。実際に当たった実害
 * （2026-09-10 朝）がそれである——`You've hit your individual spend limit ·
 * ask your admin to raise it` は「人間が上限を上げるまで開かない壁」なのに、
 * 表がこの接頭辞1本を `time` に固定していたせいで「待てば戻る」と読み違えられ、
 * 9時間が失われた。**この関数は、表の鍵1本の粒度では表現できない分岐を
 * 鍵の中でもう一段見るために在る。**
 *
 * ## ⚠️ この判定も書き手の判定であって、Anthropic 側の仕様の主張ではない
 *
 * 例外は次の2つで、どちらも人間の実測である。
 *
 * - `individual spend limit` → `action`: **今回の実害の実測**（2026-09-10）。
 *   文言自身が「管理者に上げてもらえ」と言っており、`action` の定義
 *   （入金・管理者の設定・座席種別の変更が要る）に一致する
 * - `org's monthly spend limit` → `time`: **人間の実測**（2026-08-25 JST 報告）。
 *   無料枠を使い切って従量課金へ切り替わったときに組織の課金上限へ達して
 *   出るもので、請求期間が変われば戻る。**これは陰性対照でもある**——下の
 *   individual spend limit の分岐がこの文言を巻き込んで動かしていないことを
 *   変異試験で確かめる
 *
 * `resets` を含む形（`· resets 3:50pm (Asia/Tokyo)` / `· resets at 5pm`）は
 * **戻る時刻が本文に書いてあることそのものが `time` の直接の証拠**なので
 * `time` にする。**時刻の抽出は `usage-reset-text.ts` が既に持っている
 * （`parseNoticeResetAt`）ので、ここでは新設しない**——ただしここが要るのは
 * 「時刻が書いてあるか」の存在確認だけで、`parseNoticeResetAt` は
 * 「読める形か」（帯が要る）まで求めるので流用できない。`resets at 5pm`
 * （帯が無い）は `parseNoticeResetAt` では読めないが、それでも「戻る時刻が
 * 書いてある」という証拠としての価値は帯の有無で変わらない。
 *
 * **それ以外（誰も分類していない変種）は `unknown` へ倒す。** 今朝の実害は
 * まさに「粗い既定値が黙って `time` を名乗る」形だったので、ここでも同じ形を
 * 繰り返さない。`unknown` を `action` の同義語にもしない
 * （{@link LimitRecovery} の doc「読み違えの代償が非対称」）。
 *
 * ## `"You've reached your"` にも同じ細分を当てる理由
 *
 * SDK の doc コメントは2つを「同じ族の文言（`getLimitReachedText` の出力）」
 * と言っている。**`individual spend limit` 相当の言い回しが `reached` 側にも
 * 将来現れないという保証は無い**——現れたときに `time` へ黙って落ちる同じ
 * 欠陥を残さないため、細分は両方の鍵で共有する。
 */
function refineHitYourFamilyRecovery(text: string): LimitRecovery {
  if (text.includes('individual spend limit')) return 'action';
  if (text.includes("org's monthly spend limit")) return 'time';
  if (/\bresets\b/i.test(text)) return 'time';
  return 'unknown';
}

/**
 * {@link USAGE_LIMIT_ERROR_PREFIXES} の1本ごとの見込み。
 *
 * **⚠️ この表の判定は書き手の判定であって、Anthropic 側の仕様の主張ではない。**
 * 例外は {@link refineHitYourFamilyRecovery} の doc に書いた2件で、それは
 * 人間の実測である。他の10行は文言の読みから当てたもので、**確認していない。**
 *
 * ## なぜ SDK の文字列をここへ書き写しているのか
 *
 * 検知そのものは今までどおり SDK の定数がやる（`classifyUsageNotice`）。ここで
 * 要るのは**接頭辞ごとに違う注記**で、それを付けるには鍵として接頭辞そのものを
 * 書くしかない。⟹ **書き写しは避けられないので、腐ったら赤くなる形にしてある**
 * ——`usage-limits.test.ts` が「この表の鍵の集合と SDK の配列の集合が完全に一致
 * すること」を両方向で見るので、SDK が1つ足しても1つ改名しても落ちる。
 *
 * **実行時の倒れ先は `unknown`** である（{@link limitRecoveryOf}）。型でもテストでも
 * 捕まえるが、それでも本番で当たったときに候補を捨てない側へ倒す。
 *
 * ## `"You've hit your"` / `"You've reached your"` は値ではなく関数を持つ
 *
 * **この2つは SDK でいちばん粗い接頭辞**で、1つの鍵に中身の違う文言がまとめて
 * 落ちる（今回の実害がそれ）。⟹ 値の代わりに {@link refineHitYourFamilyRecovery}
 * を置き、当たった鍵がこの2つのときだけ全文を見て細分する。**表の鍵の集合は
 * 依然として SDK の12件と一致する**——変えたのは値の型（`LimitRecovery` →
 * `LimitRecovery | (text) => LimitRecovery`）であって、鍵ではない。
 *
 * ## `unknown` にした3本
 *
 * クレジット（credits）が「買うもの」なのか「期間ごとに配られるもの」なのかを、
 * こちらは知らない。**プランによって両方ありうる**と読んでいるので、当てずに
 * `unknown` にしてある——`action` と書けば、実際には月初に戻るトークンを捨てる。
 */
type RecoveryRule = LimitRecovery | ((text: string) => LimitRecovery);

const LIMIT_RECOVERY_BY_PREFIX = new Map<string, RecoveryRule>([
  // 粗すぎる接頭辞——全文を見て細分する（上の doc）。
  ["You've hit your", refineHitYourFamilyRecovery],
  ["You've reached your", refineHitYourFamilyRecovery],
  // 人間が動かないと戻らない（入金 / 管理者 / 座席種別）
  ['Your org is out of usage · add funds to continue', 'action'],
  ['Your org is out of usage · contact your admin', 'action'],
  ["Your seat type doesn't include usage credits", 'action'],
  ["Your seat type doesn't include usage", 'action'],
  ['Your usage allocation has been disabled by your admin', 'action'],
  ["Your group's usage limit is set to $0", 'action'],
  ["Your seat type doesn't include extra usage", 'action'],
  // クレジットが買うものか配られるものかを知らない
  ["You're out of usage credits", 'unknown'],
  ['Fable 5 requires usage credits', 'unknown'],
  ["You're out of extra usage", 'unknown'],
]);

/** テストが SDK の配列と突き合わせるための、この表の鍵の一覧。 */
export function knownLimitRecoveryPrefixes(): string[] {
  return [...LIMIT_RECOVERY_BY_PREFIX.keys()];
}

/**
 * その文言が {@link USAGE_LIMIT_ERROR_PREFIXES} のどれに当たったか（いちばん長い
 * 一致）。当たらなければ `undefined`。
 *
 * **{@link limitRecoveryOf} から切り出してある。挙動は1文字も変えていない**
 * ——あちらはこの関数の返り値を表の鍵として引くだけである。
 *
 * **切り出した理由は、そうしないと「どの鍵に当たったか」を測れないことである。**
 * `longestMatchingPrefix` の取り違え（短い側を採る）は、いま表の上では
 * `"Your seat type doesn't include usage"` と `"…usage credits"` が同じ注記を
 * 持つので、**`limitRecoveryOf` の返り値だけを見ても現れない。** 返り値で測る
 * 形にすると、その歯は「両方 `action` である」ことしか確かめていないことになる
 * （AGENTS.md「テストが書けない構造は、テストが無いのと同じ」）。
 *
 * **次に読む人へ: これは無駄な間接層ではない。** 潰すと、長短の取り違えを
 * 捕まえている歯がそのまま無力化する。
 */
export function matchedUsageLimitPrefix(text: string): string | undefined {
  return longestMatchingPrefix(text, USAGE_LIMIT_ERROR_PREFIXES);
}

/**
 * 文言から回復の見込みを読む。**当てはまらなければ `unknown`。**
 *
 * `classifyUsageNotice` と**同じ順序で見る**——組織方針を先に見る。SDK 自身が
 * 「上限のカードへ回すな」と言っているものであり、待っても直らない
 * （`ORG_POLICY_LIMIT_PREFIXES` の doc: 「This service is disabled for your org」 [sdk-verbatim ORG_POLICY_LIMIT_PREFIXES]）。
 *
 * **接近警告（`warning`）と課金枠への遷移（`transition`）は、ここへ来ても
 * `unknown` になる。** どちらも「まだ動いている」状態で、回復の見込みを問う対象
 * ではない——問われたときに `time` と答えると「止まっていて、待てば戻る」と読める。
 */
export function limitRecoveryOf(text: string): LimitRecovery {
  if (longestMatchingPrefix(text, ORG_POLICY_LIMIT_PREFIXES) !== undefined) return 'action';
  const prefix = matchedUsageLimitPrefix(text);
  if (prefix === undefined) return 'unknown';
  const rule = LIMIT_RECOVERY_BY_PREFIX.get(prefix);
  if (rule === undefined) return 'unknown';
  // 表の値は `LimitRecovery` そのものか、全文を見て細分する関数かのどちらか
  // （上の {@link LIMIT_RECOVERY_BY_PREFIX} の doc）。**渡すのは matched した
  // 接頭辞ではなく、元の `text` である**——細分が見るのは接頭辞より後ろの
  // 部分（`individual spend limit` 等）だからである。
  return typeof rule === 'function' ? rule(text) : rule;
}

/**
 * {@link limitRecoveryOf} の判定を、人が読む文言へ**添える**（Issue #393 の
 * 判定を、初めてクローンの受信箱・`manager_list` / `manager_report` の ⚠ 行へ
 * 運ぶ経路。PR #718 の作法を踏襲する）。
 *
 * **`base` は1文字も変えない。** 末尾に改行1本と1行を足すだけで、既存の文言
 * （`describeUsageNotice` の定型文・SDK の生 prose・`describeManagerFailure`
 * の ⚠ 行）はそのまま残す——`runner-protocol.ts` の「`reason` の文字列を
 * 解釈して分類し直さないこと」と同じ理由で、判定結果は元の文言を書き換える
 * のではなく別の行として運ぶ。
 *
 * **`unknown` のときは何も足さない。** `limitRecoveryOf` が実際に `time` /
 * `action` を返すのは `reached`（`kind`）系の文言と組織方針の一部だけで、
 * `transition` / `warning` はここへ来ても構造的に `unknown` になる
 * （{@link limitRecoveryOf} の doc）。⟹ 毎回「不明」の1行を足すと、
 * 大半の合図に読む価値の無いノイズが増えるだけになる。**分かったときにだけ
 * 出す**——このリポジトリが繰り返し選んでいる「取れない軸に0の行を作らない」
 * （AGENTS.md 地雷表）と同じ向きの判断である。ここで書いているのは「どう
 * 運ぶか」だけで、`LIMIT_RECOVERY_BY_PREFIX` の分類の正誤は扱わない。
 */
export function withRecoveryNote(base: string, recovery: LimitRecovery): string {
  if (recovery === 'unknown') return base;
  const label = recovery === 'time' ? '時間で戻る（time）' : '人間が動かないと戻らない（action）';
  return `${base}\n（回復の見込み: ${label}）`;
}

// ---------------------------------------------------------------------------
// rate_limit_event（枠の権威ある情報。ターン中だけ届く）
// ---------------------------------------------------------------------------

/**
 * `rate_limit_event.rate_limit_info` から拾う事実。
 *
 * codiva が使っている4フィールド（`status` / `resetsAt` / `rateLimitType` / `utilization`）
 * だけでなく、**なぜ課金枠が使えないのか**まで載っている。上限に当たったとき、
 * 文言からは `individual` なのか組織なのかを推測するしかなかったので、ここは残す。
 */
export const rateLimitFactsSchema = z.object({
  kind: z.string().optional(),
  status: z.enum(['allowed', 'allowed_warning', 'rejected']).optional(),
  /** 使用率（0〜100）。**付かないことがある**（`five_hour` で実測）。 */
  utilization: z.number().nonnegative().optional(),
  /** epoch ミリ秒（元は Unix 秒）。 */
  resetsAt: z.number().int().positive().optional(),
  overageStatus: z.enum(['allowed', 'allowed_warning', 'rejected']).optional(),
  overageResetsAt: z.number().int().positive().optional(),
  /**
   * 課金枠が使えない理由。`out_of_credits` / `member_zero_credit_limit` /
   * `member_level_disabled` / `org_level_disabled` など。
   *
   * **記録する価値がある。** 「当たった」しか分からないと、次に当たったときも
   * 同じところで推測することになる。
   */
  overageDisabledReason: z.string().optional(),
  /** いま課金枠から引いているか。**「そろそろ止まる」の一番はっきりした合図。** */
  usingOverage: z.boolean().optional(),
  /** クレジットが要る状態（`credits_required`）。 */
  errorCode: z.string().optional(),
});

export type RateLimitFacts = z.infer<typeof rateLimitFactsSchema>;

const STATUSES = ['allowed', 'allowed_warning', 'rejected'] as const;

function toStatus(value: unknown): (typeof STATUSES)[number] | undefined {
  return typeof value === 'string' && (STATUSES as readonly string[]).includes(value)
    ? (value as (typeof STATUSES)[number])
    : undefined;
}

/**
 * Unix 秒 → epoch ミリ秒。読めなければ undefined。
 *
 * **`/usage` 側は ISO 8601 文字列で単位が違う。** 混ぜると必ず事故るので、
 * どちらも epoch ミリ秒へ寄せてから外へ出す。
 */
function toEpochMs(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined;
  return value > 1e11 ? Math.floor(value) : Math.floor(value * 1000);
}

/** `rate_limit_info` を正規化する。**投げない**（観測であって仕事ではない）。 */
export function toRateLimitFacts(value: unknown): RateLimitFacts | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  const facts: RateLimitFacts = {
    kind: typeof raw.rateLimitType === 'string' ? raw.rateLimitType : undefined,
    status: toStatus(raw.status),
    utilization:
      typeof raw.utilization === 'number' &&
      Number.isFinite(raw.utilization) &&
      raw.utilization >= 0
        ? raw.utilization
        : undefined,
    resetsAt: toEpochMs(raw.resetsAt),
    overageStatus: toStatus(raw.overageStatus),
    overageResetsAt: toEpochMs(raw.overageResetsAt),
    overageDisabledReason:
      typeof raw.overageDisabledReason === 'string' ? raw.overageDisabledReason : undefined,
    usingOverage:
      typeof raw.isUsingOverage === 'boolean'
        ? raw.isUsingOverage
        : typeof raw.overageInUse === 'boolean'
          ? raw.overageInUse
          : undefined,
    errorCode: typeof raw.errorCode === 'string' ? raw.errorCode : undefined,
  };
  // 何も読めなかったものは無いものとして扱う（空の行を作らない）。
  return Object.values(facts).some((v) => v !== undefined) ? facts : undefined;
}

/**
 * 覚えている事実へ、新しい観測を**重ねる**（置き換えない）。
 *
 * **なぜ置き換えてはいけないか。** {@link RateLimitFacts} は全フィールドが省略可で、
 * {@link toRateLimitFacts} は「1つでも読めた」時点で値を返す。つまり `status` を
 * 運んでいない観測が**正常な入力として**この経路を通る。覚える側が丸ごと置き換える
 * 形だと、その1件が「もう `rejected` を知らせた」という記憶
 * （{@link usageTransitionOf} が見る `previous.status`）を消してしまい、**次に届いた
 * 同じ `rejected` が新しい遷移として扱われる。** クローンには一字一句同じ知らせが
 * もう一度配られ、そのぶんターンが焼かれる（配達1本＝クローンのターン1回）。しかも
 * `rate_limit_event` はターンの頭ごとに来るので、これは1回では済まない。
 *
 * **省略は「無くなった」ではなく「何も言っていない」として扱う。** この経路には
 * 否定を表す形が無く（省略と否定がどちらも `undefined`）、区別する材料もここには
 * 無い。値が実際に変わったのなら、新しい観測がその値を運んでくる。
 *
 * **記憶が消える道は塞がない。** `status` が `'allowed'` で届けば `rejected` の
 * 記憶はそこで上書きされ、その後の `rejected` は新しい出来事としてもう一度
 * 知らされる。枠は実際に開いて閉じ直すので、ここまで塞ぐと**本物の再発が黙って
 * 消える** — 直そうとしている穴（同じ知らせの再配達）の裏返しを作らないこと。
 */
export function mergeRateLimitFacts(
  previous: RateLimitFacts | undefined,
  next: RateLimitFacts,
): RateLimitFacts {
  if (previous === undefined) return next;
  const merged: Record<string, unknown> = { ...previous };
  for (const [key, value] of Object.entries(next)) {
    if (value !== undefined) merged[key] = value;
  }
  return merged as RateLimitFacts;
}

/**
 * 前回と比べて、クローンへ知らせるべき変化が起きたか。
 *
 * 知らせるのは2つだけ。**課金枠へ入った瞬間**（`usingOverage` が偽→真）と、
 * **枠から追い返された瞬間**（`status` が `rejected` になった）。
 *
 * **毎ターン届く同じ事実で受信箱を埋めないこと。** `rate_limit_event` はターンの
 * 頭ごとに来るので、状態をそのまま流すとクローンは同じ通知を何十回も読むことに
 * なり、本当に変わった1回が埋もれる。
 */
export function usageTransitionOf(
  previous: RateLimitFacts | undefined,
  next: RateLimitFacts,
): 'entered_overage' | 'rejected' | undefined {
  if (next.status === 'rejected' && previous?.status !== 'rejected') return 'rejected';
  if (next.usingOverage === true && previous?.usingOverage !== true) return 'entered_overage';
  return undefined;
}
