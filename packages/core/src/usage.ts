import { z } from 'zod';

// 再輸出（下）とは別に、この中でも使うので取り込む。
import { USAGE_ESTIMATE_NOTICE, USAGE_LAYERS, USAGE_SITES, ZERO_USAGE } from './usage-format.js';
// `readSessionUsage` の締め切りに使う。**`usage-probe.ts` はこのファイルを
// import していない**（SDK の型だけを型 import している）ので、循環しない。
import { settleWithin } from './usage-probe.js';

/**
 * Claude の利用状況の台帳（消費した側の記録）。
 *
 * **ここに置くのは「alteroid が使った分」だけである。** アカウント全体の残り枠と
 * 支出上限は claude.ai 側の値で、`usage-snapshot.ts` が別に読む。**2つを足したり
 * 混ぜたりしないこと** — 前者は自分で数えた推定値、後者は向こうが言っている値で、
 * 一致する保証がない。
 *
 * ## 出所は `modelUsage` であって `usage` ではない
 *
 * SDK の `result` は両方を運ぶが、`usage` には型のコメントで
 * **「MAIN AGENT LOOP ONLY — excludes Task subagent, sidechain, and auxiliary model calls, and is per-turn in streaming-input sessions. Prefer modelUsage for token/cost accounting」** [sdk-verbatim SDKResultSuccess.usage] と書いてある。alteroid は委譲が主役
 * （クローン → マネージャー → 作業者）なので、`usage` を採ると**作業者の消費が
 * 丸ごと落ちる**。落ちるのは階層の末端＝いちばん数が多い層である。
 *
 * ## 累積値は足してはいけない
 *
 * 同じ型のコメントにこうある —
 * **「cumulative across turns in streaming-input sessions — each result carries the running total so far, so read the latest result rather than summing across results」** [sdk-verbatim SDKResultSuccess.total_cost_usd]。マネージャーは streaming-input で長く走るので、ターンごとの
 * `result` を足すと二重計上になる。**差分を取る。**
 *
 * さらに同じコメントが3つの落とし穴を明示している。
 *
 * - 「resumed sessions start fresh」 [sdk-verbatim SDKResultSuccess.total_cost_usd] — alteroid はデーモン再起動で resume する
 *   （AGENTS.md「デーモン再起動時の引き取りは2通り」）ので、**必ず踏む**
 * - 「a mid-session /clear resets the running total」 [sdk-verbatim SDKResultSuccess.total_cost_usd]
 * - 「Crash/startup-error results may carry zeroed values」 [sdk-verbatim SDKResultSuccess.total_cost_usd]
 *
 * 最後のものが一番危ない。ゼロを「累積が 0 になった」として採用すると、記録済みの
 * 消費が消える。**失敗が成功として観測されるのと同じ形の壊れ方**である。だから
 * **成功した `result` の値しか台帳へ入れない**（`runner.ts` の呼び出し側で絞る）。
 * ここまで絞れば、残る減少は resume か `/clear` — どちらも「新しい累積が 0 から
 * 始まった」なので、{@link foldUsageSnapshot} は減少を数え直しとして扱える。
 *
 * ## 推定値である
 *
 * 型のコメントに **「An estimate, not a billing statement」** [sdk-verbatim SDKResultSuccess.total_cost_usd] と明記されている。
 * **この一文を落とさないこと。** 台帳の数字を見せる口（API / CLI / Web / クローンの
 * 道具）はすべて {@link USAGE_ESTIMATE_NOTICE} を一緒に運ぶ。
 */

/**
 * 表示のための算術と整形は `usage-format.ts` にある。
 *
 * **実行時の依存を持たない形で切り出して `@alteroid/core/usage` として出している** —
 * ブラウザ（apps/web）が `index.ts` 経由で読むと、Node の組み込みと Claude Agent SDK を
 * 含む core 全体が初期チャンクに入る。ここから再輸出しているので、既存の読み手
 * （`@alteroid/core`）は何も変えなくてよい。
 */
export {
  ACCOUNT_USAGE_TITLE,
  USAGE_ESTIMATE_NOTICE,
  ZERO_USAGE,
  describeAccountUsage,
  describeUnrecordedManagers,
  findUnrecordedManagers,
  formatUsd,
  sumUsageRows,
  summarizeUsage,
  usageDate,
  type UnrecordedManager,
  type UnrecordedManagerCandidate,
} from './usage-format.js';

const isoDateTime = z.string().datetime({ offset: true });

/** 日付。ローカル時刻の `YYYY-MM-DD`（日報と同じ区切りに合わせる）。 */
export const usageDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD で書く');

/**
 * 1つの区切りぶんの消費量。トークンは整数、費用は USD。
 *
 * SDK の `ModelUsage` の写しだが、**`contextWindow` / `maxOutputTokens` は持たない**
 * （あれはモデルの仕様であって消費量ではない。台帳に混ぜると集計で足されうる）。
 */
export const usageTotalsSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cacheReadInputTokens: z.number().int().nonnegative(),
  cacheCreationInputTokens: z.number().int().nonnegative(),
  webSearchRequests: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative(),
});

export type UsageTotals = z.infer<typeof usageTotalsSchema>;

/**
 * **誰が**使ったか。
 *
 * モデル id では層を区別できない。`ALTEROID_CLONE_MODEL` でクローンを opus へ
 * 上げれば、クローンとマネージャーは台帳上で同じ `model` に並ぶ（いま偶然
 * fable / opus / sonnet に分かれているだけである）。**だからモデル名を層の
 * 代わりに使わないこと。**
 *
 * ## `worker`（作業者）という値が無い理由
 *
 * **取れないので値を作らない。** 作業者はマネージャーのセッションの中の Task
 * subagent であり、その消費はマネージャーの `result.modelUsage` に合算されて
 * 降りてくる。SDK の宣言（`sdk.d.ts` の `modelUsage`）が「every model call made through the query pipeline during this query() call — main loop, Task subagents, sidechains, and internal calls such as compaction」 [sdk-verbatim SDKResultSuccess.modelUsage] と言っており、
 * **分けて出す口が無い。**
 *
 * ここに `worker` を置いて 0 を積むのが最悪の選択である（「作業者は使って
 * いない」と読める）。だから値そのものを作らず、`manager` の側に「作業者の分を
 * 含む」と書く。`subagent_type` と `message.usage` から自前に数え直す道はあるが、
 * それは `modelUsage` と一致する保証の無い別会計になる（#45 が避けた形）。
 */
export const usageLayerSchema = z.enum(USAGE_LAYERS);

export type UsageLayer = z.infer<typeof usageLayerSchema>;

/**
 * **どこで**使ったか。
 *
 * - `session` — その層の SDK セッション本体。**そのセッションの compaction 自体の
 *   費用もここに混ざっている**（分離できない。下記）
 * - `distill` — 要約に潰される直前に走る蒸留（`clone.ts` の
 *   `#distillFromTranscript`）。**別の `query()` 呼び出し**なので分離できる
 *
 * ## `compaction`（要約そのもの）という値が無い理由
 *
 * **取れないので値を作らない。** 上と同じ一文が「internal calls such as compaction」 [sdk-verbatim SDKResultSuccess.modelUsage] を `modelUsage` に含むと明言していて、分けて出す口が無い。
 * 合図の側が運ぶのは大きさと回数だけである — `system`/`compact_boundary` の
 * `compact_metadata` に `trigger` / `pre_tokens` / `post_tokens` / `duration_ms`、
 * `PreCompactHookInput` に `trigger` / `custom_instructions`、
 * `PostCompactHookInput` に `trigger` / `compact_summary`。
 * **トークン単価も費用も1つも載っていない。**
 *
 * **`distill` を「要約そのものの費用」と読み替えないこと。** 別物である —
 * 蒸留は「潰される前に記憶へ移す」ための独立したターンであり、要約を作る推論
 * そのものではない。混ぜると、取れていないものを取れたことにする。
 *
 * `pre_tokens` に単価を掛けて推定する道は採らない（SDK が推定と言っている計算を
 * 二重に推定し直すことになる。#45 が明示的に捨てた道）。
 *
 * ## どの層にも出てこない消費がある
 *
 * 同じ一文が「Internal helper calls outside the query pipeline (e.g. the permission classifier, token-count probes) are excluded」 [sdk-verbatim SDKResultSuccess.modelUsage] と言っている。
 * **台帳の合計は「alteroid が使った分の全部」ではない。**
 */
export const usageSiteSchema = z.enum(USAGE_SITES);

export type UsageSite = z.infer<typeof usageSiteSchema>;

/**
 * 台帳でクローンを名指す actor の id。
 *
 * 台帳の actor 列は `managerId` という名前のままである（既存の行・API・CLI・
 * 画面が読んでいる名前を変えるのは別の作業になる）。**名前はマネージャーの
 * ものだが、意味は「誰の分か」の一般名である** — どの層の分かは `layer` が言う。
 *
 * マネージャーの id は `mgr-` に続けて発行される（`manager.ts`）ので、この値
 * （接頭辞を持たない）とは衝突しない。**衝突しないことは偶然ではなく、
 * テストで固定してある。** ただしこれが固定しているのは `mgr-` 名前空間と
 * この値が衝突しないことだけである — `mgr-` 名前空間の内部の一意性は
 * `manager.ts` の `#claimManagerId` の doc が持つ（#238）。
 */
export const CLONE_ACTOR_ID = 'clone';

/**
 * クローンが**自分の道具の中で起こしたサブエージェント**を名指す接頭辞。
 *
 * クローンは preset 一式を持つので `Task` も持っている（#32）。その中の道具実行は
 * クローンの手ではあるが「クローン自身が直接叩いた」ではないので、
 * `clone:sub:<agent>` として区別する（runner が `manager:<id>` と
 * `worker:<id>:<agent>` を分けているのとまったく同じ理由 — 分けないと
 * 「自分でやったのか委ねたのか」の問いに嘘の数が返る）。
 *
 * **これは委譲（マネージャー）とは別物である。** マネージャーへ出した仕事は
 * `manager:<id>` / `worker:<id>:<agent>` で載る。
 */
export const CLONE_SUB_ACTOR_PREFIX = `${CLONE_ACTOR_ID}:sub:`;

/**
 * 蒸留のサイドクエリ（要約に潰される直前の内部ターン）で動いた手。
 *
 * 本セッションと**別の SDK セッション**なので分けて名乗る。混ぜると
 * 「会話の中で自分で動いた」と「記憶へ移すために動いた」が同じ数になる。
 */
export const CLONE_DISTILL_ACTOR_ID = `${CLONE_ACTOR_ID}:distill`;

/**
 * 日誌の `tool_use.actor` が「クローン自身の手」を指しているか。
 *
 * **前方一致で判定する。** いま `clone` / `clone:sub:<agent>` / `clone:distill` の
 * 3種類があり、どれもマネージャー（`manager:<id>` / `worker:<id>:<agent>`）とは
 * 接頭辞で分かれる。**`=== CLONE_ACTOR_ID` で書かないこと** — 増えた枝が
 * 「委譲した量」の側へ落ちて、委譲の判断に使う数が静かにずれる。ここを1本に
 * してあるのは、枝を足すたびに全呼び出し元を直す必要が無いようにするためである。
 */
export function isCloneActor(actor: string): boolean {
  return actor === CLONE_ACTOR_ID || actor.startsWith(`${CLONE_ACTOR_ID}:`);
}

/**
 * 累積の器がどこで閉じるか。**`site` から導出しないこと。**
 *
 * 累積は SDK の `query()` 呼び出しの寿命で閉じる（`sdk.d.ts`: 「Per-model totals for every model call made through the query pipeline during this query() call」 [sdk-verbatim SDKResultSuccess.modelUsage]）。**どこで使ったかでは
 * 決まらない** — 同じ `site` でも寿命の違う呼び出しはありうる。
 *
 * - `cumulative` — streaming-input の長寿命セッション（クローン本体・マネージャー）。
 *   `result` は「その時点までの走行合計」なので、**基準との差だけ**を積む
 * - `oneshot` — 1回で閉じる `query()`（蒸留のサイドクエリ）。`result` がその
 *   呼び出しの総量そのものなので、**基準を持たずそのまま**積む
 */
export const usageAccumulationSchema = z.enum(['cumulative', 'oneshot']);

export type UsageAccumulation = z.infer<typeof usageAccumulationSchema>;

/**
 * `result.modelUsage` をそのまま写した、その時点の**累積**。
 *
 * **これは事実であって解釈ではない。** runner から降りてくるのはこの形で、差分に
 * するのはデーモン側である（runner-protocol.ts「ここに流れるのは事実だけである」）。
 * 差分を runner で作ると、イベントが再送されたときに二重計上になる — 累積値なら
 * 同じものが2回届いても増分が 0 になるだけで済む。
 */
export const usageSnapshotSchema = z.object({
  /**
   * SDK のセッション id。累積が数え直された事実の記録に添えるためだけに持つ。
   *
   * **これで数え直しを判定しないこと。** resume は同じ session id のまま累積を
   * 0 に戻すので、session id が変わったかどうかは判定材料にならない。
   */
  sessionId: z.string().optional(),
  /** モデル id → その時点の累積。 */
  models: z.record(z.string(), usageTotalsSchema),
});

export type UsageSnapshot = z.infer<typeof usageSnapshotSchema>;

/**
 * 前回読んだ累積（差分を取るための基準）。**累積を持つ主体1つにつき1つ。**
 *
 * 主体は「層 × actor」である（`(layer, managerId)`）。actor の id だけを鍵に
 * すると、層をまたいで同じ id が来たときに別の累積が1つの基準を共有し、差分が
 * まるごと嘘になる。いまは `mgr-` と `clone` で衝突しないが、**衝突しないことに
 * 頼らず鍵の側で閉じる。**
 *
 * `oneshot`（蒸留のサイドクエリ）はここに行を持たない — 累積が `query()` 1回で
 * 閉じるので、比べる相手がそもそも無い。
 */
export const usageBaselineSchema = z.object({
  layer: usageLayerSchema,
  managerId: z.string(),
  sessionId: z.string().optional(),
  models: z.record(z.string(), usageTotalsSchema),
  updatedAt: isoDateTime,
  /** 数え直しを検知した回数。**黙って数え直さない**ための記録。 */
  resets: z.number().int().nonnegative(),
  lastResetAt: isoDateTime.optional(),
});

export type UsageBaseline = z.infer<typeof usageBaselineSchema>;

/**
 * 累積が数え直された事実。
 *
 * **黙って数え直すと、後から「なぜ集計が飛んでいるか」が分からない。** 起きたことは
 * 起きたこととして残す（日誌にも落とす）。
 */
export const usageResetSchema = z.object({
  at: isoDateTime,
  /** 数え直し前の累積費用の合計（USD）。どれだけの高さから落ちたか。 */
  fromCostUsd: z.number().nonnegative(),
  /** 数え直し後の累積費用の合計（USD）。 */
  toCostUsd: z.number().nonnegative(),
  /** 直前の session id と今の session id（変わっていれば別セッションで開き直した）。 */
  fromSessionId: z.string().optional(),
  toSessionId: z.string().optional(),
});

export type UsageReset = z.infer<typeof usageResetSchema>;

/** {@link foldUsageSnapshot} の結果。 */
export interface UsageFold {
  /** 台帳へ加算する増分（モデル id → 増分）。**負にはならない。** */
  delta: Record<string, UsageTotals>;
  /**
   * 次回の基準。**`oneshot` では null**（累積が1回で閉じるので基準を持たない）。
   */
  baseline: UsageBaseline | null;
  /** 数え直しが起きたならその事実。起きていなければ undefined。 */
  reset?: UsageReset;
}

function sumCostUsd(models: Record<string, UsageTotals>): number {
  return Object.values(models).reduce((sum, m) => sum + m.costUsd, 0);
}

/**
 * 累積が数え直されたか。
 *
 * 判定は2つ。**どれか1つのモデルでも減った**か、**基準にあったモデルが消えた**か。
 * どちらも「別の累積が始まった」ことを意味する。session id は見ない（resume は
 * 同じ id のまま 0 に戻る）。
 */
function detectReset(
  prev: Record<string, UsageTotals>,
  next: Record<string, UsageTotals>,
): boolean {
  for (const [model, before] of Object.entries(prev)) {
    const after = next[model];
    if (after === undefined) return true;
    if (
      after.inputTokens < before.inputTokens ||
      after.outputTokens < before.outputTokens ||
      after.cacheReadInputTokens < before.cacheReadInputTokens ||
      after.cacheCreationInputTokens < before.cacheCreationInputTokens ||
      after.webSearchRequests < before.webSearchRequests ||
      after.costUsd < before.costUsd
    ) {
      return true;
    }
  }
  return false;
}

function subtract(after: UsageTotals, before: UsageTotals): UsageTotals {
  // **引き算で負にしない。** 減少は上で数え直しとして扱っているので通常ここへは
  // 来ないが、片方のフィールドだけが動く形の値が来ても台帳を汚さないようにする。
  return {
    inputTokens: Math.max(0, after.inputTokens - before.inputTokens),
    outputTokens: Math.max(0, after.outputTokens - before.outputTokens),
    cacheReadInputTokens: Math.max(0, after.cacheReadInputTokens - before.cacheReadInputTokens),
    cacheCreationInputTokens: Math.max(
      0,
      after.cacheCreationInputTokens - before.cacheCreationInputTokens,
    ),
    webSearchRequests: Math.max(0, after.webSearchRequests - before.webSearchRequests),
    costUsd: Math.max(0, after.costUsd - before.costUsd),
  };
}

function isZero(totals: UsageTotals): boolean {
  return (
    totals.inputTokens === 0 &&
    totals.outputTokens === 0 &&
    totals.cacheReadInputTokens === 0 &&
    totals.cacheCreationInputTokens === 0 &&
    totals.webSearchRequests === 0 &&
    totals.costUsd === 0
  );
}

/**
 * 1つでも動いているモデルがあるか（空の記録と、本当にゼロの記録を区別する）。
 *
 * **読む側が2つある。** 台帳へ畳む側（{@link foldUsageSnapshot}）は「ゼロを基準として
 * 採用しない」ために使い、runner は「ゼロのスナップショットを降ろさない」ために使う
 * （`runner.ts` の `#flushUsage`）。**同じ述語を2か所に書き写さないこと** — 片方だけ
 * 直すと、ゼロの扱いが層で食い違う。
 */
export function hasAnyUsage(models: Record<string, UsageTotals>): boolean {
  return Object.values(models).some((totals) => !isZero(totals));
}

/**
 * 累積スナップショットを増分へ畳む。**純関数**（ストアはこれを1操作の中で使う）。
 *
 * 数え直しを検知したときの増分は **スナップショットの全量** である。0 ではない。
 * 新しい累積は 0 から始まっているので、そこに載っている分はまだ台帳に無い消費で
 * ある。ここを 0 にすると、resume 後の1回目のターンぶんが黙って消える。
 *
 * 例: 累積 $5.00 まで記録 → resume で 0 に戻る → 次に読めた累積が $3.00
 *  → 数え直しとして $3.00 を加算する。台帳の合計は $8.00 で、実際に使った額と合う。
 *
 * **全部ゼロのスナップショットは「情報なし」として捨てる**（基準を持っているとき）。
 * SDK は「Crash/startup-error results may carry zeroed values」 [sdk-verbatim SDKResultSuccess.total_cost_usd] と言っている。ゼロを
 * 数え直しとして採用すると基準が 0 まで下がり、**次に届いた本物の累積がまるごと
 * 増分になって二重計上になる**（記録済みの $5.00 がもう一度積まれる）。
 *
 * 捨てても取りこぼさない。累積値だからである — 本物の resume なら次に届く非ゼロの
 * 累積が基準より低いので、そこで数え直しとして正しく拾える。クラッシュの記録なら
 * 次の成功が同じ累積を運んでくるので増分 0 で済む。**どちらの経路も正しくなる。**
 */
export function foldUsageSnapshot(
  baseline: UsageBaseline | null,
  snapshot: UsageSnapshot,
  at: string,
): UsageFold {
  const prev = baseline?.models ?? {};
  const next = snapshot.models;

  if (baseline !== null && hasAnyUsage(prev) && !hasAnyUsage(next)) {
    return { delta: {}, baseline };
  }

  const reset = baseline !== null && detectReset(prev, next);

  const delta: Record<string, UsageTotals> = {};
  for (const [model, totals] of Object.entries(next)) {
    const increment = reset ? totals : subtract(totals, prev[model] ?? ZERO_USAGE);
    // 増えていないモデルの行を作らない（台帳が 0 の行で埋まる）。
    if (!isZero(increment)) delta[model] = increment;
  }

  return {
    delta,
    baseline: {
      // layer / managerId は基準が無ければ空で返す。**呼び出し側が知っている値を
      // 後から入れる契約**である（ストアの record が入れる）。純関数の側で層を
      // 推測させないためで、推測させると「どの層の基準か」が2か所で決まる。
      layer: baseline?.layer ?? 'manager',
      managerId: baseline?.managerId ?? '',
      sessionId: snapshot.sessionId ?? baseline?.sessionId,
      models: next,
      updatedAt: at,
      resets: (baseline?.resets ?? 0) + (reset ? 1 : 0),
      lastResetAt: reset ? at : baseline?.lastResetAt,
    },
    reset: reset
      ? {
          at,
          fromCostUsd: sumCostUsd(prev),
          toCostUsd: sumCostUsd(next),
          fromSessionId: baseline?.sessionId,
          toSessionId: snapshot.sessionId,
        }
      : undefined,
  };
}

/**
 * **1回で閉じる `query()`** の `result` を増分へ畳む。**純関数。**
 *
 * 蒸留のサイドクエリ（`clone.ts` の `#distillFromTranscript`）は毎回新しい
 * `query()` で、`persistSession: false`・resume なしである。SDK の宣言が累積の
 * 器を「during this query() call」 [sdk-verbatim SDKResultSuccess.modelUsage] と言っているので、**その `result` はその1回の
 * 総量そのもの**であり、前回の値との差ではない。
 *
 * **ここに基準を持たせてはいけない。** 持たせると壊れ方が片側だけになる —
 * 前回 $0.05 で今回 $0.08 の回は差の $0.03 しか積まれず（目減り）、前回 $0.05 で
 * 今回 $0.02 の回は減少なので数え直しとして全量が積まれる。つまり
 * **高くついた回だけが黙って縮む。** 失敗が成功として観測される形である。
 *
 * ゼロの `result`（「Crash/startup-error results may carry zeroed values」 [sdk-verbatim SDKResultSuccess.total_cost_usd]）は
 * 0 の行を作らずに落ちる（`isZero` の判定は {@link foldUsageSnapshot} と同じ）。
 */
export function foldOneshotUsage(snapshot: UsageSnapshot): UsageFold {
  const delta: Record<string, UsageTotals> = {};
  for (const [model, totals] of Object.entries(snapshot.models)) {
    if (!isZero(totals)) delta[model] = totals;
  }
  return { delta, baseline: null };
}

// ---------------------------------------------------------------------------
// SDK の result から消費を読む
// ---------------------------------------------------------------------------

/** トークン数として読む。読めないものは 0。 */
function tokenCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/** 金額として読む。読めないものは 0。 */
function usdAmount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * 「1ターンを最後まで走り切った」結果か。
 *
 * **台帳へ通すのは成功した result だけである。** SDK は
 * 「Crash/startup-error results may carry zeroed values」 [sdk-verbatim SDKResultSuccess.total_cost_usd] と言っている。ゼロを
 * 「累積が 0 になった」として通すと基準が下がり、次に届いた本物の累積が丸ごと
 * 増分になる ＝ 記録済みの分がもう一度積まれる。
 *
 * **絞っても取りこぼさない。** 値は累積なので、失敗した回のぶんも次の成功が
 * 運んでくる。
 */
export function isSuccessResult(message: unknown): boolean {
  return (message as { subtype?: unknown }).subtype === 'success';
}

/**
 * `result.modelUsage` をモデル id → 累積の形へ写す。**`result.usage` は使わない。**
 *
 * SDK の型コメントがはっきり分けている — `usage` は
 * **MAIN AGENT LOOP ONLY（Task subagent / sidechain を除く）** で、`modelUsage` が
 * **「The correct field for token/cost accounting」** [sdk-verbatim SDKResultSuccess.modelUsage]（メインループ・Task 作業者・
 * sidechain・compaction を全部含む）。alteroid は委譲が主役なので、`usage` を採ると
 * **作業者の消費が丸ごと落ちる**。落ちるのは階層の末端＝いちばん数が多い層である。
 *
 * `contextWindow` / `maxOutputTokens` は写さない（モデルの仕様であって消費量では
 * ないので、台帳に入れると集計で足されうる）。
 *
 * **クローン（`clone.ts`）とマネージャー（`runner.ts`）が同じこれを呼ぶ。**
 * 層ごとに写し取りを書くと、どちらかが SDK の綴り（`costUSD` の大文字）を
 * 取り違えたときに片方だけ 0 が積まれ、その差は「その層は安い」と読める。
 */
export function modelUsageOf(message: unknown): Record<string, UsageTotals> | undefined {
  return toModelTotals((message as { modelUsage?: unknown }).modelUsage);
}

/**
 * control channel の `get_usage` 応答から、**このセッションの累積**を取り出す。
 *
 * 出所は `SDKControlGetUsageResponse.session.model_usage`（SDK 0.3.261 の `sdk.d.ts`
 * で確認）。型は `result.modelUsage` と同じ `Record<string, ModelUsage>` で、
 * **意味も同じ累積**である。違うのは `result` を待たずに読めることだけで、だから
 * 「`result` を出さずに死んだセッション」の消費はここからしか取れない
 * （{@link readSessionUsage}）。
 *
 * **枠の利用率（`rate_limits`）と混ぜないこと。** 同じ応答に載っているが、あちらは
 * アカウント全体の話で、台帳（自分が使った分の推定）とは別物である
 * （`usage-snapshot.ts` が使い捨ての probe から読んでいる）。
 */
export function sessionModelUsageOf(response: unknown): Record<string, UsageTotals> | undefined {
  if (typeof response !== 'object' || response === null) return undefined;
  const session = (response as { session?: unknown }).session;
  if (typeof session !== 'object' || session === null) return undefined;
  return toModelTotals((session as { model_usage?: unknown }).model_usage);
}

/**
 * control channel の `get_usage` だけを抜き出した顔。
 *
 * **省略可能にしてある。** 実験的な口（長い名前のあれ）は SDK 側で改名・削除され
 * うるので、無くなったときに「取れなかった」へ落ちるだけで済むようにする
 * （`usage-probe.ts` の `UsageProbeHandle` と同じ判断）。SDK の `Query` 型では
 * 必須メンバだが、**必須として呼ぶと SDK が1つ改名した瞬間に畳む経路が落ちる。**
 */
export interface SessionUsageReader {
  usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET?: () => Promise<unknown>;
}

/**
 * 畳む直前の累積読み取りに与える締め切り。
 *
 * **短くする。** これは観測であって仕事ではないうえ、走っているのは「もう畳むと
 * 決まった後」である。runner 全体の猶予（`apps/runner/src/index.ts` の
 * `SHUTDOWN_GRACE_MS`）はセッション全部で分け合うものなので、1本がここで粘ると
 * 他の本の生ログを渡す時間を食う。**取れなければ取れないままでよい。**
 *
 * これは能力の上限ではなく観測の締め切りである（north_star 禁止2 が禁じているのは
 * 仕事の回数・ターン数の制限であって、best-effort な読み取りの待ち時間ではない）。
 */
export const SESSION_USAGE_READ_TIMEOUT_MS = 5_000;

/**
 * **畳む直前に、このセッションの累積を control channel から1回読む。**
 *
 * ## なぜ層が2つとも同じこれを呼ぶのか（片方を消さないための逐語）
 *
 * 台帳へ入るのは成功した `result` の消費だけである（`modelUsageOf` と
 * `isSuccessResult`）。⟹ **`result` を出さずに終わったセッションは1行も残さない。**
 * `runner.ts` の `#finish` はこれを逐語でこう言っている——「ここを通るのは
 * クラッシュ・`lost`・`failed`、つまり **`result` が出ないまま終わる経路そのもの
 * である**」。
 *
 * **同じ理由がクローン層にも掛かる。** クローンの台帳は累積（`accumulation:
 * 'cumulative'`）なので、セッションが生きているあいだは次の成功ターンが取り戻す。
 * **取り戻せないのはセッションごと死んだときである** —— 新しいセッションは累積 0
 * から始まるので `detectReset` が真になり、増分は新しい累積そのものになる
 * （`foldUsageSnapshot`）。⟹ **前のセッションの、最後に記録できた点から死ぬまでの
 * ぶんは二度と積まれない。** 枠切れ（429）でセッションが落ちるたびに、その末尾が
 * 落ちる。
 *
 * ⟹ **層ごとに片方だけ在る状態にしないこと。** 片方だけ直っていると、直って
 * いない側の欠落は「使っていない」と読める（AGENTS.md 地雷表「取れない軸に 0 の
 * 行を作る」の、値すら作らない側の顔である）。呼び手は
 * `runner.ts` の `#flushUsage` と `clone.ts` の `#flushSessionUsage` の2つで、
 * **どちらも「閉じる前」に置く。**
 *
 * ## 契約
 *
 * - **`close()` より先に呼ぶこと。** 閉じた後の control channel からは何も取れない
 * - **投げない。** 口が無い / 呼んだ瞬間に投げる / 返事が来ない のどれでも
 *   `undefined` を返す。**畳む経路を観測に縛らない**
 * - **全部ゼロなら `undefined` を返す**（`hasAnyUsage`）。「記録が無い」が
 *   「$0.00 使った」に化けないため
 */
export async function readSessionUsage(
  handle: unknown,
): Promise<Record<string, UsageTotals> | undefined> {
  const reader = handle as SessionUsageReader | null;
  const read = reader?.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET;
  if (reader === null || reader === undefined || typeof read !== 'function') return undefined;
  let answer: Promise<unknown>;
  try {
    answer = read.call(reader);
  } catch {
    // 呼んだ瞬間に投げる形（transport が既に閉じている）もある。
    return undefined;
  }
  const models = sessionModelUsageOf(await settleWithin(answer, SESSION_USAGE_READ_TIMEOUT_MS));
  if (models === undefined || !hasAnyUsage(models)) return undefined;
  return models;
}

/**
 * `Record<model, ModelUsage>` を台帳の形へ写す。
 *
 * **入口が2つあるので1つに寄せてある。** ターン終わりの `result.modelUsage`
 * （{@link modelUsageOf}）と、畳む直前に control channel から読む
 * `session.model_usage`（{@link sessionModelUsageOf}）は同じ `ModelUsage` の写しで
 * ある。**書き写すと、片方だけ `costUSD` の綴りを直してもう片方が黙って 0 を積む**
 * という形で壊れる。
 */
function toModelTotals(raw: unknown): Record<string, UsageTotals> | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;

  const models: Record<string, UsageTotals> = {};
  for (const [model, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== 'object' || value === null) continue;
    const usage = value as Record<string, unknown>;
    models[model] = {
      inputTokens: tokenCount(usage.inputTokens),
      outputTokens: tokenCount(usage.outputTokens),
      cacheReadInputTokens: tokenCount(usage.cacheReadInputTokens),
      cacheCreationInputTokens: tokenCount(usage.cacheCreationInputTokens),
      webSearchRequests: tokenCount(usage.webSearchRequests),
      // SDK 側の綴りは `costUSD`（他のフィールドと違って大文字）。
      costUsd: usdAmount(usage.costUSD),
    };
  }
  return models;
}

// ---------------------------------------------------------------------------
// 台帳の行と問い合わせ
// ---------------------------------------------------------------------------

/**
 * 台帳の1行。**日 × actor × モデル × 層 × 場所**の5軸で、増分を足し込んだもの。
 *
 * 5軸とも要る — 「今日いくら使ったか」（日）、「どの委譲が高かったか」（actor）、
 * 「どのモデル帯か」（モデル）、「**誰が**使ったか」（層）、「**どこで**使ったか」（場所）。
 *
 * ## 層と場所を鍵から外さないこと
 *
 * 同じ actor が層または場所をまたいで使う。クローンは自分のセッション本体
 * （`clone` / `session`）と要約の蒸留（`clone` / `distill`）の両方で使うので、
 * `(date, managerId, model)` だけを鍵にすると**同じ鍵に別の意味の行が2つ立つ。**
 * そのとき増分は先にある行へ足し込まれ、`layer` / `site` は先に入った側の値の
 * まま残る ＝ **黙った誤帰属**であり、出力からは正しい行と区別できない。
 *
 * ## モデル id を層の代わりに使わないこと
 *
 * `ALTEROID_CLONE_MODEL` を置けばクローンとマネージャーは同じ `model` に並ぶ。
 * いま fable / opus / sonnet に分かれているのは偶然である。
 */
export const usageRowSchema = z.object({
  date: usageDateSchema,
  /**
   * 誰の分か（actor の id）。マネージャーなら `mgr-…`、クローンなら
   * {@link CLONE_ACTOR_ID}。**列名は `managerId` のままだが意味は一般名である。**
   */
  managerId: z.string(),
  model: z.string(),
  layer: usageLayerSchema,
  site: usageSiteSchema,
  /**
   * **どの認証トークンで**使ったか（`AgentToken.id`。Issue #393 受け入れ基準6）。
   *
   * **無いことに意味がある。省略可能なのはそのためである。** プールを使っていない
   * 器（器の環境変数だけ）では現役の指名が無いので、ここは埋まらない。埋めると
   * 「そのトークンで使った」という**していない観測**を作ることになる（AGENTS.md
   * 地雷表「取れない軸に 0 の行を作る」の同型 — 0 の代わりに id を捏造する形）。
   *
   * **どこからが観測かは {@link usageAggregateSchema} の `tokensSince` が持つ。**
   * `layer` / `site` と違って、**この軸は「後から入った」だけでなく「構成によって
   * そもそも取れない」。** だから始点は最初の record では入らず、**本物の帰属を
   * 1件記録したときにだけ**入る（`layeredAt` との違い。storage 側の doc も参照）。
   */
  tokenId: z.string().min(1).optional(),
  totals: usageTotalsSchema,
  updatedAt: isoDateTime,
});

export type UsageRow = z.infer<typeof usageRowSchema>;

export const usageQuerySchema = z.object({
  /** この日以降（含む）。 */
  from: usageDateSchema.optional(),
  /** この日まで（含む）。 */
  to: usageDateSchema.optional(),
  /** この actor だけ（マネージャーの id か {@link CLONE_ACTOR_ID}）。 */
  managerId: z.string().optional(),
  /**
   * この層だけ。
   *
   * **絞り込みを4つの口（API / CLI / Web / クローンの道具）に揃えて置くこと。**
   * 片方にだけ足すと、そこにしかできない分析が生まれる（PRD「インターフェース」）。
   */
  layer: usageLayerSchema.optional(),
  /** この場所だけ。 */
  site: usageSiteSchema.optional(),
  /**
   * この認証トークンだけ（`AgentToken.id`）。
   *
   * **帰属が無い行を引く手はここに作らない。** 「トークン軸が空の行だけ」を絞れる
   * 形にすると、その集合が「そのトークンで使った分」と並んで1つの選択肢に見える。
   * 取れていない分を数えたいなら、絞らずに引いて `byToken` の `null` を見る
   * （{@link usageBreakdownSchema}）。
   */
  tokenId: z.string().min(1).optional(),
});

export type UsageQuery = z.infer<typeof usageQuerySchema>;

/**
 * 集計の答え。
 *
 * **`since` を必ず添える。** 台帳が始まる前を照会されたら 0 ではなく「記録が無い」と
 * 言えるようにするためである。過去分の掘り起こしはやらないと決めた（SDK が推定と
 * 言っている計算を、単価を自前で掛けて二重に推定し直すことになる。当時の単価を
 * 正しく持つのも無理）。だからこそ**始点を黙って隠さない**。
 */
export const usageAggregateSchema = z.object({
  rows: z.array(usageRowSchema),
  /** 台帳が記録を始めた時刻。1件も記録していなければ null。 */
  since: isoDateTime.nullable(),
  /**
   * **層と場所の軸**が記録を始めた時刻。まだ1件も記録していなければ null。
   *
   * `since` とは別に持つ。台帳（#45）より層の軸（この変更）のほうが後から入った
   * ので、その間の行には `layer='manager'` / `site='session'` が**既定として**
   * 入っている。それは観測ではない。ここを `since` と1つにすると、層を足す前の
   * 期間が「クローンは使っていなかった」「蒸留は起きていなかった」と読めてしまう。
   */
  layersSince: isoDateTime.nullable(),
  /**
   * 照会された範囲の一部（または全部）が台帳の始点より前だったか。
   *
   * **真なら「その範囲は 0 ではなく記録が無い」と言うこと。** 数字だけを見せると、
   * 台帳が無かった期間が「使っていない期間」に見える。
   */
  beforeLedger: z.boolean(),
  /**
   * 照会された範囲の一部（または全部）が**層の軸**の始点より前だったか。
   *
   * **真なら「その範囲の層と場所は既定値であって観測ではない」と言うこと。**
   * `beforeLedger` と同じ形の但し書きだが、守っているものが違う — あちらは
   * 「合計が 0 なのか記録が無いのか」、こちらは「層の内訳が本物か既定値か」である。
   */
  beforeLayers: z.boolean(),
  /**
   * **認証トークンの軸**が記録を始めた時刻。まだ1件も**帰属付きで**記録して
   * いなければ null（Issue #393 受け入れ基準6）。
   *
   * **`layersSince` と同じ形だが、null の意味が1つ多い。** あちらの null は
   * 「台帳へまだ1件も積んでいない」だけだが、こちらは**それに加えて**「プールを
   * 使っていないので、積んでいても帰属が取れない」を含む。だから
   * **`since` が非 null でもここは null でありうる** — それが既定の構成である
   * （受け入れ基準7: プールが空の器の挙動を1文字も変えない）。
   */
  tokensSince: isoDateTime.nullable(),
  /**
   * 照会された範囲の一部（または全部）が**認証トークンの軸**の始点より前だったか。
   *
   * **真なら「その範囲にトークンの帰属は無い」と言うこと。** `beforeLayers` は
   * 「内訳が既定値である」と言うが、こちらは**内訳がそもそも無い**と言う。
   * 0 でも既定値でもなく、**取れていない**である。
   */
  beforeTokens: z.boolean(),
  /** 数字に必ず添える但し書き。 */
  notice: z.literal(USAGE_ESTIMATE_NOTICE),
});

export type UsageAggregate = z.infer<typeof usageAggregateSchema>;

/**
 * 5軸それぞれの内訳。**4つの口（API / CLI / Web / クローンの道具）が共有する。**
 *
 * 各口で足し直すと、どれか1つの丸め方や取りこぼしが他と食い違い、「CLI では
 * $3 なのに画面では $2.9」という形で信用を失う。算術はここに1つだけ置く。
 */
export const usageBreakdownSchema = z.object({
  total: usageTotalsSchema,
  byDate: z.array(z.object({ date: usageDateSchema, totals: usageTotalsSchema })),
  byManager: z.array(z.object({ managerId: z.string(), totals: usageTotalsSchema })),
  /** どのモデル帯（Fable / Opus / Sonnet）で使ったか。 */
  byModel: z.array(z.object({ model: z.string(), totals: usageTotalsSchema })),
  /**
   * **誰が**使ったか。
   *
   * **出てこない層を 0 で補わない。** 記録が1件も無い層はここに現れない
   * （`worker` はそもそも値として存在しない — {@link usageLayerSchema}）。
   */
  byLayer: z.array(z.object({ layer: usageLayerSchema, totals: usageTotalsSchema })),
  /**
   * **どこで**使ったか。
   *
   * **出てこない場所を 0 で補わない**（`compaction` はそもそも値として存在しない
   * — {@link usageSiteSchema}）。
   */
  bySite: z.array(z.object({ site: usageSiteSchema, totals: usageTotalsSchema })),
  /**
   * **どの認証トークンで**使ったか（Issue #393 受け入れ基準6）。
   *
   * **`tokenId` が `null` の要素は「取れていない分」であって、消さない。** 落とすと
   * この軸だけ `total` に足し合わなくなり、**読み手からはそれが分からない**（どの
   * 軸も出てこない値を 0 で補わない約束なので、「足りない」ことに気づく手がかりが
   * 無い）。**値を作らず、取れないことを出力に出す**のがここの形である
   * （AGENTS.md 地雷表）。`null` は行が実際に持っていない事実であって、捏造した
   * 分類ではない。
   *
   * **出てこないトークンを 0 で補わないこと**は他の軸と同じ — プールに居るが
   * 使われていないトークンはここに現れない（現れたら「0 使った」に見える）。
   */
  byToken: z.array(z.object({ tokenId: z.string().min(1).nullable(), totals: usageTotalsSchema })),
});

export type UsageBreakdown = z.infer<typeof usageBreakdownSchema>;
