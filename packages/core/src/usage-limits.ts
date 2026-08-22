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

function startsWithAny(text: string, prefixes: readonly string[]): boolean {
  const trimmed = text.trimStart();
  return prefixes.some((prefix) => trimmed.startsWith(prefix) || trimmed.includes(prefix));
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
