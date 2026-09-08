import { z } from 'zod';

import {
  describeProbeError,
  runUsageProbe,
  settleWithin,
  type UsageProbeFailure,
  type UsageProbeQuery,
} from './usage-probe.js';

/**
 * アカウント全体の利用状況（claude.ai 側が言っている値）。
 *
 * **台帳（`usage.ts`）とは別物である。足したり混ぜたりしないこと。** 台帳は
 * 「alteroid が使った分」を自分で数えた推定値で、こちらは「アカウントの枠を
 * どれだけ使ったか」を向こうが言っている値である。一致する保証はない。
 *
 * 出所は SDK の control channel で、口は2つ。
 *
 * - `Query.accountInfo()` — プラン名・組織・API バックエンド
 * - `Query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET()` —
 *   claude.ai の `/usage` スナップショット（枠の利用率と**支出上限**）
 *
 * ## 実測された落とし穴（すべて要件にしてある）
 *
 * 1. **`rate_limits_available: true` でも `rate_limits` が `null` のことがある**
 *    （Claude Team で再現）。だから `available` を「枠がある」の根拠にしない。
 *    さらに `false` のときは各フィールドが null になるのではなく
 *    **オブジェクトごと `null`** になる（未ログイン環境で実測）。
 * 2. **`utilization` が付かない枠がある**（`five_hour` で実測）。だから
 *    「% が無い枠」を 0% として描かない。**取れなかったものを 0 にしない。**
 * 3. **時刻の単位が2系統ある。** `/usage` は ISO 8601 文字列、`rate_limit_event` は
 *    Unix **秒**。混ぜると必ず事故るので、正規化した先（epoch ミリ秒）だけを持つ。
 * 4. **ターンを回した直後の実セッションで usage 要求を呼ぶと
 *    `ProcessTransport is not ready for writing` で失敗する。** alteroid の
 *    マネージャーは常にターンを回しているので、**相乗りせず使い捨ての probe を
 *    立てる**（`usage-probe.ts`）。
 *
 * ## 未実測のまま残っているもの
 *
 * **`extraUsage`（支出上限）の実物は観測できていない。** ログイン済みの claude.ai
 * サブスクリプションからしか `rate_limits` が埋まらず、CI もコンテナも未ログイン
 * だからである。型宣言どおりに読むところまでを実装し、**取れなければ「取れなかった」
 * と言う**形にしてある。持ち主が実測するためのスクリプトは
 * `packages/core/scripts/usage-probe.mjs`。実測できたらここを直す。
 */

/** 枠の種類。SDK の `rateLimitType` と `/usage` のキーを1つに寄せたもの。 */
export const usageWindowKindSchema = z.enum([
  'five_hour',
  'seven_day',
  'seven_day_opus',
  'seven_day_sonnet',
  'seven_day_overage_included',
  'overage',
]);

export type UsageWindowKind = z.infer<typeof usageWindowKindSchema>;

/**
 * 枠1つ。
 *
 * `utilization` と `resetsAt` が**どちらも省略可能**なのは、実測でどちらも欠ける
 * ことがあるからである。**欠けたものを 0 や「いま」で埋めないこと。**
 */
export const usageWindowSchema = z.object({
  kind: usageWindowKindSchema,
  /** 使用率（0〜100）。取れなかったときは undefined。**0 で埋めないこと。** */
  utilization: z.number().nonnegative().optional(),
  /** リセット時刻（epoch ミリ秒）。取れなかったときは undefined。 */
  resetsAt: z.number().int().positive().optional(),
  /** まだ通してもらえているか。`rate_limit_event` からしか分からない。 */
  status: z.enum(['allowed', 'allowed_warning', 'rejected']).optional(),
});

export type UsageWindow = z.infer<typeof usageWindowSchema>;

/**
 * 支出上限（extra usage / 課金枠）。**この依頼の核心。**
 *
 * 枠（`five_hour` 等）の利用率は「いま重い仕事を投げてよいか」の判断に効くが、
 * **支出上限は「今日もう委譲を続けられるか」の判断に効く。** 実際に当たったのは
 * こちらで、当たると走行中のマネージャーが返答を返さずに終わる。
 *
 * **単位は未実測である。** 型宣言は `used_credits` / `monthly_limit` が
 * `number | null`、`currency` が `string | null` としか言っていない。USD なのか
 * クレジットなのかは実測できていないので、**通貨が分からないときは金額として
 * 整形しない**（`$` を付けて嘘の単位を名乗らない）。
 */
export const extraUsageSchema = z.object({
  enabled: z.boolean(),
  /** 月額の上限。取れなかったときは undefined。 */
  monthlyLimit: z.number().nonnegative().optional(),
  /** 使った分。取れなかったときは undefined。 */
  usedCredits: z.number().nonnegative().optional(),
  /** 使用率（0〜100）。取れなかったときは undefined。 */
  utilization: z.number().nonnegative().optional(),
  /** 通貨コード。**これが無いときは金額として整形しないこと**（単位が分からない）。 */
  currency: z.string().optional(),
});

export type ExtraUsage = z.infer<typeof extraUsageSchema>;

/**
 * SDK が返しうる9値（`ApiKeySource`）＋ 10個目として足した `'unrecognized'`。
 *
 * ## なぜ値を絞るのか
 *
 * `AccountInfo.apiKeySource` は SDK 上 `string` としか宣言されておらず、doc
 * コメントを持たない（逐語。`@anthropic-ai/claude-agent-sdk@0.3.263` 同梱の
 * `sdk.d.ts`）。
 *
 * [sdk-verbatim AccountInfo.apiKeySource]
 * > apiKeySource?: string;
 *
 * doc を持つのは別の宣言（`SDKSystemMessage.apiKeySource`）が使う `ApiKeySource`
 * 型のほうである。
 *
 * [sdk-verbatim ApiKeySource]
 * > Where the credential used for API requests came from: 'ANTHROPIC_API_KEY' (environment variable), 'apiKeyHelper' (the configured helper command), '/login managed key' (an API key created and stored by /login with an Anthropic Console account), or 'none' (no API key in use - e.g. claude.ai OAuth login, a bearer token, or a third-party cloud provider). 'user' | 'project' | 'org' | 'temporary' | 'oauth' are legacy members that current CLIs never emit; they remain only so the type stays backward compatible.
 *
 * **⟹ `AccountInfo.apiKeySource` 自体には形の保証が無い。** そして
 * `AccountUsage` は `GET /usage` にそのまま載り、`GET /usage` は**アクセス
 * トークンで読める面**である（`/profile` だけが実行環境の持ち主に閉じている）。
 * ⟹ **素通しにすると、認証の出所の欄から鍵に関する自由文字列が外へ配られる側に
 * 出うる。** 知っている名前だけを通す。
 *
 * ## なぜ `'unrecognized'` が要るのか
 *
 * 「知らない値だった」と「そもそも欄が無かった（`undefined`）」は**別の観測**
 * である。素通しをやめた代償に前者を後者へ畳むと、**SDK が新しい値を出し始めた
 * ことがこの面から永久に見えなくなる。** この repo の「取れなかったものを 0 に
 * しない」「言い分けられないなら3つ目の状態を持つ」（{@link
 * LimitsUnavailableCause} の `undetermined` と同じ形）——**`'unrecognized'` は
 * SDK 由来の文字を1文字も運ばない**（だから安全側が壊れない）。
 */
export const accountApiKeySourceSchema = z.enum([
  'ANTHROPIC_API_KEY',
  'apiKeyHelper',
  '/login managed key',
  'none',
  'user',
  'project',
  'org',
  'temporary',
  'oauth',
  'unrecognized',
]);

export type AccountApiKeySource = z.infer<typeof accountApiKeySourceSchema>;

/**
 * SDK が返しうる8値（`AccountInfo.apiProvider`）＋ 9個目として足した `'unrecognized'`。
 *
 * **仕組みは {@link AccountApiKeySource} と同じ**（許可リストを通し、知らない値は
 * `'unrecognized'` へ畳んで、`undefined`（欄が無い＝名乗っていない）とは区別して
 * 持つ）。SDK 側の union の逐語と、`pnpm check:sdk-quotes` による同期の説明は
 * {@link SDK_API_PROVIDERS} のほうに置いてある（許可リストの現物にいちばん近い
 * 場所へ置くため）。
 *
 * **`classifyLimitsUnavailable` は `'unrecognized'` を `'non_first_party'` と
 * 断定しない**——「知らない値だった」は「3P バックエンドだと名乗った」ではない
 * （判定側の doc）。だが `undefined`（名乗っていない）とも別の観測なので、
 * こちらへ畳むこともしない。
 */
export const accountApiProviderSchema = z.enum([
  'firstParty',
  'bedrock',
  'vertex',
  'foundry',
  'anthropicAws',
  'anthropicGoogleCloud',
  'mantle',
  'gateway',
  'unrecognized',
]);

export type AccountApiProvider = z.infer<typeof accountApiProviderSchema>;

/**
 * `tokenSource`（`AccountInfo.tokenSource`）の**状態だけ**。内容は1文字も運ばない。
 *
 * ## なぜ許可リストではなく「状態」なのか
 *
 * `apiKeySource` と違い、`AccountInfo.tokenSource` は SDK 側に値の一覧が無い
 * （逐語。`@anthropic-ai/claude-agent-sdk@0.3.263` 同梱の `sdk.d.ts`）。
 *
 * [sdk-verbatim AccountInfo.tokenSource]
 * > tokenSource?: string;
 *
 * doc も union も無い自由文字列なので、`toAccountApiKeySource` のような
 * 「知っている値だけ通す」許可リストは作れない（`token-candidate.ts` が既に
 * 同じ結論に達している——「数え上げになる」）。**⟹ 値そのものを一切運ばず、
 * 「試してどうだったか」という状態だけを運ぶ。**
 *
 * ## 3つの事実を、3つの別の値で持つ
 *
 * - `'not_returned'`: 試したが SDK が欄を返さなかった（`raw` が文字列でない）
 * - `'present'`: SDK が非空の文字列を返した（**その文字列自体は運ばない**）
 * - `'empty'`: SDK は欄を返したが、空文字／空白だった
 *
 * **`nonEmpty()` はこの3つのうち後ろ2つを畳んでいた**（文字列でない場合も
 * 空文字の場合も同じ `undefined` になる）。この畳みを割るのが
 * {@link toTokenSourcePresence} の仕事である。
 *
 * ## 4つ目の状態は、この欄自体を optional にすることで持つ
 *
 * `accountUsageSchema` 側でこの欄を `.optional()` にしてあるのは、**旧い
 * daemon / runner が返す応答にはこの欄そのものが無い**からである
 * （`accountUsageStateSchema` の `cause` / `unavailable` 枝の `apiKeySource` と
 * 同じ版ずれの理由）。**同じプロセスの中で作る限り、`toAccountUsage` は必ず
 * 上の3値のどれかを入れる**（`undefined` を返さない）——⟹ 同じデプロイの中から
 * 読む限り、この欄が無いのは「この版が送らない」の1通りだけである。
 *
 * ⛔ **既定値で埋めないこと。** 埋めれば「送らなかった」と「試して`not_returned`
 * だった」が区別できなくなる。
 */
export const tokenSourcePresenceSchema = z.enum(['not_returned', 'present', 'empty']);

export type TokenSourcePresence = z.infer<typeof tokenSourcePresenceSchema>;

/**
 * アカウント全体のスナップショット1つ。
 *
 * **「取れなかった」を表現できる形にしてある。** `limitsAvailable` が真でも
 * `windows` が空のことがあり、それは「0%」ではなく「向こうが枠を教えてくれなかった」
 * である。読む側がそれを区別できないと、画面は静かに嘘をつく。
 */
export const accountUsageSchema = z.object({
  at: z.string().datetime({ offset: true }),
  /** プラン名（`Claude Team` 等）。SDK が返す表示用文字列なので翻訳しない。 */
  plan: z.string().optional(),
  organization: z.string().optional(),
  /**
   * どのバックエンドで話しているか（`AccountInfo.apiProvider`。値の一覧と根拠は
   * {@link AccountApiProvider}）。`firstParty` のときだけ claude.ai のサブスク
   * 制限が効く（Bedrock / Vertex / API キーには無い）。
   *
   * **知らない値は `'unrecognized'` に畳まれる**（元の文字は1文字も運ばない）。
   * `GET /usage` はアクセストークンで読める面なので、ここも `apiKeySource` と
   * 同じ理由で素通しにしない。
   */
  apiProvider: accountApiProviderSchema.optional(),
  /**
   * どこから来た資格情報か（`AccountInfo.apiKeySource`。値の一覧と根拠は
   * {@link AccountApiKeySource}）。
   *
   * **`tokenSourcePresence` とは別の欄である。** `tokenSource`（生値。外へは
   * 状態だけの {@link TokenSourcePresence} でしか出さない）は「鍵が届いているか」
   * （`none` なら「まだログインしていない」）を言う欄で、こちらは「届いている
   * 鍵がどこ由来か」（環境変数 / ヘルパー / `/login` が発行した鍵 / それ以外）を
   * 言う欄である。**混同すると、`apiKeySource: 'none'` を「鍵が無い」と読み
   * 違える** —— SDK の `ApiKeySource` の doc は `'none'` を「claude.ai OAuth
   * ログイン・bearer token・3rd-party cloud provider のような、API キーを
   * 使っていない構成」だと明言している（逐語は {@link AccountApiKeySource} の
   * doc）。
   *
   * **判定には使っていない。** {@link classifyLimitsUnavailable} はこの欄を
   * 読まない —— ここは観測を1本増やすだけで、分岐は増やさない（#681 (2)）。
   */
  apiKeySource: accountApiKeySourceSchema.optional(),
  /**
   * 認証の出所の**状態だけ**（{@link TokenSourcePresence}。内容は運ばない）。
   *
   * **生の `tokenSource` はここへ一切載らない。** `GET /usage` はアクセス
   * トークンで読める面なので、鍵の届き方を語る自由文字列をそのまま外へ配る
   * わけにはいかない（`apiKeySource` に許可リストを作った理由と同じだが、
   * こちらは許可リストが作れないので「状態だけ」にしてある）。
   *
   * **未ログイン判定（`isNotLoggedIn`）はこの欄を読まない。** 判定は生値の
   * まま daemon の内部（{@link fetchAccountUsage}）で完結させ、結論
   * （`accountUsageStateSchema` の `cause: 'not_logged_in'`）だけを外へ出す。
   */
  tokenSourcePresence: tokenSourcePresenceSchema.optional(),
  /**
   * 向こうが「プランの枠が効く」と言っているか。
   *
   * **これを「枠が取れた」の根拠にしないこと。** `true` でも `rate_limits` が
   * `null` のことがある（実測）。枠があるかどうかは `windows` の中身で判断する。
   */
  limitsAvailable: z.boolean(),
  /** 取れた枠。**空は「0%」ではなく「取れなかった」。** */
  windows: z.array(usageWindowSchema),
  /** 支出上限。取れなかったときは undefined（＝「取れなかった」）。 */
  extraUsage: extraUsageSchema.optional(),
});

export type AccountUsage = z.infer<typeof accountUsageSchema>;

/**
 * 枠が返ってこないとき、**その理由**。**3値のまま持つ**（#681）。
 *
 * - `not_logged_in`: まだ鍵が届いていない（`tokenSource: 'none'`）。届けば取れる
 * - `non_first_party`: claude.ai のサブスクの枠がそもそも効かないバックエンド
 *   （API キー / Bedrock / Vertex / gateway など）
 * - `undetermined`: **言い分けられない。**「サブスクが無い」ではない
 *
 * ## なぜ `undetermined` が要るのか（#681）
 *
 * ここはかつて2値（`isSubscriptionImpossible` が返す真偽。#681 で消した）で、
 * **`false` の原因を1つに潰していた。** その結果、本番の probe は
 * `この認証では claude.ai の枠が無い（apiProvider: firstParty）` を返し続けていた
 * ——**読んだ人間は「このアカウントは Claude のサブスクを持っていない」と読み、
 * 実際に読み違えた**（#678 の調査。判定そのものが `undecidable` へ倒れるので、
 * 誰も止まらないまま `recovered` が一度も出なかった）。
 *
 * SDK の型定義は、その欄が `false` になる原因を**4つ**挙げている（逐語。
 * `@anthropic-ai/claude-agent-sdk@0.3.263` 同梱の `sdk.d.ts`）。
 *
 * [sdk-verbatim SDKControlGetUsageResponse.rate_limits_available]
 * > False when plan rate limits do not apply (API key, Bedrock, Vertex, or missing profile scope) — rate_limits will be null.
 *
 * **⟹ 3つは「サブスクの枠が効かない」だが、4つ目（`missing profile scope`）は
 * 違う。** そして `apiProvider` が `firstParty` を名乗っているなら前3つは消える
 * （逐語。`AccountInfo.apiProvider`）。
 *
 * [sdk-verbatim AccountInfo.apiProvider]
 * > Active API backend. Anthropic OAuth login only applies when "firstParty"; for 3P providers the other fields are absent and auth is external (AWS creds, gcloud ADC, etc.). "gateway" means the CLI is authenticated against an enterprise gateway.
 *
 * **⚠️ それでも `missing profile scope` だと断定しない。** 消去法で1つに絞れた
 * ことと、確かめたことは別である（#681 が逐語でそう書いている）。しかも同じ
 * `sdk.d.ts` は `subscription_type` について別のことを言っており、**そちらは
 * 「plan が無い」を 3P 側の合図として説明している** ——
 *
 * [sdk-verbatim SDKControlGetUsageResponse.subscription_type]
 * > Claude.ai subscription type ('pro', 'max', 'team', 'enterprise') or null for API key / 3P provider sessions.
 *
 * ⟹ `apiProvider: firstParty` と `plan: 無し` は**互いに食い違う合図**である。
 * 食い違いを片側へ倒すのが、直そうとしている嘘そのものである。**⟹ `undetermined`。**
 */
export const limitsUnavailableCauseSchema = z.enum([
  'not_logged_in',
  'non_first_party',
  'undetermined',
]);
export type LimitsUnavailableCause = z.infer<typeof limitsUnavailableCauseSchema>;

/**
 * スナップショットを取れなかったこと自体を持つ器。
 *
 * **「まだ取れていない」と「取ろうとして取れなかった」と「枠が返ってこない構成
 * である」を区別する。** 全部 `null` にすると、画面は3つとも同じ顔で見せることに
 * なり、人間もクローンも「見えていない理由」を判断できない。
 */
export const accountUsageStateSchema = z.discriminatedUnion('state', [
  /** 一度も取りに行っていない（起動直後）。 */
  z.object({ state: z.literal('unknown') }),
  z.object({ state: z.literal('ok'), usage: accountUsageSchema }),
  /** 取りに行ったが失敗した（通信断・タイムアウト・SDK の口が変わった）。 */
  z.object({
    state: z.literal('failed'),
    at: z.string().datetime({ offset: true }),
    reason: z.string(),
  }),
  /**
   * 枠が返ってこない構成である（API キー / Bedrock / Vertex / 未ログイン / **理由を
   * 言い分けられない**）。
   *
   * `reason` に何が分かっているかを入れる。**「取れない」と「使っていない」を
   * 混ぜないため**に、状態として分けてある。
   *
   * **⚠️ この状態は「原理的に取れない」を意味しない**（#681 で直した）。かつて
   * この doc は「この認証では原理的に取れない」と書いていたが、**倒れ込む道の1本
   * （{@link LimitsUnavailableCause} の `undetermined`）は原理的な不可能では
   * ない** —— 断定できるかどうかは {@link LimitsUnavailableCause} が持つ。
   */
  z.object({
    state: z.literal('unavailable'),
    at: z.string().datetime({ offset: true }),
    reason: z.string(),
    /**
     * なぜ枠が返ってこないのか（{@link LimitsUnavailableCause}）。
     *
     * **`reason`（人間が読む1行）と別の欄である。** 文言は整形の都合で変わるが、
     * 判定に使うのはこちらである（`judgeTokenCandidate` が言葉を選ぶのに読む）。
     *
     * **⚠️ 省略可能にしてあるのは、版がずれるからである。** Web UI とデーモンは
     * 別デプロイなので、**この欄を書かない版のデーモンが返す応答を新しい画面が
     * 読む**組み合わせが実在する（`AGENTS.md`「型で塞いだ分岐にも、実行時の
     * 倒れ先の歯を足す」）。必須にすると、その組み合わせで `GET /usage` の応答が
     * まるごと parse に失敗する。⟹ **無いことは「その版が言えなかった」であって、
     * 「理由が無い」ではない。既定値で埋めないこと。**
     *
     * **同じプロセスの中で作る限り、必ず付く**（{@link fetchAccountUsage} は
     * {@link classifyLimitsUnavailable} の返り値をそのまま載せる）。
     */
    cause: limitsUnavailableCauseSchema.optional(),
    /**
     * どこから来た資格情報か（{@link AccountApiKeySource}）。**`usage` ごとは
     * 積まない**（#681 の設計判断）——`unavailable` の枝には `cause` のように
     * 「読む理由を説明できる欄だけ」を1つずつ足す。`usage` を丸ごと積むと、
     * いまは `'ok'` の枝にしか出ていない他の欄（`plan` / `organization` /
     * `apiProvider` / 支出上限）が**まとめて** `GET /usage`（アクセストークンで
     * 読める面）へ出てしまう。
     *
     * **なぜこの欄だけ `unavailable` でも運ぶのか** —— {@link
     * classifyLimitsUnavailable} が `undetermined` を割る条件
     * （`limitsAvailable === false && plan === undefined`）を満たす回は、
     * 必ず `state: 'unavailable'` へ倒れる。この欄は `usage` の中にしか
     * 無かったので、`undetermined` に割れた回だけこの欄が消えていた
     * （#681 (2) が足した観測が、割りたい状態でだけ届かない、という欠陥）。
     *
     * **判定には使わない観測である。** {@link classifyLimitsUnavailable} は
     * この欄を読まない——`cause` と違い、値が在っても `unavailable` という
     * 状態の意味は変わらない。
     *
     * **⚠️ `.optional()` の意味は2つある。** (a) SDK がこの欄を返さなかった
     * （`toAccountApiKeySource` が `undefined` を返した） (b) **この欄を書かない
     * 版のデーモンだった**（Web UI とデーモンは別デプロイ。`cause` の doc と
     * 同じ版ずれ）。**同じプロセスの中で作る限り (b) は起きない**——
     * {@link fetchAccountUsage} は必ずこの欄を載せる。⟹ `usage_read` を含め、
     * 同じデプロイの中から読む限り「取れなかった」は (a) である。
     *
     * **⛔ 既定値で埋めないこと。** `'none'` は「API キーを使っていない」と
     * いう**積極的な事実**（claude.ai の OAuth ログイン等）で、「取れなかった」
     * とは意味が正反対である。埋めれば、取れなかった回が「API キーを使って
     * いない」という嘘の事実に化ける。
     */
    apiKeySource: accountApiKeySourceSchema.optional(),
  }),
]);

export type AccountUsageState = z.infer<typeof accountUsageStateSchema>;

// ---------------------------------------------------------------------------
// 正規化（生 JSON → 上の形）
// ---------------------------------------------------------------------------

/** `/usage` の応答キー → 枠の種類。 */
const WINDOW_KEYS: Readonly<Record<string, UsageWindowKind>> = {
  five_hour: 'five_hour',
  seven_day: 'seven_day',
  seven_day_opus: 'seven_day_opus',
  seven_day_sonnet: 'seven_day_sonnet',
};

function ratio(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function positive(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

/**
 * 「欄が無い」（`undefined`）と「欄はあるが空」（`''`）を畳まずに、候補の中から
 * 値を選ぶ。**`plan` / `organization` では `nonEmpty()` の代わりにこれを通すこと。**
 *
 * - 候補のどれも文字列でない → `undefined`（**欄が無い**）
 * - 非空の候補が在る → 最初のそれ（**値が届いている**。引数の順序＝優先順位）
 * - 文字列は在るが全部が空／空白のみ → 最初のその文字列（**欄はあるが空**）
 *
 * **値の選び方は `nonEmpty(a) ?? nonEmpty(b)` から変えていない** ——非空の候補が
 * 在る限り必ずそれを採るので、**空の第1候補が非空の第2候補を隠さない。**
 * ⚠️ ここを素朴に `a ?? b` へ書き換えると壊れる（`''` は nullish ではないので、
 * 空の第1候補が第2候補の値を食う）。変えたのは「非空が1つも無かったとき」だけで、
 * そこが畳まれていた3状態の境目である。
 */
function firstPresentString(...candidates: readonly unknown[]): string | undefined {
  const strings = candidates.filter((value): value is string => typeof value === 'string');
  return strings.find((value) => value.trim().length > 0) ?? strings[0];
}

/**
 * `AccountInfo.tokenSource`（生値）を {@link TokenSourcePresence} へ畳む。
 * **常に3値のどれかを返す（`undefined` を返さない）**——`nonEmpty()` と違い、
 * 「試したが返らなかった」（`not_returned`）と「返ったが空だった」（`empty`）を
 * 同じ `undefined` へ畳まない。
 *
 * - 文字列でない（`undefined` を含む） → `'not_returned'`（試したが SDK が
 *   欄を返さなかった）
 * - 空文字／空白のみ → `'empty'`（SDK は欄を返したが空だった）
 * - それ以外の非空文字列 → `'present'`（**値そのものは返さない**）
 */
export function toTokenSourcePresence(raw: unknown): TokenSourcePresence {
  if (typeof raw !== 'string') return 'not_returned';
  return raw.trim().length > 0 ? 'present' : 'empty';
}

/** SDK が実際に出す9値だけの集合（{@link AccountApiKeySource} の `'unrecognized'` は含めない）。 */
const SDK_API_KEY_SOURCES: ReadonlySet<string> = new Set([
  'ANTHROPIC_API_KEY',
  'apiKeyHelper',
  '/login managed key',
  'none',
  'user',
  'project',
  'org',
  'temporary',
  'oauth',
]);

/**
 * `AccountInfo.apiKeySource`（`string` としか宣言されていない、生の値）を
 * {@link AccountApiKeySource} へ絞り込む。**`nonEmpty` の代わりにこれを通すこと**
 * ——素通しにしないのが #681 (2) の要件そのものである。
 *
 * - 文字列でない、または空文字 → `undefined`（`nonEmpty` と同じ「取れなかった」）
 * - 知っている9値のどれか → その値
 * - それ以外の非空文字列 → `'unrecognized'`（**元の文字は1文字も返さない**）
 */
export function toAccountApiKeySource(raw: unknown): AccountApiKeySource | undefined {
  if (typeof raw !== 'string' || raw.trim().length === 0) return undefined;
  if (SDK_API_KEY_SOURCES.has(raw)) return raw as AccountApiKeySource;
  return 'unrecognized';
}

/**
 * SDK が実際に出す8値だけの集合（{@link AccountApiProvider} の `'unrecognized'` は
 * 含めない）。
 *
 * **この行が `pnpm check:sdk-quotes` の同期の門になる。** 直下の逐語は
 * `AccountInfo.apiProvider` の union 宣言そのもの（`@anthropic-ai/claude-agent-sdk@0.3.263`
 * 同梱の `sdk.d.ts`）で、SDK がこの union に9個目の値を足せば、当てている
 * `sdk.d.ts` の部分文字列がずれて検査が赤くなる。
 *
 * [sdk-verbatim AccountInfo.apiProvider]
 * > apiProvider?: 'firstParty' | 'bedrock' | 'vertex' | 'foundry' | 'anthropicAws' | 'anthropicGoogleCloud' | 'mantle' | 'gateway';
 *
 * **`SDK_API_KEY_SOURCES`（`apiKeySource` 側、直上）にはこの機構が無い。**
 * `AccountInfo.apiKeySource` は SDK 上 `string` としか宣言されておらず（逐語は
 * {@link AccountApiKeySource} の doc）、union ではないので同じ形の逐語では
 * 守れない——素通しにしないための許可リストではあるが、SDK が値を増やしたことを
 * 機械的に検出する手段は無いままである。**こちらは union なので、逐語がそのまま
 * 同期の門になる。**
 */
const SDK_API_PROVIDERS: ReadonlySet<string> = new Set([
  'firstParty',
  'bedrock',
  'vertex',
  'foundry',
  'anthropicAws',
  'anthropicGoogleCloud',
  'mantle',
  'gateway',
]);

/**
 * `AccountInfo.apiProvider`（生の値）を {@link AccountApiProvider} へ絞り込む。
 * **`nonEmpty` の代わりにこれを通すこと。**
 *
 * - 文字列でない、または空文字・空白のみ → `undefined`（**名乗っていない**）。
 *   ⚠️ `'unrecognized'` へ倒さないこと——空文字は「名乗ったが知らない値」ではなく
 *   「何も名乗っていない」であり、倒すとこの関数が観測していないことを断定する
 *   （{@link classifyLimitsUnavailable} の `provider === undefined` の警告と同じ形）
 * - SDK の8値のどれか → その値
 * - それ以外の非空文字列 → `'unrecognized'`（**名乗ったが知らない値**。元の文字は
 *   1文字も返さない）
 */
export function toAccountApiProvider(raw: unknown): AccountApiProvider | undefined {
  if (typeof raw !== 'string' || raw.trim().length === 0) return undefined;
  if (SDK_API_PROVIDERS.has(raw)) return raw as AccountApiProvider;
  return 'unrecognized';
}

/** ISO 8601 → epoch ミリ秒。読めなければ undefined（**NaN を下へ流さない**）。 */
function isoToEpochMs(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/**
 * `rate_limit_event` の `resetsAt` は Unix **秒**。epoch ミリ秒へ寄せる。
 *
 * 将来 SDK がミリ秒へ変えても壊れないよう、既にミリ秒の桁なら素通しする
 * （秒でこの桁に届くのは西暦 5138 年なので、本物の秒と衝突しない）。
 */
export function secondsToEpochMs(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined;
  return value > 1e11 ? Math.floor(value) : Math.floor(value * 1000);
}

function toExtraUsage(value: unknown): ExtraUsage | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  return {
    enabled: raw.is_enabled === true,
    monthlyLimit: positive(raw.monthly_limit),
    usedCredits: positive(raw.used_credits),
    utilization: ratio(raw.utilization),
    currency: nonEmpty(raw.currency),
  };
}

/**
 * `usage_EXPERIMENTAL_...()` の応答を正規化する。**決して投げない。**
 *
 * 想定外の形は「枠なし」に落とす。probe は best-effort であって、ここで例外を
 * 上げると利用状況が見えないどころかデーモンの周期処理を巻き込む。
 */
export function toAccountUsage(
  at: string,
  usageJson: unknown,
  accountJson?: unknown,
): AccountUsage {
  const usage = (typeof usageJson === 'object' && usageJson !== null ? usageJson : {}) as Record<
    string,
    unknown
  >;
  const account = (
    typeof accountJson === 'object' && accountJson !== null ? accountJson : {}
  ) as Record<string, unknown>;

  const limits = usage.rate_limits;
  const windows: UsageWindow[] = [];
  let extraUsage: ExtraUsage | undefined;

  // `rate_limits_available` は見ない。**中身があるかどうかだけで判断する。**
  if (typeof limits === 'object' && limits !== null) {
    const record = limits as Record<string, unknown>;
    for (const [key, kind] of Object.entries(WINDOW_KEYS)) {
      const entry = record[key];
      if (typeof entry !== 'object' || entry === null) continue;
      const json = entry as Record<string, unknown>;
      const utilization = ratio(json.utilization);
      const resetsAt = isoToEpochMs(json.resets_at);
      // どちらも無い枠は載せない（ラベルだけの行は場所を取るだけで何も言わない）。
      if (utilization === undefined && resetsAt === undefined) continue;
      windows.push({ kind, utilization, resetsAt });
    }
    extraUsage = toExtraUsage(record.extra_usage);
  }

  return {
    at,
    plan: firstPresentString(account.subscriptionType, usage.subscription_type),
    organization: firstPresentString(account.organization),
    apiProvider: toAccountApiProvider(account.apiProvider),
    apiKeySource: toAccountApiKeySource(account.apiKeySource),
    // **生の `tokenSource` はここに載せない。** 判定（`isNotLoggedIn`）が要る
    // 生値は {@link fetchAccountUsage} が別に持つ（`rawTokenSourceOf`）——
    // `AccountUsage` はそのまま `GET /usage` へ載る型なので、ここには状態
    // だけを入れる。
    tokenSourcePresence: toTokenSourcePresence(account.tokenSource),
    limitsAvailable: usage.rate_limits_available === true,
    windows,
    extraUsage,
  };
}

/**
 * `plan` に**名前**が入っているか。`undefined`（欄が無い）と `''`（欄はあるが空）は
 * どちらも「名前は無い」側である。
 *
 * **3状態を割ったのは観測（{@link toAccountUsage}）と表示（`usage-format.ts`）の側で、
 * 判定はここで意図して2つに束ねる** ——`nonEmpty()` を外す前の挙動をこの2つの判定で
 * 1ビットも変えないため（`hasAccountUsageDetail` は `'ok'` と `'failed'` の
 * 分かれ目を握っている）。⛔ **観測や表示の側でこの束ね方を真似しないこと。**
 */
function hasPlanName(usage: AccountUsage): boolean {
  return usage.plan !== undefined && usage.plan.trim().length > 0;
}

/**
 * 枠が返ってこない構成か。返ってくると読めるなら `undefined`。
 *
 * **`limitsAvailable === false` を1つの理由に潰さないこと**（#681。値の一覧と
 * 根拠は {@link LimitsUnavailableCause}）。未ログイン（生の `tokenSource: 'none'`）
 * でも `false` が返る（実測）が、それは「サブスクが無い」ではなく「まだログイン
 * していない」である。alteroid は鍵を走行中に回せる設計なので、鍵が後から届くのは
 * 通常の状態である。ここを混ぜると、鍵が届いた後も永久に「このアカウントには
 * サブスクが無い」と表示し続ける。
 *
 * ## 順序に意味がある
 *
 * 1. **未ログインを最初に見る**（`isNotLoggedIn` と同じ判定を、同じ順序で通す）。
 *    後ろに置くと、鍵が届く前の状態が `non_first_party` や `undetermined` を
 *    名乗る
 * 2. **バックエンドが `firstParty` 以外だと名乗っている**なら断定できる
 * 3. 残りは**言い分けられない** —— `undetermined`
 *
 * **⚠️ 2 で `provider === undefined` を `non_first_party` へ倒さないこと。**
 * 名乗っていないものは「3P である」ではない（`accountInfo` の口が答えなかった
 * 回もここへ来る）。倒すと、この関数が観測していないことを断定する。
 *
 * **🔑 2 で `provider === 'unrecognized'` も `non_first_party` へ倒さないこと。**
 * 「知らない値」も「知らない」であって「3P である」の断定ではない——SDK の
 * union（{@link AccountApiProvider}）に無い値が来た回は、この関数が観測して
 * いないことを断定しないという同じ理由で `non_first_party` から外す。**だが
 * `undefined`（名乗っていない）とも別の観測なので、そちらへ畳むこともしない**
 * ——`'unrecognized'` は「名乗ったが、知っている8値のどれでもなかった」で、
 * `undefined` の「そもそも名乗っていない」とは区別したまま3の `undetermined`
 * （またはそれ以外の非 `unavailable` な状態）へ通す。
 *
 * **`tokenSourceRaw` を別引数で受け取る（#706 の本題）。** `AccountUsage` は
 * `GET /usage` へそのまま載る型なので、もう生の `tokenSource` を持たない
 * （{@link accountUsageSchema} の `tokenSourcePresence` の doc）。判定に要る
 * 生値だけを、外へ出る型の外側で受け渡す。
 */
export function classifyLimitsUnavailable(
  usage: AccountUsage,
  tokenSourceRaw: string | undefined,
): LimitsUnavailableCause | undefined {
  if (isNotLoggedIn(tokenSourceRaw)) return 'not_logged_in';
  const provider = usage.apiProvider;
  if (provider !== undefined && provider !== 'firstParty' && provider !== 'unrecognized') {
    return 'non_first_party';
  }
  if (usage.limitsAvailable === false && !hasPlanName(usage)) return 'undetermined';
  return undefined;
}

/**
 * 理由文の中で `plan` の3状態を畳まずに1語で言う。`undefined`（欄が無い）を
 * `'不明'`、`''`（欄はあるが空）を別の語にする——**`??` の既定値では割れない**
 * （`''` は nullish ではないので、既定値が出ずに空白が出る）。
 *
 * 表示の文言（4つの口が共有するもの）は `usage-format.ts` の
 * `describeAccountText` が持つ。こちらは理由文専用の短い形である。
 */
function planForReason(plan: string | undefined): string {
  if (plan === undefined) return '不明';
  return plan.trim().length === 0 ? '不明（欄はあるが空）' : plan;
}

/**
 * 上の理由を、人間が読む1行にする。**断定しない側の文言は、断定しない。**
 *
 * **`undetermined` の文言に「サブスクが無い」と書かないこと。** これがまさに
 * #681 が直した嘘である —— 読んだ人間が「このアカウントは Claude のサブスクを
 * 持っていない」と読み、実際に読み違えた。
 */
export function describeLimitsUnavailable(
  usage: AccountUsage,
  cause: LimitsUnavailableCause,
): string {
  switch (cause) {
    case 'not_logged_in':
      // **「取れない」ではない。** 鍵が届けば取れる。ローカル開発や鍵の配布前は
      // ここへ落ちるのが正常であり、異常として扱わないこと。
      return 'claude.ai にログインしていない（鍵が届けば取れる）';
    case 'non_first_party':
      return `この認証では claude.ai の枠が効かない（apiProvider: ${usage.apiProvider ?? '不明'}）`;
    case 'undetermined':
      // **数え上げをここへ書き写さない。** 4つの原因とその出所は
      // `LimitsUnavailableCause` の doc が持ち、あちらは `check:sdk-quotes` が
      // 毎回当て直している。ここに写すと、写しのほうが先に腐る。
      return (
        '枠が効かない理由を言い分けられない' +
        `（rate_limits_available: ${String(usage.limitsAvailable)} / apiProvider: ${usage.apiProvider ?? '不明'} / plan: ${planForReason(usage.plan)}）` +
        '。**「サブスクが無い」と読まないこと** —— この欄が false になる原因には' +
        '「profile スコープの不足」（鍵を取り直せば戻りうる）が含まれる（#681）'
      );
  }
}

/**
 * まだログインしていないと読めるか（＝鍵が届けば取れるようになる）。
 *
 * **生の `tokenSource` を直接受け取る。** `AccountUsage`（外へ出る型）は生値を
 * 持たないので、この判定は daemon の内部（{@link fetchAccountUsage}）が生値の
 * まま呼ぶ。外へ出るのは {@link classifyLimitsUnavailable} が返す `cause` の
 * 結論だけである。
 */
export function isNotLoggedIn(tokenSourceRaw: string | undefined): boolean {
  return tokenSourceRaw === 'none';
}

/**
 * `AccountInfo.tokenSource` の生値を取り出す。**内部の判定専用**——
 * この値を {@link AccountUsage} へ積まないこと（`toAccountUsage` は積まない）。
 *
 * `toAccountUsage` と同じ防御的な読み方（object でなければ空扱い）にしてある。
 */
function rawTokenSourceOf(accountJson: unknown): string | undefined {
  const account = (
    typeof accountJson === 'object' && accountJson !== null ? accountJson : {}
  ) as Record<string, unknown>;
  return nonEmpty(account.tokenSource);
}

/** 何か表示できるものが取れたか。 */
export function hasAccountUsageDetail(usage: AccountUsage): boolean {
  return hasPlanName(usage) || usage.windows.length > 0 || usage.extraUsage !== undefined;
}

// ---------------------------------------------------------------------------
// 取りに行く
// ---------------------------------------------------------------------------

/**
 * probe 1回ぶんの締め切り。
 *
 * 短めにしてあるのは、これが**best-effort の観測**であって仕事ではないからである。
 * 実測では 300〜400ms で答えが返っている（推論を走らせないため）。
 */
export const ACCOUNT_USAGE_READ_TIMEOUT_MS = 10_000;

/**
 * `runUsageProbe` が持ち帰った {@link UsageProbeFailure} を、`AccountUsageState`
 * の `reason` へ落とす。**種別ごとの固定日本語ラベルは、以前の固定文言
 * 「起動失敗・締め切り・中断」の内訳をそのまま名乗ったもの** — 呼び出し元
 * （`judgeTokenCandidate` 等）はこの文字列を判定に使わないので、文言そのものを
 * 変えても判定結果は動かない（`state: 'failed'` であることだけが効く）。
 *
 * **export してあるのはテストのため。** `fetchAccountUsage` を通す経路では
 * `timeout` / `aborted` を作れない（`ACCOUNT_USAGE_READ_TIMEOUT_MS`
 * ＜ `USAGE_PROBE_TIMEOUT_MS` なので、2つの口の読み取りが常に外側の締め切りより
 * 先に終わる。`settleWithin` は reject も飲んで `undefined` にするので `read` 自体
 * も投げない）。**この2値は `runUsageProbe` の一般契約としては要る**（他の
 * 呼び出し元や将来の変更のため）ので、`fetchAccountUsage` 経由の統合テストでは
 * 到達できない分、ここを直接呼ぶ単体テストで両方の分岐を確かめる。
 */
export function describeOuterFailure(failure: UsageProbeFailure): string {
  const label: Record<UsageProbeFailure['kind'], string> = {
    exception: '起動失敗',
    timeout: '締め切り',
    aborted: '中断',
  };
  return `probe が応答しなかった（${label[failure.kind]}: ${failure.reason}）`;
}

/**
 * 2つの口（`accountInfo` / `usage_EXPERIMENTAL_...`）が両方とも `undefined` に
 * 落ちたとき、どちらに何が起きたかを1行にする。
 *
 * **各口は3つの倒れ方を持つ** — (1) 口が SDK に無い（`?.()` が呼ばれず
 * `settleWithin(undefined, …)` が即 `undefined`）(2) 呼んだが締め切りに間に合わ
 * なかった（`onRejected` も呼ばれず `undefined`）(3) 呼んだら reject した
 * （`onRejected` が理由を渡す）。**(1) と (2) はここでは区別できない** —
 * `settleWithin` 自身が「口が無い」と「間に合わなかった」を区別する材料を
 * 持たない（`promise === undefined` の分岐と、レースに負けた場合とで、渡って
 * くる値がどちらも `undefined` で同じため）。区別できるのは reject した (3) だけ
 * である。
 */
export function describeSilentChannels(
  accountReject: string | undefined,
  usageReject: string | undefined,
): string {
  const describe = (reject: string | undefined) =>
    reject === undefined ? '応答なし（口が無いか、締め切りに間に合わなかった）' : `例外: ${reject}`;
  return (
    `2つの口のどちらも答えなかった` +
    `（accountInfo: ${describe(accountReject)} / usage: ${describe(usageReject)}）`
  );
}

/**
 * アカウント全体の利用状況を1回読む。**決して投げない。**
 *
 * 2つの口を**独立に**読む。片方が固まってももう片方を捨てないためで、実測でも
 * 「`accountInfo()` は答えるのに usage 側は `rate_limits: null`」という食い違いが
 * 出ている。実験的な control 要求は固まる可能性がいちばん高い種類のものである。
 *
 * `options.env` / `options.withheldEnvKeys` は `runUsageProbe`（`usage-probe.ts`）へ
 * そのまま渡すだけで、ここでは中身を見ない。**渡さなければ挙動は1文字も変わらない**
 * （`usage-probe.ts` の doc のとおり）。
 *
 * **#429: 失敗の理由を構造化して持ち帰る。** 以前は `runUsageProbe` の失敗も
 * 2つの口の rejection も揃って握り潰され、`reason` は固定文言1本に畳まれていた
 * （認証失敗・通信断・締め切りの区別が付かなかった）。**この変更は `reason` の
 * 中身を詳しくするだけで、`state` の値・判定（`judgeTokenCandidate`）の結果は
 * 1件も変えていない。**
 */
export async function fetchAccountUsage(
  queryFn: UsageProbeQuery,
  options: {
    cwd: string;
    signal?: AbortSignal;
    env?: NodeJS.ProcessEnv;
    /** `usage-probe.ts` の `UsageProbeOptions.withheldEnvKeys` へそのまま渡す（#431）。 */
    withheldEnvKeys?: readonly string[];
  },
): Promise<AccountUsageState> {
  const at = new Date().toISOString();

  let accountReject: string | undefined;
  let usageReject: string | undefined;

  const outcome = await runUsageProbe(queryFn, options, async (handle) => {
    const [account, usage] = await Promise.all([
      settleWithin(handle.accountInfo?.(), ACCOUNT_USAGE_READ_TIMEOUT_MS, (error) => {
        accountReject = describeProbeError(error, options.env);
      }),
      settleWithin(
        handle.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET?.(),
        ACCOUNT_USAGE_READ_TIMEOUT_MS,
        (error) => {
          usageReject = describeProbeError(error, options.env);
        },
      ),
    ]);
    return { account, usage };
  });

  if (!outcome.ok) {
    return { state: 'failed', at, reason: describeOuterFailure(outcome.failure) };
  }
  const read = outcome.value;
  if (read.account === undefined && read.usage === undefined) {
    return { state: 'failed', at, reason: describeSilentChannels(accountReject, usageReject) };
  }

  const usage = toAccountUsage(at, read.usage, read.account);
  // **生値はここだけで持つ。** `usage`（外へ出る型）には積まない
  // （`rawTokenSourceOf` の doc）。
  const tokenSourceRaw = rawTokenSourceOf(read.account);

  // **理由を1つに潰さない**（#681）。未ログイン・3P バックエンド・言い分けられない
  // の3つは、**判定（`judgeTokenCandidate`）が同じ `undecidable` でも、人間が次に
  // やることが違う** —— 鍵を待つ / 何もできない / 鍵を取り直してみる。
  const unavailable = classifyLimitsUnavailable(usage, tokenSourceRaw);
  if (unavailable !== undefined) {
    // **`usage` ごと積まない。1欄だけ運ぶ**（#681 の設計判断。理由は
    // `accountUsageStateSchema` の `unavailable` 枝の `apiKeySource` の doc）。
    // 値は {@link toAccountUsage} が {@link toAccountApiKeySource}（許可リスト）を
    // 通した後のものなので、ここで許可リストを迂回して生の値へ触ってはいない。
    return {
      state: 'unavailable',
      at,
      reason: describeLimitsUnavailable(usage, unavailable),
      cause: unavailable,
      apiKeySource: usage.apiKeySource,
    };
  }
  if (!hasAccountUsageDetail(usage)) {
    // **`limitsAvailable` が真でも枠が来ないことがある**（実測）。0% と描かない。
    return {
      state: 'failed',
      at,
      reason: `枠の中身が返らなかった（rate_limits_available: ${usage.limitsAvailable}）`,
    };
  }
  return { state: 'ok', usage };
}
