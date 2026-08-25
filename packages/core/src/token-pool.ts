import { z } from 'zod';

import { fingerprintOf } from './credentials.js';
import { limitRecoveryOf, limitRecoverySchema, type LimitRecovery } from './usage-limits.js';

/**
 * 認証トークンのプール（Issue #393「PR1 プールの器」）。
 *
 * **回さない。** ここに在るのは器・設定・入出力の口だけで、検知（枠に当たったか）
 * も切替（どのトークンへ回すか）もこの PR には無い。回し手はデーモンの中の
 * 別の1本（PR3）である。**プールが空の既定構成の挙動を1文字も変えないこと**
 * が受け入れ基準7であり、この事実はここに書く実装のどこにも矛盾してはいけない
 * ——空配列を渡しても投げない・既定の設定だけを返す、という形がそれである。
 */

// ---------------------------------------------------------------------------
// 回す契機と冷却の既定（設定）
// ---------------------------------------------------------------------------

/**
 * 回す契機。**設定であって固定値ではない**（`PUT /tokens/policy` / `alteroid
 * token policy` / クローンの道具の3つが同じ1本の列を通して変えられる）。
 *
 * - `free_exhausted`（既定）: 無料枠が尽きたら回す（`rejected`、または課金枠へ
 *   落ちた瞬間）。課金枠を焼きたくない人のための既定
 * - `overage_exhausted`: 課金枠まで閉じてから回す（`reached`、または課金枠も
 *   閉じている `rejected`）
 * - `off`: 回さない（記録だけする）
 *
 * 判断の経緯は Issue #393「追記2」——**この PR はこの値を読まない**。回す側
 * （PR3）が読む契機の判定はここには無く、ここは型と既定を持つだけである。
 *
 * **回す契機は枠の2つだけである**（人間の決定 2026-08-24）。`invalidatedAt` /
 * `invalidatedReason`（{@link AgentToken}）が立つ「トークンが恒常的に通らない」
 * という状態は、`rotateOn` のどの値にも契機として含まれていない。
 *
 * **⟹ 現役のトークンが失効したときは回らない。** 枠に当たったとき（`cooldownUntil`）
 * と違い、**全層が止まったままになる。** 人間が手で外す（`alteroid token disable`）
 * まで復旧しない。
 *
 * **⚠️ 候補の側とは非対称である。** 候補（まだ現役でない行）が失効していれば
 * 選ぶ側が飛ばせるが（`invalidatedAt` に記録が残っている）、**現役が失効しても
 * 降ろす契機がここには無い。**
 *
 * **これを「未実装」ではなく「そう決めた」として読むこと。** 契機を足すかどうかは
 * 人間の判断であり（一旦見送り。恒久の否定ではない）、足すなら `rotateOn` の
 * `z.enum` に値を1つ加える形になる——**そのための余地を潰す特別扱いをしないこと**
 * （分岐をここで先回りして作らない）。
 */
export const tokenRotationPolicySchema = z.enum(['free_exhausted', 'overage_exhausted', 'off']);
export type TokenRotationPolicy = z.infer<typeof tokenRotationPolicySchema>;

/**
 * 回す契機の既定。**受け入れ基準（Issue #393）が固定している値**——
 * 「課金枠を使いたい人もいる。既定は無料枠を使い切ったら」という人間の決定
 * （2026-08-24）に基づく。
 */
export const DEFAULT_TOKEN_ROTATION_POLICY: TokenRotationPolicy = 'free_exhausted';

/**
 * `resetsAt` が取れなかったときの冷却の既定（ミリ秒）。
 *
 * **これは「設定の既定値」であって固定値ではない。** `PUT /tokens/policy` で
 * 人間が変えられる1つの設定項目にすぎない。**権威ある冷却の期限は `resetsAt`
 * のほう**（`usage-limits.ts` の `toRateLimitFacts` が epoch ミリ秒へ正規化した
 * 値）で、この定数は *それが取れなかったとき* だけ使うフォールバックである
 * （API キー・Bedrock・Vertex など `rate_limits` が埋まらない構成、または
 * まだ一度もその枠を観測していない場合）。
 *
 * 値は**いちばん短い枠の単位（5時間）**に寄せてある——**早く起きすぎるほうが
 * 安全側**だからである。早ければ「候補をもう一度確かめて、まだ駄目なら冷やし
 * 直す」だけで済むが、長すぎると開いた枠をまるごと寝過ごす。
 *
 * **枠の単位は時期で動く数である。この値を「枠は5時間である」という Anthropic
 * 側の仕様の主張として読まないこと。** ここにあるのは「フォールバックとして
 * どれだけ待つか」という実装側の安全側の判断であって、枠の契約を表明するもの
 * ではない。実際の枠の単位が変わっても、この定数を変える必要は無い
 * （早めに起きて確かめ直すだけなので、短すぎる分には壊れない）。
 */
export const DEFAULT_TOKEN_COOLDOWN_MS = 5 * 60 * 60 * 1000;

/** 回す契機と冷却の既定（記憶ストアの1行）。 */
export const tokenRotationSettingsSchema = z.object({
  rotateOn: tokenRotationPolicySchema,
  /** ミリ秒。正の整数。 */
  cooldownMs: z.number().int().positive(),
  /** 最後に人間かクローンが設定を変えた時刻（ISO 8601）。まだ一度も変えていなければ無い。 */
  updatedAt: z.string().optional(),
});
export type TokenRotationSettings = z.infer<typeof tokenRotationSettingsSchema>;

/** 記憶ストアに何も置かれていないときに返す既定値。 */
export const DEFAULT_TOKEN_ROTATION_SETTINGS: TokenRotationSettings = {
  rotateOn: DEFAULT_TOKEN_ROTATION_POLICY,
  cooldownMs: DEFAULT_TOKEN_COOLDOWN_MS,
};

// ---------------------------------------------------------------------------
// トークン1本の正本（`value` を持つのはデーモンの中だけ）
// ---------------------------------------------------------------------------

/**
 * プールの1本。**正本。`value` を持つのはデーモンの中だけ。**
 *
 * API・CLI・Web・日誌・ログのどこにも `value` を出してはいけない——外へ出す顔は
 * 別の型（{@link AgentTokenView}）にしてあり、`value` はそもそも型として持たない
 * （「書き忘れて漏れる」形を消す）。
 */
export interface AgentToken {
  id: string;
  /** 人間が読む名前。**秘密ではない。** */
  label: string;
  /**
   * この行の資格がどこから来るか（Issue #393）。
   *
   * - `stored`（既定）: {@link AgentToken.value} が本体を持つ
   * - `env`: **器の環境変数（`CLAUDE_CODE_OAUTH_TOKEN`）を指す。`value` は持たない**
   *
   * ## なぜ「値としてリテラルを入れる」形にしないか
   *
   * 「`value` に `'CLAUDE_CODE_OAUTH_TOKEN'` という文字列を入れて env の代わりに
   * する」は**3か所で壊れる** —— 撒くとリテラルが器のファイルに書かれて全層が
   * 認証に失敗し、probe はリテラルで認証を試して失敗し（その行を誤って冷却する）、
   * 外向きの顔にはリテラルのハッシュが**本物の指紋の顔をして**出る。
   *
   * **どれも特別扱いを足せば直るが、特別扱いが要ることが「型で表すべき」という
   * 合図である。** マジック値のままだと、次に読む人が特別扱いを1つ忘れた瞬間に
   * 穴が開く（しかも開き方が「全層が認証に失敗する」である）。
   *
   * ## この行は人間が書いたものではなく、事実の射影である
   *
   * 器に環境変数が置かれているという**事実**を、プールの中で1行として表しているだけ
   * である。⟹ **消しても次の起動で戻る**（環境変数が消えたわけではないので）。
   * 「もう使わない」を表したいなら {@link AgentToken.disabledAt}（`alteroid token
   * disable`）を使う——そちらは人間の判断なので戻らない。
   */
  source?: 'stored' | 'env';
  /**
   * 本体。**API・CLI・Web・日誌・ログのどこにも出さない。**
   *
   * **`source: 'env'` の行は持たない**（器の環境変数を指すだけなので）。
   */
  value?: string;
  /** 試す順（小さいほど先）。 */
  order: number;
  /** 人間が明示的に外した（**戻らない側**）。 */
  disabledAt?: string;
  /** epoch ミリ秒（**戻る側**。`resetsAt` 由来、取れなければ設定の既定）。 */
  cooldownUntil?: number;
  lastRejectedAt?: string;
  lastRejectedReason?: string;
  /**
   * トークンが恒常的に通らないと確定した時刻（ISO 8601）——失効・組織による
   * 不許可・アカウント停止など。**3つ目の状態**——`cooldownUntil`（戻る）とも
   * `disabledAt`（人間が外した。戻らない）とも違う、**戻らないが人間が外した
   * のでもない**状態を持つための列である。
   *
   * | 状態 | 戻るか | どの列 |
   * | --- | --- | --- |
   * | 枠に当たった | 戻る（`resetsAt`） | `cooldownUntil` |
   * | 人間が明示的に外した | 戻らない | `disabledAt` |
   * | トークンが通らない（失効・組織で不許可・アカウント停止） | 戻らない。だが人間が外したのでもない | **これ** |
   *
   * **`cooldownUntil` へ潰すと「待てば戻る」という嘘になり、`disabledAt` へ
   * 潰すと「人間が外した」という嘘になる。** だから2列へ畳まず、3つ目の列を持つ。
   *
   * **この PR（プールの器）では誰もここへ値を入れない。** 入れる経路
   * （候補を判定して失効と確定する側）を作るのは PR2 / PR3 であり、この PR が
   * 持つのは器と、更新のたびに既存の値を引き継ぐ経路（{@link normalizeTokenPool}）
   * だけである。
   *
   * **人間の入力（{@link agentTokenInputSchema}）からは設定できない。** 人間が
   * 明示的に「外す」のは `disabled`（→ `disabledAt`）のほうであり、こちらは
   * 観測から立つ記録であって人間が直接書き込む値ではない。
   */
  invalidatedAt?: string;
  /**
   * 上の {@link AgentToken.invalidatedAt} が立った理由。
   *
   * **型は `string`。中身は観測した語をそのまま持つ——器の側は解釈しない。**
   * こちらの語彙へ畳む（enum にする）形には**しない**。畳むには向こうの語を
   * 数え上げることになり、**向こうが語を増やすたびに静かに腐る**からである。
   * 実測（2026-08-24 観測、`packages/core/node_modules/@anthropic-ai/claude-agent-sdk`
   * の `package.json` が `0.3.241`）: `sdk.d.ts` の `SDKAssistantMessageError`
   * は11値だが、`sdk-failure.ts` の doc とテストの数え上げは10値のまま
   * （`account_on_hold` が落ちている）。**同じ穴をこの列で作らない。**
   *
   * リポジトリに既に同じ判断がある——`usage-limits.ts` の doc は「上限の文言を
   * 自前の正規表現で書かない（SDK が定数で出しており、手で書けば静かに効かなく
   * なる）」と言い、Issue #393 も「当たった文言は言い換えずそのまま残す」と
   * 書いている。
   *
   * **⚠️ この列は「解釈しない文字列」であって、分岐の条件に使ってよい enum
   * ではない。** 分岐が要るなら、そのときに**構造化された印**
   * （`SDKAssistantMessageError` そのもの）を別に持つこと——この文字列を
   * `switch` や `includes` で判定しない。
   */
  invalidatedReason?: string;
  /**
   * この行が最初に作られた時刻（ISO 8601）。
   *
   * **PR1 の版が書いた行には無い**（後から足した列である）。無い行を `now()` で
   * 埋め直さないこと——それは「いま作られた」という嘘になる。**無いことが読める
   * のは「PR1 の版で書かれた行である」という事実だけである。**
   */
  createdAt?: string;
  /**
   * この行が最後に変わった時刻（ISO 8601）。
   *
   * **「プールが最後に書かれた時刻」ではない。** `PUT /tokens` は全文置換なので、
   * 1行だけ直した書き込みでも全行がこの関数を通る。全行に判を押すと、この列は
   * 「最後に誰かが `PUT` を打った時刻」に化けて、**どの行がいつ変わったかが
   * 取れなくなる**（AGENTS.md 地雷「取れない軸に 0 の行を作る」の同型——値の側が
   * 取れていないことを出力から消す）。⟹ {@link normalizeTokenPool} は
   * **実際に変わった行だけ**に判を押す。
   */
  updatedAt?: string;
}

/**
 * 外へ出す顔。**`value` を持たない**——型として無いので、書き忘れて漏れる形が
 * そもそも作れない。値以外はすべて {@link AgentToken} と同じ意味で、秘密ではない
 * ので出してよい。
 */
export const agentTokenViewSchema = z.object({
  id: z.string(),
  label: z.string(),
  order: z.number().int(),
  /**
   * 指紋。`fingerprintOf`（`credentials.ts`）と同じ形——値そのものは出さない。
   *
   * **`source: 'env'` の行には無い。** あの行は値を持たないので、指紋も存在しない
   * ——**リテラルのハッシュを入れて「本物の指紋の顔をした偽物」を出さないこと。**
   */
  sha256: z.string().optional(),
  /** 資格の出所。**器の環境変数を指す行は `env`。** */
  source: z.enum(['stored', 'env']).optional(),
  disabledAt: z.string().optional(),
  cooldownUntil: z.number().optional(),
  lastRejectedAt: z.string().optional(),
  lastRejectedReason: z.string().optional(),
  invalidatedAt: z.string().optional(),
  invalidatedReason: z.string().optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
  /**
   * 最後の拒否の文言が「時間で戻る」ものかどうか（{@link limitRecoveryOf}）。
   *
   * **保存しない。読むたびに `lastRejectedReason` から導く。** 保存すると、
   * 分類の表（`usage-limits.ts` の `LIMIT_RECOVERY_BY_PREFIX`）を直したときに
   * 古い行だけ古い判定を持ち続ける——しかも**どの行が古い判定なのかが行から
   * 読めない。** 正本は生の文言のほうであり、判定はその射影である。
   *
   * `lastRejectedReason` が無ければ**この項目も無い**（「拒否されていない」と
   * 「拒否されたが分類できない」を `unknown` に潰さない）。
   */
  recovery: limitRecoverySchema.optional(),
});
export type AgentTokenView = z.infer<typeof agentTokenViewSchema>;

/** {@link AgentToken} から外向きの顔を作る。**`value` は指紋にしてから捨てる。** */
export function toAgentTokenView(token: AgentToken): AgentTokenView {
  return agentTokenViewSchema.parse({
    id: token.id,
    label: token.label,
    order: token.order,
    // **env の行には指紋を出さない**（値が無いので存在しない）。
    ...(token.value === undefined ? {} : { sha256: fingerprintOf(token.value) }),
    ...(token.source === undefined ? {} : { source: token.source }),
    ...(token.disabledAt === undefined ? {} : { disabledAt: token.disabledAt }),
    ...(token.cooldownUntil === undefined ? {} : { cooldownUntil: token.cooldownUntil }),
    ...(token.lastRejectedAt === undefined ? {} : { lastRejectedAt: token.lastRejectedAt }),
    ...(token.lastRejectedReason === undefined
      ? {}
      : { lastRejectedReason: token.lastRejectedReason }),
    ...(token.invalidatedAt === undefined ? {} : { invalidatedAt: token.invalidatedAt }),
    ...(token.invalidatedReason === undefined
      ? {}
      : { invalidatedReason: token.invalidatedReason }),
    ...(token.createdAt === undefined ? {} : { createdAt: token.createdAt }),
    ...(token.updatedAt === undefined ? {} : { updatedAt: token.updatedAt }),
    ...(token.lastRejectedReason === undefined
      ? {}
      : { recovery: limitRecoveryOf(token.lastRejectedReason) }),
  });
}

// ---------------------------------------------------------------------------
// 入力の形（人間が置く側）
// ---------------------------------------------------------------------------

/**
 * 人間（または CLI / Web / クローンの道具）が `PUT /tokens` へ渡す1行。
 *
 * **`value` を省略できることが要点である。** 並べ替え・改名・`disabled` の
 * 切り替えのたびに、人間が既存の秘密を貼り直さずに済むようにするため——
 * `value` を省略したら {@link normalizeTokenPool} が既存の行から引き継ぐ。
 */
export const agentTokenInputSchema = z.object({
  /** 既存の行を指す。省略すると新しい行として扱う。 */
  id: z.string().min(1).optional(),
  label: z.string().min(1),
  /** 省略したら `id` が指す既存の行の値を保つ。新規の行では必須。 */
  value: z.string().min(1).optional(),
  order: z.number().int().optional(),
  disabled: z.boolean().optional(),
});
export type AgentTokenInput = z.infer<typeof agentTokenInputSchema>;

export interface NormalizeTokenPoolOptions {
  /** 現在時刻。テストで固定するため。 */
  now: () => Date;
  /** 新規行の id を作る。テストで固定するため。 */
  newId: () => string;
}

/**
 * {@link normalizeTokenPool} が入力を受け付けなかったこと。
 *
 * **この型は「`message` をそのまま HTTP の応答へ返してよい」ことを意味する。**
 * 呼び出し側（`apps/daemon/src/app.ts` の `PUT /tokens`）は、この型のときだけ
 * 400 の本文へ `message` を載せ、それ以外の例外（保存の失敗など）は本文を
 * 1文字も返さない。
 *
 * **⟹ `message` に、保存対象の値・資格・入力の本文を含めてはいけない。** 含めて
 * よいのは `id` / `label` のような**呼び出し側が既に知っている識別子**だけである。
 *
 * **⚠️ 「返したいメッセージが在るから」でこの型を使わないこと。** 返してよいか
 * どうかは、メッセージの中身で決まる。中身を確かめられないもの（ドライバや
 * ライブラリが投げた例外）をこの型で包み直すと、**この型が持っている「返して
 * よい」という約束だけが残り、中身の検査が消える。** 実測（2026-08-24 観測、
 * `drizzle-orm@0.45.2`）: `PgPreparedQuery` の `queryWithCache` は失敗した
 * クエリの束縛パラメータを `message` に添えて投げる——`agent_tokens` への
 * insert なら、そこにトークンの値がそのまま並ぶ。
 *
 * **これは {@link AgentToken.invalidatedReason} が「解釈しない文字列であって
 * 分岐に使ってよい enum ではない」のと同じ形である**——腐りにくい形を選ぶと、
 * その形が次に読む人へ新しい誘引を生む。誘引はここで名指ししておく。
 */
export class TokenPoolInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TokenPoolInputError';
  }
}

/**
 * `PUT /tokens` の入力を、保存できる正本（{@link AgentToken}[]）へ正規化する。
 *
 * **純粋関数。** 器（fs / pg）にもサービス（`token-pool-service.ts`）にも依存
 * しない——テストをここへ寄せるためである。
 *
 * ## 規則
 *
 * - `id` が既存の行に在れば、`value` / `cooldownUntil` / `lastRejectedAt` /
 *   `lastRejectedReason` / `invalidatedAt` / `invalidatedReason` を**引き継ぐ**
 *   （入力に `value` が在ればそちらで上書きする。他は人間の入力からは触れない
 *   ので常に引き継ぐ）
 * - `id` が無い（＝新規行）のに `value` も無ければ **`Error` を投げる**
 *   （黙って空の行を作らない）
 * - `id` が指定されているのに既存の行に無ければ **`Error` を投げる**
 *   （消えた行を静かに作り直さない——本人が意図せず別の行を新設してしまう
 *   事故を防ぐ）
 * - 入力の中で `id` が重複していたら **`Error`**
 * - `order` は入力で明示があればそれ、無ければ**入力配列内の位置**。結果は
 *   `order` 昇順で返し、同値は入力順で安定させる
 * - `disabled: true` → `disabledAt` は既存の値があればそのまま保ち、無ければ
 *   `now()`。`disabled: false` → `disabledAt` を落とす。`disabled` 省略 →
 *   既存のまま変えない
 * - **入力に現れなかった既存の行は消える**（`PUT /tokens` は全文置換である）
 * - `createdAt` は**新規行にだけ**立つ。既存の行は引き継ぐ（無い行は無いまま）
 * - `updatedAt` は**実際に変わった行にだけ**立つ。変わっていない行は前の値を保つ
 *   （全文置換だからといって全行に判を押さない。理由は {@link AgentToken.updatedAt}）
 *
 * **投げるのは {@link TokenPoolInputError} だけである。** そのメッセージは
 * `id` / `label` しか含まない——呼び出し側がそのまま応答へ返してよい、という
 * 約束がその型に付いている（その型の doc）。
 */
export function normalizeTokenPool(
  inputs: readonly AgentTokenInput[],
  existing: readonly AgentToken[],
  options: NormalizeTokenPoolOptions,
): AgentToken[] {
  const byId = new Map(existing.map((token) => [token.id, token] as const));
  const seenIds = new Set<string>();

  const built = inputs.map((input, index) => {
    if (input.id !== undefined) {
      if (seenIds.has(input.id)) {
        throw new TokenPoolInputError(`トークンの id が入力の中で重複している: ${input.id}`);
      }
      seenIds.add(input.id);
    }

    const current = input.id === undefined ? undefined : byId.get(input.id);
    if (input.id !== undefined && current === undefined) {
      throw new TokenPoolInputError(
        `id ${input.id} のトークンは既存の行に無い（消えた行を静かに作り直さない）`,
      );
    }

    const value = input.value ?? current?.value;
    if (value === undefined) {
      throw new TokenPoolInputError(
        `新しいトークン（${input.label}）には value が要る` +
          '（省略できるのは、id で既存の行を指しているときだけ）',
      );
    }

    const nowIso = options.now().toISOString();

    const disabledAt =
      input.disabled === undefined
        ? current?.disabledAt
        : input.disabled
          ? (current?.disabledAt ?? nowIso)
          : undefined;

    const id = current?.id ?? input.id ?? options.newId();
    const order = input.order ?? index;

    /**
     * **判を押すのは実際に変わった行だけである**（{@link AgentToken.updatedAt} の doc）。
     *
     * 見るのは**この経路で変わりうる4つ**だけ——`label` / `value` / `order` /
     * `disabledAt`。残り（`cooldownUntil` 以下）は下で「常に引き継ぐ」と書いてある
     * とおり人間の入力からは動かないので、比べても必ず一致する。**比べる対象を
     * 「全フィールド」と書くと、引き継ぎの側を直したときに黙って判定が変わる。**
     */
    const changed =
      current === undefined ||
      current.label !== input.label ||
      current.value !== value ||
      current.order !== order ||
      current.disabledAt !== disabledAt;

    const token: AgentToken = {
      id,
      label: input.label,
      value,
      order,
      ...(disabledAt === undefined ? {} : { disabledAt }),
      // **`disabled` 以外の派生値は人間の入力からは触れない——常に引き継ぐ。**
      ...(current?.cooldownUntil === undefined ? {} : { cooldownUntil: current.cooldownUntil }),
      ...(current?.lastRejectedAt === undefined ? {} : { lastRejectedAt: current.lastRejectedAt }),
      ...(current?.lastRejectedReason === undefined
        ? {}
        : { lastRejectedReason: current.lastRejectedReason }),
      ...(current?.invalidatedAt === undefined ? {} : { invalidatedAt: current.invalidatedAt }),
      ...(current?.invalidatedReason === undefined
        ? {}
        : { invalidatedReason: current.invalidatedReason }),
      // 新規行だけ `createdAt` を立てる。既存の行は引き継ぐ——**無い行を
      // `now()` で埋め直さない**（`AgentToken.createdAt` の doc）。
      ...(current === undefined
        ? { createdAt: nowIso }
        : current.createdAt === undefined
          ? {}
          : { createdAt: current.createdAt }),
      ...(changed
        ? { updatedAt: nowIso }
        : current?.updatedAt === undefined
          ? {}
          : { updatedAt: current.updatedAt }),
    };
    return { token, inputIndex: index };
  });

  // **`order` 昇順、同値は入力順で安定。** `Array#sort` は ES2019 以降で安定だが、
  // それに頼らず明示の tie-break（`inputIndex`）を持たせておく——エンジンの
  // 安定性という間接的な保証に、この関数の契約を委ねないため。
  return built
    .sort((a, b) => a.token.order - b.token.order || a.inputIndex - b.inputIndex)
    .map((entry) => entry.token);
}

// ---------------------------------------------------------------------------
// 枠に追い返された事実を1行へ記録する（Issue #393）
// ---------------------------------------------------------------------------

/**
 * 「このトークンで止まった」1回の観測。
 *
 * **回す判断はここに無い。** ここが持つのは「何を見たか」だけで、次にどの候補へ
 * 移るか（あるいは移らないか）は回し手（PR3）の領域である。
 */
export interface TokenFailureObservation {
  /** 観測した時刻（ISO 8601）。 */
  at: string;
  /**
   * 止まったときの文言。**SDK が出したものをそのまま入れる——言い換えない。**
   *
   * 言い換えると、`limitRecoveryOf` が見る接頭辞が消えて分類が `unknown` へ落ちる。
   * そして落ちたことは、あとから行を見ても分からない（Issue #393「当たった文言は
   * 言い換えずそのまま残す」）。
   */
  message: string;
  /**
   * 権威ある復帰時刻（epoch ミリ秒）。`toRateLimitFacts` の `resetsAt` を渡す。
   *
   * **取れなかったら省略する。`0` や `now` で埋めないこと**——埋めた値は
   * 「そう観測した」と読める（AGENTS.md 地雷「取れない軸に 0 の行を作る」）。
   */
  resetsAt?: number;
  /**
   * `resetsAt` が取れなかったときに使う冷却（ミリ秒）。設定の既定
   * （`TokenRotationSettings.cooldownMs`）を渡す。
   *
   * **ここで既定値を持たない。** 持つと、設定を変えたのに片方の経路だけ古い値で
   * 動く形が作れる——`DEFAULT_TOKEN_COOLDOWN_MS` の doc が言うとおり、権威は
   * `resetsAt` で、その次が「設定として1か所に置いた既定」である。
   */
  fallbackCooldownMs: number;
}

/**
 * 止まった事実を1行へ書き込む（純粋関数。新しい行を返す）。
 *
 * 書くのは3つ——**いつ**（`lastRejectedAt`）・**何と言われたか**（`lastRejectedReason`）・
 * **いつ戻る見込みか**（`cooldownUntil`）。加えて `updatedAt`。
 *
 * **触らないもの:**
 *
 * - `disabledAt` — 人間が明示的に外した印である。観測が人間の判断を上書きしない
 * - `invalidatedAt` / `invalidatedReason` — 「恒常的に通らない」と確定した3つ目の
 *   状態（{@link AgentToken.invalidatedAt}）。**当面はここへ値を入れない**
 *   （人間の決定 2026-08-25: 種類で分けるのは記録までにして、扱いは一律で
 *   「時間で戻る」と仮定する）。⟹ `limitRecoveryOf` が `action` を返す文言でも、
 *   この関数は冷却へ倒す。**分類は記録されるが、まだ何も分岐させない**
 *
 * **`cooldownUntil` に過去の時刻が入りうる。** `resetsAt` が既に過ぎていれば
 * そのまま過去になる——**丸めて未来へ押し出さない。** 選ぶ側（PR3）は「過ぎて
 * いれば候補」として読むので、過去の値は「もう戻っている」を正しく表す。
 */
export function markTokenUnusable(
  token: AgentToken,
  observation: TokenFailureObservation,
): AgentToken {
  const cooldownUntil =
    observation.resetsAt ?? Date.parse(observation.at) + observation.fallbackCooldownMs;
  return {
    ...token,
    lastRejectedAt: observation.at,
    lastRejectedReason: observation.message,
    cooldownUntil,
    updatedAt: observation.at,
  };
}

/**
 * 使えることを確かめられたので、止まっていた記録を**消す**（純粋関数）。
 *
 * 消すのは4つ+1——`lastRejectedAt` / `lastRejectedReason` / `cooldownUntil` /
 * `invalidatedAt` / `invalidatedReason`。**`disabledAt` は消さない**（人間の判断）。
 *
 * **なぜ `invalidatedAt` まで消すのか。** 成功は権威ある証拠である——`clone.ts` が
 * 成功した `result` で `#usageBlocked` を降ろしているのと同じ根拠（逐語は
 * `grep -n 'ことの権威ある証拠なので' packages/core/src/clone.ts`）。通ったのに
 * 「恒常的に通らない」という印が残っている行は、**それ自体が嘘である。**
 *
 * **⚠️ 「使えることを確かめられた」の意味を薄めないこと。** 呼んでよいのは
 * 実際に通ったことを観測したときだけで、「たぶん戻ったはず」（冷却が明けた）で
 * 呼ぶと、この関数は**観測していない成功を記録する。** 冷却が明けたかどうかは
 * `cooldownUntil` を読めば分かるので、消す必要が無い。
 */
export function markTokenUsable(token: AgentToken, at: string): AgentToken {
  // **消す側を数え上げる（残す側ではない）。** 残す側を書き並べる形にすると、
  // {@link AgentToken} へ列が1つ増えたときに**それが黙って落ちる** — しかも
  // 落ちるのは「成功したとき」だけなので、いちばん気づきにくい経路で消える。
  // 消す側の数え上げなら、増えた列は既定で残る。
  const next: AgentToken = { ...token, updatedAt: at };
  delete next.lastRejectedAt;
  delete next.lastRejectedReason;
  delete next.cooldownUntil;
  delete next.invalidatedAt;
  delete next.invalidatedReason;
  return next;
}

/**
 * その行がいま使える見込みか。**観測ではなく、記録から読める範囲の判定である。**
 *
 * - `disabled`: 人間が外した（`disabledAt`）
 * - `invalidated`: 恒常的に通らないと確定している（`invalidatedAt`）
 * - `cooling`: 冷却中（`cooldownUntil` が `at` より後）
 * - `ready`: 上のどれでもない
 *
 * **`ready` は「通る」ではない。** 通るかどうかは観測しないと分からない
 * （Issue #393 の3値判定と `probeTokenCandidate` の領域）。ここが答えるのは
 * 「記録の上で候補から外す理由が無い」までである。
 */
export function tokenAvailabilityAt(
  token: AgentToken,
  at: number,
): 'disabled' | 'invalidated' | 'cooling' | 'ready' {
  if (token.disabledAt !== undefined) return 'disabled';
  if (token.invalidatedAt !== undefined) return 'invalidated';
  if (token.cooldownUntil !== undefined && token.cooldownUntil > at) return 'cooling';
  return 'ready';
}

/**
 * その行の最後の拒否が「時間で戻る」ものだったか。拒否の記録が無ければ `undefined`。
 *
 * `toAgentTokenView` が外向きの顔へ載せるのと**同じ導き方**である（保存しない。
 * 生の文言から毎回導く。理由は `agentTokenViewSchema` の `recovery` の doc）。
 */
export function tokenRecoveryOf(token: AgentToken): LimitRecovery | undefined {
  return token.lastRejectedReason === undefined
    ? undefined
    : limitRecoveryOf(token.lastRejectedReason);
}

// ---------------------------------------------------------------------------
// いま撒いてある現役（Issue #393 PR3）
// ---------------------------------------------------------------------------

/**
 * いま2か所（runner とクローン）へ撒いてあるトークンの指名。**高々1つ。**
 *
 * **プールの行とは別に持つ。** 行の側に `active: boolean` を置くと、**2行が同時に
 * 現役だと主張する形**が作れてしまう——「高々1つ」は行の集合では表せない。
 *
 * **設定（{@link TokenRotationSettings}）とも別に持つ。** あちらの `updatedAt` は
 * 「最後に人間かクローンが**設定**を変えた時刻」という意味を doc で背負っている
 * ので、回し手の書き込みを同じ行へ混ぜると、その意味が静かに壊れる
 * （デーモンが回すたびに「人間が設定を変えた」ことになる）。
 */
export const activeAgentTokenSchema = z.object({
  /** 現役のトークンの id。 */
  tokenId: z.string().min(1),
  /**
   * 世代。**回すたびに1つ増える。**
   *
   * これが要るのは、**同じ当たりで複数のマネージャーから通知が来ても回るのは
   * 1回だけ**にするためである（受け入れ基準）。id だけで照合すると、同じ
   * トークンが冷却明けにもう一度選ばれた後の遅れた通知を、**現役の通知として
   * 受け取ってしまう。**
   */
  generation: z.number().int().nonnegative(),
  /** 最後に回した（または最初に指名した）時刻（ISO 8601）。 */
  rotatedAt: z.string(),
});
export type ActiveAgentToken = z.infer<typeof activeAgentTokenSchema>;

// ---------------------------------------------------------------------------
// 器の環境変数を指す行（Issue #393）
// ---------------------------------------------------------------------------

/** 器の環境変数から資格を取る行か。**既定（`source` が無い行）は `stored` である。** */
export function isEnvToken(token: AgentToken): boolean {
  return token.source === 'env';
}

/**
 * その行を撒くときに、撒く側へ渡す形。**判別可能な union にしてある。**
 *
 * `value` を optional にしただけの形（`{ value?: string }`）にすると、**撒く側が
 * `value === undefined` を「取れなかった」と読んで握り潰す**余地が残る。ここでは
 * 「env を指している」ことが型として現れるので、撒く側は分岐を書かないと
 * コンパイルが通らない。
 */
export type TokenCredential = { kind: 'stored'; value: string } | { kind: 'env' };

/**
 * 行から撒く形を作る。**`stored` なのに `value` が無い行は壊れているので投げる。**
 *
 * 器（fs / pg）は `value` を optional として持てるので、「`stored` なのに値が無い」
 * 行が理屈の上では作れてしまう。**黙って env へ倒さないこと** —— 倒すと、値を
 * 失った行が「環境変数を使う行」に化けて、**どのトークンで走っているかが記録と
 * ずれる。**
 */
export function credentialOf(token: AgentToken): TokenCredential {
  if (isEnvToken(token)) return { kind: 'env' };
  if (token.value === undefined || token.value.length === 0) {
    // **id と label しか含めない**（`TokenPoolInputError` と同じ約束）。
    throw new TokenPoolInputError(
      `トークン（id ${token.id} / ${token.label}）は stored なのに値を持っていない`,
    );
  }
  return { kind: 'stored', value: token.value };
}

/**
 * 器の環境変数を指す行を作る（まだ無いときだけ呼ぶ）。
 *
 * **`order` は既存のどれよりも小さくする。** 環境変数のトークンは*いま走っている*
 * ものなので、**その残枠を使い切ってから予備へ回る**のが自然な順序である。逆に
 * すると、人間が予備を1本登録しただけで環境変数側の残枠を捨てることになる。
 *
 * **既存の行の `order` を振り直さないこと。** 振り直すと全行が「変わった」ことに
 * なり、`updatedAt` が一斉に動く（{@link AgentToken.updatedAt} が守っている意味が
 * 消える）。
 */
export function buildEnvToken(
  existing: readonly AgentToken[],
  options: { id: string; at: string; label?: string },
): AgentToken {
  const lowest = existing.reduce((min, token) => Math.min(min, token.order), 0);
  return {
    id: options.id,
    label: options.label ?? '器の環境変数',
    source: 'env',
    order: lowest - 1,
    createdAt: options.at,
    updatedAt: options.at,
  };
}
