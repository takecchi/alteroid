import { z } from 'zod';

import { fingerprintOf } from './credentials.js';

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
  /** 本体。**API・CLI・Web・日誌・ログのどこにも出さない。** */
  value: string;
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
  /** 指紋。`fingerprintOf`（`credentials.ts`）と同じ形——値そのものは出さない。 */
  sha256: z.string(),
  disabledAt: z.string().optional(),
  cooldownUntil: z.number().optional(),
  lastRejectedAt: z.string().optional(),
  lastRejectedReason: z.string().optional(),
  invalidatedAt: z.string().optional(),
  invalidatedReason: z.string().optional(),
});
export type AgentTokenView = z.infer<typeof agentTokenViewSchema>;

/** {@link AgentToken} から外向きの顔を作る。**`value` は指紋にしてから捨てる。** */
export function toAgentTokenView(token: AgentToken): AgentTokenView {
  return agentTokenViewSchema.parse({
    id: token.id,
    label: token.label,
    order: token.order,
    sha256: fingerprintOf(token.value),
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
        throw new Error(`トークンの id が入力の中で重複している: ${input.id}`);
      }
      seenIds.add(input.id);
    }

    const current = input.id === undefined ? undefined : byId.get(input.id);
    if (input.id !== undefined && current === undefined) {
      throw new Error(`id ${input.id} のトークンは既存の行に無い（消えた行を静かに作り直さない）`);
    }

    const value = input.value ?? current?.value;
    if (value === undefined) {
      throw new Error(
        `新しいトークン（${input.label}）には value が要る` +
          '（省略できるのは、id で既存の行を指しているときだけ）',
      );
    }

    const disabledAt =
      input.disabled === undefined
        ? current?.disabledAt
        : input.disabled
          ? (current?.disabledAt ?? options.now().toISOString())
          : undefined;

    const id = current?.id ?? input.id ?? options.newId();
    const order = input.order ?? index;

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
