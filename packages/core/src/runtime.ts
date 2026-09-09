import { systemClock } from "./clock.js";
import type { Clock } from "./interfaces/clock.js";
import type { Ctx } from "./ctx.js";
import { buildNewMemoryFromCandidate, extractCandidates } from "./extraction.js";
import type {
  ExtractedMemoryCandidate,
  ExtractionFailure,
  ExtractionOutcome,
} from "./extraction.js";
import { heuristicTokenCounter } from "./heuristic-token-counter.js";
import type { EmbeddingProvider } from "./interfaces/embedding-provider.js";
import type { EventStore } from "./interfaces/event-store.js";
import type { LLMProvider } from "./interfaces/llm-provider.js";
import type {
  MemoryStore,
  RequeueEmbedJobsOptions,
  RequeueEmbedJobsResult,
} from "./interfaces/memory-store.js";
import type { ClaimOutboxJobsOptions, OutboxStore } from "./interfaces/outbox-store.js";
import type { OutboxJobKind } from "./interfaces/scheduler.js";
import type { TenantSettingsStore } from "./interfaces/tenant-settings-store.js";
import type { TokenCounter } from "./interfaces/token-counter.js";
import type { VectorStore } from "./interfaces/vector-store.js";
import type { MemoryId, ObservationId } from "./ids.js";
import type {
  ObserveDocumentInput,
  ObserveEventInput,
  ObserveInput,
  ObserveUtteranceInput,
  ObserveInputKind,
} from "./observation.js";
import { ObserveInputSchema, observeInputKindToObservationKind } from "./observation.js";
import type { NewObservation, Observation } from "./observation.js";
import type { OutboxJobRecord } from "./outbox.js";
import { runRecall } from "./recall-runtime.js";
import type { RecallQuery, RecallResult } from "./recall.js";
import { classifyReextractTargets, classifySupersedeFailure } from "./strategies/reextract.js";
import type { ReextractSkip } from "./strategies/reextract.js";

/**
 * `runtime.observe` / `runtime.tick` の実装（roadmap.md 段階3、docs/architecture.md §3.2・§3.3）。
 *
 * **runtime は `packages/core` に置く**（docs/architecture.md §4）。ただし core は zod 以外の
 * 実行時依存を持てない（§3.6）ため、DB・LLM・埋め込み・時刻・ハッシュ計算はすべて
 * `createRuntime(deps)` の呼び出し側が注入する。core 自身はこれらの実体を import しない。
 *
 * D16 の反映: `contentHash`（SHA-256 hex）の実装は core に置かない。`deps.hashContent` として
 * 注入される関数（`node:crypto` を使う実装は adapter 側、例えば `packages/postgres` の
 * `sha256Hex`）に委ねる。runtime はこの関数を「呼ぶ」だけで、計算そのものは行わない。
 */

export interface RuntimeConfig {
  /** 抽出器のバージョン。冪等キー `(observationId, extractorVersion)` の一部になる。 */
  extractorVersion?: string;
  /** `provenance.inferred.model` に書き込むモデル識別子。呼び出し側の LLMProvider の実体に合わせる。 */
  llmModelId?: string;
  /** `provenance.inferred.promptVersion`。抽出プロンプトを変えたら上げる。 */
  promptVersion?: string;
  /** digest フォールバック（機械的な先頭文字列切り出し）の最大文字数。既定 200。 */
  digestFallbackLength?: number;
  /** `tick` の既定 claimedBy 値。複数ワーカーを区別したい場合に指定する。 */
  defaultClaimedBy?: string;
}

const DEFAULT_EXTRACTOR_VERSION = "v1";
const DEFAULT_LLM_MODEL_ID = "unknown";
const DEFAULT_PROMPT_VERSION = "v1";
const DEFAULT_DIGEST_FALLBACK_LENGTH = 200;
const DEFAULT_CLAIMED_BY = "runtime.tick";
const DEFAULT_TICK_LIMIT = 50;

export interface RuntimeDeps {
  memoryStore: MemoryStore;
  outboxStore: OutboxStore;
  vectorStore: VectorStore;
  eventStore: EventStore;
  tenantSettingsStore: TenantSettingsStore;
  llmProvider: LLMProvider;
  embeddingProvider: EmbeddingProvider;
  /** 省略時は `systemClock`。 */
  clock?: Clock;
  /** D16: SHA-256 hex 等、content からハッシュを計算する関数（core は計算しない）。 */
  hashContent: (content: string) => string;
  config?: RuntimeConfig;
  /**
   * roadmap.md 段階4: `usage`（docs/recall.md §6）の計測に使う。省略時は
   * `heuristicTokenCounter`（文字数ベースの推定、`counter: 'heuristic'`）。
   */
  tokenCounter?: TokenCounter;
}

export interface ObserveResult {
  observationId: ObservationId;
  /**
   * sync 抽出で実際に作られた（または既存の冪等な行として返された）Memory の id。
   * `deferred` の場合、または冪等な再送（`created: false`）の場合は空配列——
   * **この場合に「以前作られた Memory の id」を遡って探すことはしない**（本 PR の決定。
   * PR 本文参照）。
   */
  memoryIds: MemoryId[];
  /**
   * この呼び出しの中で抽出がどうなったか。
   *
   * **`boolean` にしない。**「抽出した / していない」の2値に潰すと、
   * **LLM 呼び出しが失敗して全文フォールバックへ倒れた**という第三の状態が
   * 「抽出した」と同じ顔になる。ADR 0008 の判定基準——その区別があると
   * 呼び出し側の次の一手が変わるか——に照らすと、これは潰してはいけない区別である
   * （`llm_failed_whole_observation` なら、provider の復旧後に抽出をやり直す、
   * という一手がある。`ok` にはその一手が無い）。
   */
  extraction: ExtractionOutcome;
  /**
   * `extraction === "llm_failed_whole_observation"` のときに LLM 呼び出しが失敗した理由。
   * **それ以外（`"ok"` / `"skipped"`）は必ず `null`。**
   *
   * `ExtractionOutcome` 自体は3値のまま変えない（値を足すと `extraction` を分岐する
   * 網羅性チェックの無い箇所——本ファイルの三項演算子と
   * `examples/chat/src/retrieval-quality.ts` の switch——が黙って既定側へ落ちるため）。
   * その代わり、失敗の中身（provider が名乗った `kind` と人が読むメッセージ）はこの欄で運ぶ。
   *
   * **省略可能にしない。** 必須にすることで、`ObserveResult` を組み立てる全経路を
   * TypeScript に列挙させ、「埋め忘れた経路が黙って `undefined`（＝間違った *有る*）になる」
   * ことを防ぐ。
   */
  extractionFailure: ExtractionFailure | null;
}

/**
 * `runtime.reextract` の結果（ADR 0028、ADR 0029）。
 *
 * `observe()` の `ExtractionOutcome` が持つ `'skipped'`（`ObserveResult.extraction`。
 * `memory_usage` 入力用の値）と、この型が持つ `ReextractResult.skipped` フィールドは
 * **別の語彙**である——前者は「この呼び出しで抽出そのものを行ったか」、後者は
 * 「既存 Memory を supersede しなかった理由」。名前が似ているだけで無関係。
 * `reextract` の `extraction` は常に `'ok'` か `'llm_failed_whole_observation'` のどちらかで、
 * `'skipped'` は取らない——呼び出し側が明示的に指定した Observation に対して常に抽出を
 * 試みるため（deferred も冪等な再送もここには来ない）。
 */
export interface ReextractResult {
  observationId: ObservationId;
  /**
   * 今回の抽出で作られた（または冪等に既存の行として返された）Memory の id。
   * `outcome !== 'ok'`、または候補が0件だった場合は空配列。
   */
  memoryIds: MemoryId[];
  /**
   * 🔴 安全弁により supersede された既存 Memory の id。
   * - LLM がまた失敗した場合（`outcome: 'llm_failed_whole_observation'`）は必ず空配列
   *   ——失敗を根拠に既存の記憶を置き換えない。
   * - 候補が0件だった場合も必ず空配列——そもそも `supersededById` の指す先が無い。
   * - 対象は同じ `(sourceObservationId, extractorVersion)` を持つ **`status: 'active'`** の
   *   Memory のうち、今回作られた content_hash の集合に含まれないものだけ
   *   （`forgotten` は絶対に含めない。`contested` も対象外——理由は ADR 0028 参照）。
   * - 🔴 安全弁3（ADR 0030）: `updateStatus` を `expectedStatus: "active"` の
   *   compare-and-swap で呼ぶ。読み（`listBySourceObservation`）と書き（`updateStatus`）の
   *   間に他の書き込みで status が変わっていた Memory は、ここには**入らない**
   *   （`skipped` に `status_changed_concurrently` として出る）。
   */
  supersededMemoryIds: MemoryId[];
  /**
   * ADR 0029: 既存 Memory を supersede しなかった理由。ADR 0028 が「引き受ける負債」に
   * 記録した欠落——`contested` で飛ばした・`forgotten` で飛ばした・そもそも置き換える
   * ものが無かった、の3つが `supersededMemoryIds: []` という同じ顔になっていた——を埋める。
   * ADR 0030（安全弁3）で `status_changed_concurrently`（TOCTOU で弾かれた）を追加した。
   *
   * **件数は持たない**（`ReextractSkip` 自体に `count`/`countKind` が無い。`recall.ts` の
   * `StageSkippedOmission` に倣った形。理由は ADR 0029 参照）。
   *
   * `usedWholeObservationFallback` の早期 return、`candidates.length === 0` の早期 return、
   * 本経路（`classifyReextractTargets` + `classifySupersedeFailure`）の3つの書き込み経路が
   * ある——早期 return の2つは**`listBySourceObservation` を呼ぶ前に return する**ため、
   * `skipped` には `{ kind: 'not_examined', ... }` が入る（「何も飛ばさなかった」ではなく
   * 「既存を見ていない」）。
   */
  skipped: ReextractSkip[];
  extraction: ExtractionOutcome;
  /**
   * `ObserveResult.extractionFailure` と同じ意味の欄（ADR 0076）。
   * `reextract` も `extractCandidates` を呼び、`llm_failed_whole_observation` を返す
   * 早期 return を持つ——`ObserveResult` にだけ運んで `ReextractResult` に運ばないと、
   * 「片方は種類が分かるのにもう片方は分からない」という非対称ができるため、対称に足す。
   * `extraction !== "llm_failed_whole_observation"` のときは必ず `null`。
   */
  extractionFailure: ExtractionFailure | null;
}

export interface TickOptions {
  /**
   * claim のリース長（ミリ秒）。`ClaimOutboxJobsOptions.leaseMs`（ADR 0032）へそのまま渡す。
   * **必須・既定値なし**——リース長は「ワーカーが止まったとみなすまでの時間」という
   * 運用方針であり、`packages/core` が決めてよい値ではなく呼び出し側が決める。
   * これにより `tick(ctx)` を引数無しで呼ぶことはできない（意図した破壊的変更、ADR 0032）。
   */
  leaseMs: number;
  limit?: number;
  kinds?: OutboxJobKind[];
  claimedBy?: string;
}

export interface TickResult {
  processed: number;
  failed: number;
}

export interface Runtime {
  observe(ctx: Ctx, input: ObserveInput): Promise<ObserveResult>;
  /**
   * outbox に溜まったジョブを消化する（docs/architecture.md §3.3）。
   * `extract: 'deferred'` かつ `InlineScheduler`（キュー無し）構成では、これを誰かが
   * 明示的に呼ばない限り抽出・埋め込みは永久に走らない——「キューが無ければ黙って
   * 何も起きない」を作らない、という設計方針をそのまま体現する。
   *
   * `opts.leaseMs` は必須（ADR 0032）。`tick(ctx)` を引数無しで呼ぶことはできない
   * ——`claimBatch` の claim リース長は運用方針であり、`packages/core` が既定値を
   * 発明せず呼び出し側に決めさせるための意図した破壊的変更。
   */
  tick(ctx: Ctx, opts: TickOptions): Promise<TickResult>;
  /**
   * roadmap.md 段階4「想起」・段階5「説明」。docs/recall.md §2 の7段パイプライン
   * （実装は `./recall-runtime.js` の `runRecall`）。
   */
  recall(ctx: Ctx, query: RecallQuery): Promise<RecallResult>;
  /**
   * ADR 0028: ADR 0013 が未解決のまま残した「失敗した抽出をやり直す」操作。
   * 指定した Observation に対してもう一度 `extractCandidates` を走らせ、成功したら
   * 同じ `(sourceObservationId, extractorVersion)` を持つ既存の `active` Memory のうち
   * 今回作られなかったもの（content_hash が今回の集合に無いもの）を `superseded` にする。
   * 安全弁3つ（LLM がまた失敗したら何もしない・候補0件なら何もしない・compare-and-swap で
   * TOCTOU の競合を検知する）は `ReextractResult` の doc コメントを参照。
   */
  reextract(ctx: Ctx, observationId: ObservationId): Promise<ReextractResult>;
  /**
   * ADR 0079: 索引に載っていない Memory を**もう一度索引へ載せに行く**。
   *
   * `recall` は `omitted` に `{ kind: 'not_indexed', reason }` を積んで
   * 「索引されていない N 件がある」と正しく名乗る。docs/recall.md §4 はその `reason` に
   * 応じた次の一手（`pending` は待つ・再試行する、`failed` は埋め込みパイプラインを疑う）
   * まで案内している。**この口は、その案内どおりに動くための操作である**——
   * 埋め込みの provider が落ちていた間に入った Memory は、provider が直っても
   * 自力では索引へ戻らない（`fail` は終端であり、Phase 1 に自動リトライは無い。ADR 0032）。
   *
   * ⚠ **`reextract` とは別の操作である。**`reextract` は**抽出**をやり直す
   * （Observation から Memory を作り直す）。こちらは既にある Memory の**埋め込み**を
   * やり直す。
   *
   * **このメソッド自身は埋め込みを行わない。**`MemoryStore.requeueEmbedJobs` を呼んで
   * `embed` ジョブを積み直すだけであり、実際に埋め込むのは次の `tick()` である
   * ——「キューが無ければ黙って何も起きない」を作らない、という `tick` の設計方針
   * （上の doc コメント）をここでも崩さない。**呼んだだけでは索引は埋まらない。**
   *
   * 引数と返り値は {@link RequeueEmbedJobsOptions} / {@link RequeueEmbedJobsResult} を
   * **そのまま使う**（`TickOptions` のように別の型を立てない）。この口は store の同名
   * メソッドへ素通しするだけで、runtime 側が足す選択肢が1つも無いためである——
   * 同じ形の型を2つ置くと、片方だけ直したときに黙ってずれる。
   */
  reembed(ctx: Ctx, opts: RequeueEmbedJobsOptions): Promise<RequeueEmbedJobsResult>;
}

function extractObservationPayload(
  input: ObserveUtteranceInput | ObserveEventInput | ObserveDocumentInput,
): unknown {
  switch (input.kind) {
    case "utterance":
      return { text: input.text, speaker: input.speaker };
    case "event":
      return { name: input.name, data: input.data ?? {} };
    case "document":
      return { title: input.title, content: input.content };
    default: {
      const exhaustive: never = input;
      throw new Error(`unreachable observe input kind: ${String(exhaustive)}`);
    }
  }
}

export function createRuntime(deps: RuntimeDeps): Runtime {
  const clock = deps.clock ?? systemClock;
  const extractorVersion = deps.config?.extractorVersion ?? DEFAULT_EXTRACTOR_VERSION;
  const llmModelId = deps.config?.llmModelId ?? DEFAULT_LLM_MODEL_ID;
  const promptVersion = deps.config?.promptVersion ?? DEFAULT_PROMPT_VERSION;
  const digestFallbackLength = deps.config?.digestFallbackLength ?? DEFAULT_DIGEST_FALLBACK_LENGTH;
  const defaultClaimedBy = deps.config?.defaultClaimedBy ?? DEFAULT_CLAIMED_BY;

  /**
   * 抽出候補から Memory を作る核（`runExtraction` と `reextract` の共通経路）。
   * `createMemoryWithOutbox` の ON CONFLICT により冪等——同じ候補で複数回呼んでも
   * 新規行は増えない（`created: false` の場合はイベントも積まない）。
   * `contentHashes` は `reextract` が「今回作られた集合」を判定するために使う。
   */
  async function createMemoriesFromCandidates(
    ctx: Ctx,
    observation: Observation,
    candidates: ExtractedMemoryCandidate[],
    outcome: ExtractionOutcome,
    failure: ExtractionFailure | null,
  ): Promise<{ memoryIds: MemoryId[]; contentHashes: Set<string> }> {
    const halfLifeHours = await deps.tenantSettingsStore.getDefaultHalfLifeHours(ctx);
    const now = clock.now();
    const memoryIds: MemoryId[] = [];
    const contentHashes = new Set<string>();
    for (const candidate of candidates) {
      const newMemory = buildNewMemoryFromCandidate({
        ctx,
        observation,
        candidate,
        hashContent: deps.hashContent,
        extractorVersion,
        llmModelId,
        promptVersion,
        halfLifeHours,
        now,
        digestFallbackLength,
      });
      contentHashes.add(newMemory.contentHash);
      const { memory, created } = await deps.memoryStore.createMemoryWithOutbox(ctx, newMemory, [
        "embed",
      ]);
      memoryIds.push(memory.id);
      if (created) {
        await deps.eventStore.append(ctx, {
          tenantId: ctx.tenantId,
          memoryId: memory.id,
          kind: "created",
          actor: { type: "system" },
          digestSnapshot: memory.digest,
          sizeBeforeBytes: null,
          meta: {
            reason:
              outcome === "llm_failed_whole_observation"
                ? "extraction_failed_whole_observation_fallback"
                : "extracted",
            sourceObservationId: observation.id,
            extractorVersion,
            // `meta` は既存の jsonb NOT NULL 列へのキー追加のみ（マイグレーション不要）。
            // 失敗経路（outcome: "llm_failed_whole_observation"）のときだけ足す——
            // 成功経路の meta.reason: "extracted" の形は変えない。
            ...(outcome === "llm_failed_whole_observation"
              ? { failureKind: failure?.kind ?? null }
              : {}),
          },
        });
      }
      // embed ジョブは常に outbox 経由（非同期、docs/memory-model.md §11 行3）。
      // ここでは何もしない — tick() の processEmbedJob が処理する。
    }
    return { memoryIds, contentHashes };
  }

  /** 1件の Observation に対して抽出を実行し、作られた（または冪等に既存の）Memory の id を返す。 */
  async function runExtraction(
    ctx: Ctx,
    observation: Observation,
  ): Promise<{
    memoryIds: MemoryId[];
    outcome: ExtractionOutcome;
    failure: ExtractionFailure | null;
  }> {
    const { candidates, usedWholeObservationFallback, failure } = await extractCandidates(
      deps.llmProvider,
      ctx,
      observation,
    );
    const outcome: ExtractionOutcome = usedWholeObservationFallback
      ? "llm_failed_whole_observation"
      : "ok";
    if (candidates.length === 0) {
      return { memoryIds: [], outcome, failure };
    }
    const { memoryIds } = await createMemoriesFromCandidates(
      ctx,
      observation,
      candidates,
      outcome,
      failure,
    );
    return { memoryIds, outcome, failure };
  }

  /**
   * ADR 0028: `observe()` が LLM 障害で全文フォールバックへ倒れた（または単に古い抽出器版で
   * 作られた）Observation に対して、抽出をやり直す。
   *
   * 🔴 安全弁1: LLM がまた失敗したら（`usedWholeObservationFallback`）、何も supersede せずに
   * 返す。失敗を根拠に既存の記憶を置き換えない。
   * 🔴 安全弁2: 候補が0件なら、何も supersede しない。「何も記憶に値しない」という正常な
   * 抽出結果を根拠に既存を消さない（`superseded_by_id` の指す先も無い）。
   * 🔴 安全弁3（ADR 0030）: `classifyReextractTargets` が「今回作る前」に読んだ時点で
   * `active` だった Memory でも、実際に書きに行くまでの間（TOCTOU の窓）に別の書き込みで
   * status が変わっていることがある。`updateStatus` を `expectedStatus: "active"` の
   * compare-and-swap で呼び、弾かれたら `classifySupersedeFailure` で判定して `skipped` に
   * 積む（`supersededMemoryIds` には入れず、`superseded` イベントも積まない）。
   *
   * supersede 対象は、同じ `(sourceObservationId, extractorVersion)` を持つ既存 Memory のうち
   * **`status: 'active'`** かつ今回作られた content_hash の集合に含まれないものだけ。
   * `forgotten`（利用者が意図して忘れさせた）は絶対に含めない。`contested` も対象外にする
   * ——contested は対向 Memory との対で初めて意味を持つ契約（mandatory companion retrieval）を
   * 持つため、機構都合の reextract がその対の片方だけを動かすと契約を壊しかねない
   * （ADR 0028「確かめていないこと」参照）。
   */
  async function reextract(ctx: Ctx, observationId: ObservationId): Promise<ReextractResult> {
    const observation = await deps.memoryStore.getObservation(ctx, observationId);
    if (!observation) {
      throw new Error(`runtime.reextract: observation not found: ${observationId}`);
    }

    const { candidates, usedWholeObservationFallback, failure } = await extractCandidates(
      deps.llmProvider,
      ctx,
      observation,
    );

    if (usedWholeObservationFallback) {
      // ADR 0029: この早期 return は `listBySourceObservation` を呼ぶ前に return する——
      // つまり既存 Memory を「見ていない」。`skipped: []`（既定値の顔）にすると
      // 「何も飛ばさなかった」と嘘をつくことになるため、`not_examined` を明示する。
      return {
        observationId,
        memoryIds: [],
        supersededMemoryIds: [],
        skipped: [{ kind: "not_examined", reason: "llm_failed_whole_observation" }],
        extraction: "llm_failed_whole_observation",
        extractionFailure: failure,
      };
    }
    if (candidates.length === 0) {
      // ADR 0029: 同じ理由でここも `listBySourceObservation` の前——既存を見ていない。
      return {
        observationId,
        memoryIds: [],
        supersededMemoryIds: [],
        skipped: [{ kind: "not_examined", reason: "no_candidates" }],
        extraction: "ok",
        extractionFailure: null,
      };
    }

    // supersede 判定は「今回作る前」の既存 Memory を基準にする——これから作る Memory 自身が
    // 混ざって「今回作ったものを今回 supersede する」という自己矛盾を起こさないため。
    const existingBefore = await deps.memoryStore.listBySourceObservation(
      ctx,
      observationId,
      extractorVersion,
    );

    const { memoryIds, contentHashes } = await createMemoriesFromCandidates(
      ctx,
      observation,
      candidates,
      "ok",
      // ここに来る時点で outcome は必ず "ok"（上の usedWholeObservationFallback 早期 return
      // の後）——failure は常に null。
      null,
    );
    // `candidates.length === 0` を上で早期リターンしている以上、`createMemoriesFromCandidates`
    // は候補ごとに必ず1件 push するため `memoryIds` は非空——ここは構造的に保証されている
    // （防御的な二重チェックをあえて置かない。安全弁は「候補0件なら supersede しない」の
    // 早期リターン1本に絞る。ADR 0028「変異A」参照: ここを二重化すると、安全弁を外す変異を
    // 当てても歯が落ちなくなり、安全弁の実効性を検査できなくなる）。
    const supersededById = memoryIds[0]!;

    // ADR 0029: 判定そのものは純関数（`classifyReextractTargets`）に切り出してある——
    // ここでは判定結果（`toSupersede`・`skipped`）を受け取って I/O するだけ。
    // supersede する対象・順序・イベントの中身は ADR 0028 からミリも変えていない。
    const { toSupersede, skipped } = classifyReextractTargets(existingBefore, contentHashes);

    const supersededMemoryIds: MemoryId[] = [];
    for (const existing of toSupersede) {
      try {
        // 🔴 安全弁3（PR「update-status-compare-and-swap」、ADR 0030）: `classifyReextractTargets`
        // が「今回作る前」に読んだ時点で active だったからといって、書きに来た今この瞬間も
        // active だとは限らない（TOCTOU）。`expectedStatus: "active"` の compare-and-swap で
        // 「読んでから書くまでの間に status が変わった」ケースを検知不能なまま通さない。
        //
        // ADR 0031: status の更新と `superseded` イベントの追記は、以前は
        // `updateStatus` + `eventStore.append` という**別々の2コミット**だった——前者が
        // 成功し後者が失敗すると、行は永久に `superseded` のまま対応するイベントが
        // 永久に存在しない、という永続化された不整合が残りうる。`updateStatusWithEvent`
        // は両方を1回の呼び出し・1トランザクションにまとめる。CAS に弾かれた場合は
        // 両方とも起きない（イベントは積まれない）。
        await deps.memoryStore.updateStatusWithEvent(
          ctx,
          existing.id,
          "superseded",
          { supersededById, expectedStatus: "active" },
          {
            tenantId: ctx.tenantId,
            memoryId: existing.id,
            kind: "superseded",
            actor: { type: "system" },
            digestSnapshot: existing.digest,
            sizeBeforeBytes: null,
            meta: {
              reason: "reextract_superseded",
              supersededById,
              sourceObservationId: observationId,
              extractorVersion,
            },
          },
        );
      } catch (error) {
        const skip = classifySupersedeFailure(existing.id, error);
        if (skip === null) {
          // 競合以外の例外——飲み込まずそのまま投げる（classifySupersedeFailure の doc 参照）。
          throw error;
        }
        // CAS に弾かれた——supersededMemoryIds に入れず、superseded イベントも積まない
        // （積むと「置き換えた」という監査ログが嘘になる。`updateStatusWithEvent` 自身が
        // 弾かれたときは何も書き換えず何も積まないことを保証している）。
        skipped.push(skip);
        continue;
      }
      supersededMemoryIds.push(existing.id);
    }

    return {
      observationId,
      memoryIds,
      supersededMemoryIds,
      skipped,
      extraction: "ok",
      extractionFailure: null,
    };
  }

  async function handleMemoryUsage(
    ctx: Ctx,
    input: Extract<ObserveInput, { kind: "memory_usage" }>,
  ): Promise<ObserveResult> {
    const observation = await deps.memoryStore.createObservation(ctx, {
      tenantId: ctx.tenantId,
      subjectId: ctx.subjectId ?? null,
      externalId: null,
      kind: observeInputKindToObservationKind("memory_usage" satisfies ObserveInputKind),
      payload: { recallId: input.recallId, usedMemoryIds: input.usedMemoryIds },
      occurredAt: null,
      recordedAt: clock.now(),
    });

    // ADR 0009・docs/memory-model.md §6: 使用報告は抽出器を通らず recall_usages へ直接反映される。
    const { insertedMemoryIds } = await deps.memoryStore.recordUsage(
      ctx,
      input.recallId,
      input.usedMemoryIds,
    );
    const reinforcedAt = clock.now();
    for (const memoryId of insertedMemoryIds) {
      await deps.memoryStore.reinforce(ctx, memoryId, reinforcedAt);
    }

    return {
      observationId: observation.id,
      memoryIds: insertedMemoryIds,
      extraction: "skipped",
      extractionFailure: null,
    };
  }

  async function handleExtractableObservation(
    ctx: Ctx,
    input: ObserveUtteranceInput | ObserveEventInput | ObserveDocumentInput,
  ): Promise<ObserveResult> {
    const kind = observeInputKindToObservationKind(input.kind);
    const payload = extractObservationPayload(input);
    const extractMode = input.extract ?? "sync";

    const newObservation: NewObservation = {
      tenantId: ctx.tenantId,
      subjectId: input.subjectId ?? ctx.subjectId ?? null,
      externalId: input.externalId ?? null,
      kind,
      payload,
      occurredAt: input.occurredAt ?? null,
      recordedAt: clock.now(),
    };

    const { observation, created, jobs } = await deps.memoryStore.createObservationWithOutbox(
      ctx,
      newObservation,
      ["extract"],
    );

    if (!created) {
      // 冪等な再送（docs/architecture.md §3.5）。extract ジョブは積まれておらず、
      // sync/deferred のどちらであっても、ここで新たに抽出をやり直す必要はない
      // （最初の呼び出しで既に処理済みのはず）。
      return {
        observationId: observation.id,
        memoryIds: [],
        extraction: "skipped",
        extractionFailure: null,
      };
    }

    if (extractMode === "deferred") {
      return {
        observationId: observation.id,
        memoryIds: [],
        extraction: "skipped",
        extractionFailure: null,
      };
    }

    // extract: 'sync' — その場で抽出する（docs/architecture.md §3.2）。
    const { memoryIds, outcome, failure } = await runExtraction(ctx, observation);
    const extractJob = jobs.find((job) => job.kind === "extract");
    if (extractJob) {
      await deps.outboxStore.complete(ctx, extractJob.id);
    }
    return {
      observationId: observation.id,
      memoryIds,
      extraction: outcome,
      extractionFailure: failure,
    };
  }

  async function observe(ctx: Ctx, input: ObserveInput): Promise<ObserveResult> {
    const parsed = ObserveInputSchema.parse(input);
    if (parsed.kind === "memory_usage") {
      return handleMemoryUsage(ctx, parsed);
    }
    return handleExtractableObservation(ctx, parsed);
  }

  async function processExtractJob(ctx: Ctx, job: OutboxJobRecord): Promise<void> {
    const observationId = job.payload.observationId;
    if (typeof observationId !== "string") {
      throw new Error("runtime.tick: extract job payload missing observationId");
    }
    const observation = await deps.memoryStore.getObservation(ctx, observationId);
    if (!observation) {
      throw new Error(`runtime.tick: extract job references missing observation: ${observationId}`);
    }
    await runExtraction(ctx, observation);
  }

  async function processEmbedJob(ctx: Ctx, job: OutboxJobRecord): Promise<void> {
    const memoryId = job.payload.memoryId;
    if (typeof memoryId !== "string") {
      throw new Error("runtime.tick: embed job payload missing memoryId");
    }
    const memory = await deps.memoryStore.get(ctx, memoryId);
    if (!memory) {
      throw new Error(`runtime.tick: embed job references missing memory: ${memoryId}`);
    }
    try {
      const [vector] = await deps.embeddingProvider.embed(ctx, [memory.content]);
      if (!vector) {
        throw new Error("runtime.tick: embedding provider returned no vector");
      }
      await deps.vectorStore.upsert(ctx, deps.embeddingProvider.space, memory.id, vector);
      await deps.memoryStore.setEmbeddingStatus(ctx, memory.id, "ready");
    } catch (err) {
      // 索引の遅れ・失敗を黙って無かったことにしない（docs/architecture.md 原則の姿3）。
      await deps.memoryStore.setEmbeddingStatus(ctx, memory.id, "failed");
      throw err;
    }
  }

  async function tick(ctx: Ctx, opts: TickOptions): Promise<TickResult> {
    const claimOpts: ClaimOutboxJobsOptions = {
      kinds: opts.kinds ?? ["extract", "embed"],
      limit: opts.limit ?? DEFAULT_TICK_LIMIT,
      now: clock.now(),
      claimedBy: opts.claimedBy ?? defaultClaimedBy,
      leaseMs: opts.leaseMs,
    };
    const jobs = await deps.outboxStore.claimBatch(ctx, claimOpts);

    let processed = 0;
    let failed = 0;
    for (const job of jobs) {
      try {
        if (job.kind === "extract") {
          await processExtractJob(ctx, job);
        } else if (job.kind === "embed") {
          await processEmbedJob(ctx, job);
        } else {
          throw new Error(`runtime.tick: unknown outbox job kind: ${job.kind}`);
        }
        await deps.outboxStore.complete(ctx, job.id);
        processed += 1;
      } catch (err) {
        await deps.outboxStore.fail(ctx, job.id, err instanceof Error ? err.message : String(err));
        failed += 1;
      }
    }
    return { processed, failed };
  }

  const tokenCounter = deps.tokenCounter ?? heuristicTokenCounter;

  async function recall(ctx: Ctx, query: RecallQuery): Promise<RecallResult> {
    return runRecall(ctx, query, {
      memoryStore: deps.memoryStore,
      vectorStore: deps.vectorStore,
      embeddingProvider: deps.embeddingProvider,
      clock,
      tokenCounter,
    });
  }

  async function reembed(ctx: Ctx, opts: RequeueEmbedJobsOptions): Promise<RequeueEmbedJobsResult> {
    return deps.memoryStore.requeueEmbedJobs(ctx, opts);
  }

  return { observe, tick, recall, reextract, reembed };
}
