import type { Clock } from "./interfaces/clock.js";
import type { Ctx } from "./ctx.js";
import type { EmbeddingProvider } from "./interfaces/embedding-provider.js";
import type { MemoryStore } from "./interfaces/memory-store.js";
import type { TokenCounter } from "./interfaces/token-counter.js";
import type { VectorStore, VectorHit } from "./interfaces/vector-store.js";
import type { LexicalStore, LexicalHit } from "./interfaces/lexical-store.js";
import type { MemoryId } from "./ids.js";
import { NOT_INDEXED_REASONS } from "./recall.js";
import type { Memory } from "./memory.js";
import {
  ANN_TRUNCATION_UNDECIDABLE_LEXICAL_ACTIVE,
  DEFAULT_DIGEST_BAND_LIMIT,
  DEFAULT_OVER_FETCH_FACTOR,
  DEFAULT_RECALL_CHANNELS,
  DEFAULT_RECALL_LIMIT,
  DEFAULT_SCORE_THRESHOLD,
  LEXICAL_MATCH_VALUE,
  LEXICAL_STORE_UNAVAILABLE_ERROR_PREFIX,
  DIGEST_BAND_MAX_CHARS,
  DIGEST_BAND_MAX_ENTRY_CHARS,
  RecallQuerySchema,
} from "./recall.js";
import { packDigestBand } from "./digest-band.js";
import type {
  CountKind,
  IndexBand,
  Omission,
  RecallBudget,
  RecallQuery,
  RecallResult,
  RecallScope,
  RecalledMemory,
  ScoreBreakdown,
  StageTrace,
} from "./recall.js";
import { defaultScoringStrategy } from "./strategies/scoring.js";
import { decideAnnTruncation } from "./ann-truncation.js";

/**
 * `recall()` の実装（roadmap.md 段階4「想起」・段階5「説明」）。
 *
 * docs/recall.md §2 の7段パイプラインをそのまま実装する。**各段は「なぜ落としたか」を
 * Omission の形にして次の段へ渡し、パイプラインの最後に集計し直さない**（同§2 の契約）。
 * この関数の中の各ステップが、その契約を守る単位である——`omitted` に何かを push したら、
 * それ以降の段はその判断を覆さない。
 *
 * 候補生成（段1）は **`RecallQuery.channels` が指すチャンネルを並行して走らせる**
 * （[ADR 0084](../../../docs/decisions/0084-lexical-recall-channel.md)、Issue #106）。
 * **走らせられるチャンネルの唯一の出所は `RECALL_CHANNELS`（`recall.ts`）である**——
 * ここに散文で数え直さない（ADR 0082 が `TICK_SUPPORTED_JOB_KINDS` について引いた線）。
 *
 * **⚠ 既定は `DEFAULT_RECALL_CHANNELS`（= ANN 1本）であり、ADR 0084 以前と同じである。**
 * `channels` を渡さない呼び出しは、候補も順位も `explain` も1バイト変わらない。
 *
 * **「タグ一致・直近取得」は、いまも実装していない。**docs/recall.md §2 が一般形として
 * 触れているが、ADR 0084 が足したのは語彙チャンネル1本だけである。タグはこれまで通り
 * スコアリング（段2の加点要素、`defaultScoringStrategy`）としてのみ参加する。
 */

export interface RecallRuntimeDeps {
  memoryStore: MemoryStore;
  vectorStore: VectorStore;
  /**
   * 語彙チャンネル（ADR 0084）。**省略可能**——語彙チャンネルを無効にしたまま
   * mnemora は成立する（北極星の問い2）。
   *
   * **🔴 省略したまま `channels` に `"lexical"` を渡すと `recall()` は投げる。**
   * 黙って0件にしない理由は `RecallQuery.channels` の doc に書いてある。
   */
  lexicalStore?: LexicalStore;
  embeddingProvider: EmbeddingProvider;
  clock: Clock;
  tokenCounter: TokenCounter;
}

type ScoredCandidate = {
  memory: Memory;
  /**
   * **この候補を候補集合へ入れた最初のチャンネル。**
   *
   * **⚠ 「このチャンネルだけが見つけた」ではない。**ANN と語彙の両方が同じ記憶を
   * 引き当てた場合、ここは `"ann"` になる（ANN の窓に入っていたため）。
   * **語彙チャンネルも当てたかどうかは `score.lexicalMatch` の有無が名乗る**——
   * 2つを併せて読むと、どのチャンネルの集合に入っていたかが一意に決まる
   * （ADR 0084 §6）。単一の値でチャンネルの集合を表そうとしないこと。
   */
  retrievedVia: "ann" | "lexical" | "mandatory_companion";
  companionOf?: MemoryId;
  score: ScoreBreakdown;
};

/**
 * 段2の閾値比較の結果を、**網羅的な三分割**にする（ADR 0044）。
 *
 * **⚠ 以前は `filter(total >= t)` と `filter(total < t)` の2本を独立に走らせていた。
 * この2つは補集合ではない**——どちらかが `NaN` だと両方の比較が false になり、
 * 候補は残らないのに `below_threshold` にも数えられなかった
 * （`omitted` が空配列になり、「取りこぼしは無い」と積極的に誤答していた）。
 *
 * ここでは**1件につき1回だけ分岐**し、必ず3つのどれか1つに入れる。
 * ⟹ `passed.length + belowThreshold.length + notComparable.length === scored.length` が
 * **構造的に成り立つ。**成り立っていることは呼び出し側が確かめ、`countKind` の名乗りに使う。
 */
export interface ThresholdPartition {
  passed: ScoredCandidate[];
  belowThreshold: ScoredCandidate[];
  /** `>= threshold` でも `< threshold` でもなかった候補（実際には `total` が `NaN`）。 */
  notComparable: ScoredCandidate[];
}

export function partitionByThreshold(
  scored: readonly ScoredCandidate[],
  threshold: number,
): ThresholdPartition {
  const passed: ScoredCandidate[] = [];
  const belowThreshold: ScoredCandidate[] = [];
  const notComparable: ScoredCandidate[] = [];
  for (const candidate of scored) {
    const total = candidate.score.total;
    if (total >= threshold) {
      passed.push(candidate);
    } else if (total < threshold) {
      belowThreshold.push(candidate);
    } else {
      // ⚠ ここは「else if を書き忘れた残り」ではない。**到達する**——
      // total か threshold が NaN のとき、上の2つはどちらも false になる。
      notComparable.push(candidate);
    }
  }
  return { passed, belowThreshold, notComparable };
}

/**
 * 三分割の件数の `countKind` を決める（ADR 0044）。
 *
 * **🔴 `'exact'` をリテラルで書かないための関数である。**この repo が一度破れたのは、
 * `count(*) OVER ()` が `hnsw.ef_search` 依存の値を返すようになっても名乗りが
 * `'exact'` のままだった件である（ADR 0011）。**名乗りは、正確さを知っている場所から引き継ぐ。**
 * ここで正確さを知っているのは「三分割が網羅であること」なので、それを実際に数えて確かめる。
 *
 * **⚠ `partitionByThreshold` が正しい限り `'unknown'` は返らない。**
 * それでもこの分岐を置くのは、**壊れたときに嘘をつくのではなく黙るため**である。
 * 分岐が到達不能であること自体は、この関数を直接呼ぶ歯が測っている
 * （網羅でない分割を渡すと `'unknown'` が返ることを確かめてある）。
 */
export function countKindForPartition(
  partition: ThresholdPartition,
  scoredCount: number,
): CountKind {
  const partitioned =
    partition.passed.length + partition.belowThreshold.length + partition.notComparable.length;
  return partitioned === scoredCount ? "exact" : "unknown";
}

/** budget truncation の単位。同伴ペアは分割しない（docs/recall.md §8）ため、1つ以上の候補をまとめて持つ。 */
export type Unit = {
  members: ScoredCandidate[];
  /** 並び替え・切り詰めの基準スコア。ペアの場合は主(スコアで選ばれた側)のスコアを使う。 */
  rankScore: number;
};

function unitChars(unit: Unit): number {
  return unit.members.reduce((sum, m) => sum + m.memory.digest.length, 0);
}

function unitTokens(unit: Unit, tokenCounter: TokenCounter): number {
  return unit.members.reduce((sum, m) => sum + tokenCounter.count(m.memory.digest).tokens, 0);
}

/** budget が指定されたトークン予算の中で最も厳しい(小さい)ものを1本にまとめる。 */
function effectiveTokenBudget(budget: RecallBudget | undefined): number | undefined {
  if (!budget) return undefined;
  const candidates = [budget.maxMemoryTokens, budget.promptBudgetTokens].filter(
    (v): v is number => v !== undefined,
  );
  if (candidates.length === 0) return undefined;
  return Math.min(...candidates);
}

/**
 * 段4（予算による切り詰め）の件数の `countKind` を決める（ADR 0045）。
 *
 * **🔴 `'exact'` をリテラルで書かないための関数である。**
 * [ADR 0044](../../../docs/decisions/0044-score-not-comparable-omission.md) で段2に入れたのと
 * 同じ規律を段4へ広げる——**名乗りは、正確さを知っている場所から引き継ぐ。**
 *
 * **⚠ ここで「正確さを知っている場所」は `slice` ではない。**
 * `keptUnits = units.slice(0, cut)` と `droppedUnits = units.slice(cut)` が網羅であることは
 * 言語の保証であり、確かめても同語反復にしかならない。
 *
 * **正確さを決めているのは、その手前の「単位を組む繰り返し」である**——
 * 段3までに集まった候補（`withinLimit` ＋ 同伴取得分）が、**それぞれちょうど1つの単位に入ったか。**
 * あの繰り返しは `consumed` の集合で重複を避けながら同伴をペアにしており、
 * **どの候補もどの単位にも入らないまま落ちる余地が構造として在る**（対向関係が
 * 一対一でない壊れたデータが来た場合など）。**そうなると、その候補は返り値にも
 * `budget_dropped` にも現れずに消える**——[ADR 0044](../../../docs/decisions/0044-score-not-comparable-omission.md)
 * が段2で塞いだのと同じ形の穴が、段4で開くことになる。
 *
 * **⟹ 単位が候補を網羅していれば `'exact'`、していなければ `'unknown'` と名乗る。**
 * 嘘をつくのではなく黙る。
 */
export function countKindForUnits(units: readonly Unit[], candidateCount: number): CountKind {
  const covered = units.reduce((sum, unit) => sum + unit.members.length, 0);
  return covered === candidateCount ? "exact" : "unknown";
}

/**
 * 単位が候補を**覆えていない件数**を返す（ADR 0043）。覆えていれば 0。
 *
 * **🔴 二重計上（覆った数が候補数を超える）でも 0 を返す。**候補は*消えて*いないので、
 * 「落ちた」と名乗るのは嘘になる。**差の絶対値ではない**——向きが意味を持つ。
 * 二重計上そのものは `countKindForUnits` が `'unknown'` として名乗る（ADR 0045）。
 *
 * **⚠ この関数の 0 を返す2つの経路（覆えている / 二重計上）は、`recall()` からは
 * 区別できない。**どちらも omission が出ないという同じ結果になるためである。
 * ⟹ **向きの判断そのものは、この関数を直接呼ぶ歯で測る。**
 */
export function unitAssemblyShortfall(units: readonly Unit[], candidateCount: number): number {
  const covered = units.reduce((sum, unit) => sum + unit.members.length, 0);
  return Math.max(0, candidateCount - covered);
}

export async function runRecall(
  ctx: Ctx,
  query: RecallQuery,
  deps: RecallRuntimeDeps,
): Promise<RecallResult> {
  const validatedQuery = RecallQuerySchema.parse(query);
  const now = deps.clock.now();
  const stages: StageTrace[] = [];
  const omitted: Omission[] = [];

  // -------------------------------------------------------------------
  // 段0: スコープ確定（docs/recall.md §2 段0、マネージャー決定の「スコープの外延」）
  // -------------------------------------------------------------------
  const scope: RecallScope = {
    subjectId: ctx.subjectId,
    occurredAfter: validatedQuery.occurredAfter,
    occurredBefore: validatedQuery.occurredBefore,
  };
  stages.push({
    stage: "scope",
    executed: true,
    detail: {
      subjectId: scope.subjectId ?? null,
      occurredAfter: scope.occurredAfter?.toISOString() ?? null,
      occurredBefore: scope.occurredBefore?.toISOString() ?? null,
    },
  });

  // -------------------------------------------------------------------
  // 段1: 候補生成（索引が効く。docs/recall.md §2 段1・§3）
  // -------------------------------------------------------------------
  const limit = validatedQuery.limit ?? DEFAULT_RECALL_LIMIT;
  const overFetchFactor = validatedQuery.overFetchFactor ?? DEFAULT_OVER_FETCH_FACTOR;
  const kPrime = Math.max(1, Math.round(limit * overFetchFactor));

  // 走らせるチャンネル（ADR 0084）。唯一の出所は RECALL_CHANNELS（recall.ts）であり、
  // ここで値を数え直さない——増えたときに黙って嘘になるのは散文のほうだからである。
  const channels = validatedQuery.channels ?? DEFAULT_RECALL_CHANNELS;
  const wantsAnn = channels.includes("ann");
  const wantsLexical = channels.includes("lexical");

  // 🔴 配線されていない語彙チャンネルを明示的に要求されたら、ここで投げる（ADR 0084 §4）。
  // **黙って0件を返さない。**理由は RecallQuery.channels の doc に書いてある——
  // これは「探したが無かった」ではなく「探せる状態になっていない」であり、
  // 何度呼んでも成功しない。degrade させると、呼び出し側は「使っているつもりで
  // 一度も使えていない」ことに気づけない。
  const lexicalStore = deps.lexicalStore;
  if (wantsLexical && lexicalStore === undefined) {
    throw new Error(
      LEXICAL_STORE_UNAVAILABLE_ERROR_PREFIX +
        "pass RuntimeDeps.lexicalStore, or drop 'lexical' from RecallQuery.channels",
    );
  }

  const embeddableText = validatedQuery.text?.trim();
  let queryVector = validatedQuery.vector;
  let candidateGenerationExecuted = false;
  let annHits: VectorHit[] = [];
  let lexicalHits: LexicalHit[] = [];
  let lexicalExecuted = false;

  // 「クエリに引ける中身が無い」は**段の性質であってチャンネルの性質ではない**ので、
  // チャンネルが2本走っても omission は1つしか積まない（ADR 0008: 同じ理由を
  // 2つの顔で返さない）。どのチャンネルが実行されなかったかは stages が名乗る。
  const pushEmptyQuerySkipOnce = (): void => {
    const already = omitted.some(
      (o) =>
        o.kind === "stage_skipped" &&
        o.stage === "candidate_generation" &&
        o.reason === "empty_query_content",
    );
    if (!already) {
      omitted.push({
        kind: "stage_skipped",
        stage: "candidate_generation",
        reason: "empty_query_content",
      });
    }
  };

  if (wantsAnn && queryVector === undefined) {
    if (embeddableText) {
      try {
        const [vector] = await deps.embeddingProvider.embed(ctx, [embeddableText]);
        queryVector = vector;
      } catch {
        omitted.push({
          kind: "stage_skipped",
          stage: "candidate_generation",
          reason: "embedding_provider_unavailable",
        });
      }
    } else {
      pushEmptyQuerySkipOnce();
    }
  }

  if (wantsAnn && queryVector !== undefined) {
    annHits = await deps.vectorStore.search(ctx, deps.embeddingProvider.space, queryVector, {
      limit: kPrime,
      filter: {
        tenantId: ctx.tenantId,
        status: ["active", "contested"],
        subjectId: scope.subjectId,
        excludeProvenanceKinds: validatedQuery.excludeProvenanceKinds,
        occurredAfter: scope.occurredAfter,
        occurredBefore: scope.occurredBefore,
      },
      // ADR 0011: decayFloorAtAfter は Phase 1 では読み取りフィルタに使わない。
      // subjectId は等値一致なので段1に降ろす（ADR 0023）。excludeProvenanceKinds も
      // 離散5値の独立列への等値比較なので同じ理由で段1に降ろす（ADR 0056）。period は
      // 連続値の範囲比較であり partial index の離散値向き制約（docs/recall.md 133行目）に
      // 関わる設計判断だったが、ADR 0059 で式索引
      // （`COALESCE(occurred_at, recorded_at)` の3列索引）を足して段1に降ろした——
      // ADR 0023 の却下理由（「降ろすにはスキーマに踏み込む判断が要る」）は、その判断を
      // 実際に行ったことで解消されている。狭い時間窓のとき over-fetch の窓（k'）が
      // 期間外の候補で埋まる取りこぼしは、この押し下げで塞がれる。
    });
    candidateGenerationExecuted = true;
  }

  // **チャンネル1本につき trace を1つ積む**（ADR 0084 §6）。
  // ⟹ 既定（ANN 1本）のとき、この配列は ADR 0084 以前と1要素も1バイトも変わらない。
  // 複数チャンネルを走らせたときだけ要素が増え、各要素の detail.channel が出所を名乗る。
  if (wantsAnn) {
    stages.push({
      stage: "candidate_generation",
      executed: candidateGenerationExecuted,
      detail: { channel: "ann", kPrime, hits: annHits.length },
    });
  }

  // -------------------------------------------------------------------
  // 段1・語彙チャンネル（ADR 0084、Issue #106）
  // -------------------------------------------------------------------
  // **埋め込みを作らない。**語彙チャンネルはクエリの**文字列そのもの**を引く経路であり、
  // ここが「LLM を呼ばずに済ませられないか」（北極星の問い5）に素直に答える部分である。
  // ⟹ channels が ["lexical"] だけなら、この recall は埋め込み provider を一度も呼ばない。
  // `lexicalStore !== undefined` は上の throw が保証している。ここで改めて見ているのは
  // 型の narrowing のためだけであり、条件が増えたわけではない。
  if (wantsLexical && lexicalStore !== undefined) {
    if (embeddableText) {
      lexicalHits = await lexicalStore.search(ctx, embeddableText, {
        limit: kPrime,
        filter: {
          tenantId: ctx.tenantId,
          status: ["active", "contested"],
          subjectId: scope.subjectId,
          excludeProvenanceKinds: validatedQuery.excludeProvenanceKinds,
          occurredAfter: scope.occurredAfter,
          occurredBefore: scope.occurredBefore,
        },
      });
      lexicalExecuted = true;
    } else {
      // vector だけを渡された場合もここへ来る——**ベクタは語彙チャンネルに渡せない。**
      pushEmptyQuerySkipOnce();
    }
    stages.push({
      stage: "candidate_generation",
      executed: lexicalExecuted,
      detail: { channel: "lexical", kPrime, hits: lexicalHits.length },
    });
  }

  // over-fetch の打ち切り（docs/recall.md §3「正直に書くべき限界」）: LIMIT に達したなら
  // その先に何件あるかは原理的に数えられない。
  //
  // **⚠ ここでは「窓が埋まったか」を覚えるだけで、omitted へは積まない（ADR 0069）。**
  // かつてはこの位置で無条件に積んでいたが、`annHits.length >= kPrime` は
  // **「スコープが k' 以上ある」としか言っておらず、損したかどうかを一切言っていない**——
  // 実測でスコープ 75件・k'=40 のとき 7 probe すべてで鳴り、実損は 0/7 だった。
  // **⟹ 損失が起こりえたかは、段2〜段4 が終わって k 位の total が出るまで判定できない。**
  // 判定は `withinLimit` を作った直後で行う（下方の `decideAnnTruncation` の呼び出し）。
  const annWindowFilled = candidateGenerationExecuted && annHits.length >= kPrime && kPrime > 0;

  // 候補の実体を取得し、スコープ外（subject/period）・除外 provenance を落とす。
  // ここで落ちたものは「filtered」としては報告しない——subject は呼び出し側の境界
  // （tenant と同格。recall.ts の RecallScope doc 参照）、period はスコープを定義する
  // フィルタであり、その件数は段5の集約から報告する（ここで個別に数え直さない。
  // ADR 0011 と同じ理由——複数の経路から同じ意味の件数を出すと食い違いうる）。
  // チャンネルの候補を和集合にする（ADR 0084 §6）。順序は「ANN が返した順 →
  // 語彙だけが返した順」。**⟹ 語彙チャンネルが走っていないとき、この配列は
  // `annHits.map(h => h.memoryId)` と完全に一致する**——既定の挙動が変わらないことの、
  // コードの側の根拠である。
  const rawById = new Map<MemoryId, { distance?: number; lexicalRank?: number }>();
  const candidateIds: MemoryId[] = [];
  for (const hit of annHits) {
    const found = rawById.get(hit.memoryId);
    if (found === undefined) {
      rawById.set(hit.memoryId, { distance: hit.distance });
      candidateIds.push(hit.memoryId);
    } else if (found.distance === undefined) {
      found.distance = hit.distance;
    }
  }
  for (const hit of lexicalHits) {
    const found = rawById.get(hit.memoryId);
    if (found === undefined) {
      rawById.set(hit.memoryId, { lexicalRank: hit.rank });
      candidateIds.push(hit.memoryId);
    } else if (found.lexicalRank === undefined) {
      found.lexicalRank = hit.rank;
    }
  }

  const fetchedMemories =
    candidateIds.length > 0 ? await deps.memoryStore.getMany(ctx, candidateIds) : [];
  const memoriesById = new Map(fetchedMemories.map((m) => [m.id, m]));

  const excludeKinds = new Set(validatedQuery.excludeProvenanceKinds ?? []);
  const filteredCandidates: { memory: Memory; distance?: number; lexicalRank?: number }[] = [];
  for (const memoryId of candidateIds) {
    const raw = rawById.get(memoryId);
    if (raw === undefined) continue; // 起こらない（candidateIds は rawById から作った）。
    const memory = memoriesById.get(memoryId);
    if (!memory) continue; // getMany は存在しない/クロステナントの id を静かに落とす契約。
    // subjectId・excludeProvenanceKinds・period（occurredAfter/occurredBefore）は
    // 段1の filter にも渡している（上）が、ここでも改めて見る。二重に見えるが意図的
    // ——`VectorFilter` の各フィールドは adapter が実際に適用しなければならない契約だが
    // （ADR 0034）、正しさの責任は後段にも置く多層防御として残す（ADR 0034 の
    // 「採らなかった案」節、ADR 0056、period は ADR 0059）。この境界判定
    // （`>=`/`<=`、両端とも包含）は ADR 0039 が固定した規則そのものであり、
    // 段1へ渡す `VectorFilter.occurredAfter`/`occurredBefore`（ADR 0059）と
    // 同じ境界でなければならない——ここだけを変えると「何が返るか」と「omitted が
    // 何と言うか」が食い違う（ADR 0039 の指摘）。
    // ⚠ この段2のコメントは以前「InMemoryVectorStore は filter を無視するプレースホルダ
    // なので、ここを削ると core の契約そのものが壊れる」と書いていたが、その根拠は
    // ADR 0034 で `InMemoryVectorStore` が filter を実際に適用するよう直された時点で
    // 事実でなくなった（ADR 0034 が「コメントの更新は別途必要」と書き残していた分。
    // ADR 0056 で更新）。多層防御を残す理由そのものは変わっていない——上の
    // 現在の根拠に差し替えただけである。段1の絞りは正しさのためではなく、
    // over-fetch の窓（k'）を無駄にしないための最適化に過ぎない。
    if (scope.subjectId !== undefined && memory.subjectId !== scope.subjectId) continue;
    const effectiveTime = memory.occurredAt ?? memory.recordedAt;
    if (scope.occurredAfter && effectiveTime < scope.occurredAfter) continue;
    if (scope.occurredBefore && effectiveTime > scope.occurredBefore) continue;
    if (excludeKinds.has(memory.provenance.kind)) continue;
    filteredCandidates.push({ memory, distance: raw.distance, lexicalRank: raw.lexicalRank });
  }

  // -------------------------------------------------------------------
  // 段2: 再スコア（索引不要。docs/recall.md §2 段2・§7）
  // -------------------------------------------------------------------
  const queryTags = validatedQuery.tags ?? [];
  const scored: ScoredCandidate[] = filteredCandidates.map(({ memory, distance, lexicalRank }) => {
    // ADR 0038: distance はコサイン距離。ANN が当てていない候補には距離が無い。
    const similarity = distance === undefined ? undefined : 1 - distance;
    // 語彙一致は二値である（recall.ts の ScoreBreakdown.lexicalMatch の doc）。
    // **⚠ adapter が返した rank をここへ流さない**——尺度が adapter ごとに違い、
    // コサイン類似度と比較可能な量ではない（ADR 0084 §5）。
    const lexicalMatch = lexicalRank === undefined ? undefined : LEXICAL_MATCH_VALUE;
    const score = defaultScoringStrategy({
      now,
      similarity,
      lexicalMatch,
      tags: memory.tags,
      queryTags,
      occurredAt: memory.occurredAt,
      recordedAt: memory.recordedAt,
      lastReinforcedAt: memory.lastReinforcedAt,
      strength: memory.strength,
      halfLifeHours: memory.halfLifeHours,
    });
    return {
      memory,
      retrievedVia: distance === undefined ? ("lexical" as const) : ("ann" as const),
      score,
    };
  });
  scored.sort((a, b) => b.score.total - a.score.total);

  const scoreThreshold = validatedQuery.scoreThreshold ?? DEFAULT_SCORE_THRESHOLD;
  const partition = partitionByThreshold(scored, scoreThreshold);
  const { passed, belowThreshold, notComparable } = partition;
  // ⚠ `'exact'` をリテラルで書かない（ADR 0044）。理由は countKindForPartition の doc を参照。
  const rescoreCountKind = countKindForPartition(partition, scored.length);

  if (belowThreshold.length > 0) {
    omitted.push({
      kind: "below_threshold",
      count: belowThreshold.length,
      countKind: rescoreCountKind,
      nearMisses: belowThreshold
        .slice(0, 5)
        .map((c) => ({ memoryId: c.memory.id, score: c.score.total })),
    });
  }

  if (notComparable.length > 0) {
    omitted.push({
      kind: "score_not_comparable",
      count: notComparable.length,
      countKind: rescoreCountKind,
    });
  }

  const withinLimit = passed.slice(0, limit);
  const overLimit = passed.slice(limit);
  if (overLimit.length > 0) {
    omitted.push({ kind: "over_limit", count: overLimit.length, countKind: rescoreCountKind });
  }

  // -------------------------------------------------------------------
  // over-fetch の窓の外に、本来 top-k に入るべき候補が残っていたか（ADR 0069 案A）
  //
  // **段1ではなくここで判定する。**比較の基準になる「k 位の total」は、閾値と limit を
  // 通したあとにしか存在しないからである。**⟹ `omitted` の並び順が変わった**——
  // かつて `ann_truncated` は `below_threshold` / `over_limit` より前に積まれていた。
  // **順序に意味は無い**（`omitted` は集合として読まれる。`docs/recall.md` §4 の表も
  // kind ごとの説明であり順序を規定していない）が、**配列の完全一致で書かれた歯は影響を受ける**
  // ので、そういう歯は `toContainEqual` 等へ直した（緩めたのではなく、順序に依存していた
  // ことのほうが偶然だった）。
  // -------------------------------------------------------------------
  if (annWindowFilled && lexicalExecuted) {
    // 🔴 語彙チャンネルが走った run では、ADR 0069 の上界が前提として成り立たない
    // （ANN_TRUNCATION_UNDECIDABLE_LEXICAL_ACTIVE の doc）。**判定を試みずに、
    // 判定不能だと名乗る。**試みて `provably_safe` が返ると、成り立っていない前提の上で
    // 沈黙することになる——ADR 0069 が塞いだ穴を、こちらから開け直すことになる。
    omitted.push({
      kind: "ann_truncated",
      countKind: "unknown",
      certainty: "undecidable",
      undecidableReason: ANN_TRUNCATION_UNDECIDABLE_LEXICAL_ACTIVE,
    });
  } else if (annWindowFilled) {
    const lastAnnHit = annHits[annHits.length - 1];
    const verdict = decideAnnTruncation({
      strategy: defaultScoringStrategy,
      queryTags,
      // 段2が `1 - distance` で similarity を作っているのと同じ変換（ADR 0038: distance は
      // コサイン距離）。ここで別の式を使うと、判定と実際のスコアが食い違う。
      lastAnnSimilarity: lastAnnHit === undefined ? Number.NaN : 1 - lastAnnHit.distance,
      lastReturnedTotal:
        withinLimit.length >= limit ? (withinLimit[limit - 1]?.score.total ?? null) : null,
      scoreThreshold,
    });
    // **`provably_safe` のときは何も積まない。**沈黙は「値」ではなく「不在」で表す——
    // omission を「安全だった」という顔で積むと、`undecidable`（判定できなかった）と
    // 同じ形になり、この決定の芯が消える。
    if (verdict.kind === "loss_possible") {
      omitted.push({
        kind: "ann_truncated",
        countKind: "unknown",
        certainty: "loss_possible",
        safetyRatio: verdict.safetyRatio,
        assumptions: verdict.assumptions,
      });
    } else if (verdict.kind === "undecidable") {
      omitted.push({
        kind: "ann_truncated",
        countKind: "unknown",
        certainty: "undecidable",
        undecidableReason: verdict.reason,
      });
    }
  }

  // 語彙チャンネルの打ち切り（ADR 0084 §7）。**ANN と同じ札に潰さない**——
  // `ann_truncated` は損失可能性の判定まで作り込んだ札であり、こちらにその機構は無い。
  if (lexicalExecuted && kPrime > 0 && lexicalHits.length >= kPrime) {
    omitted.push({ kind: "lexical_truncated", countKind: "unknown" });
  }

  stages.push({
    stage: "rescore",
    executed: filteredCandidates.length > 0,
    detail: {
      scored: scored.length,
      passedThreshold: passed.length,
      // 三分割の3つ目。ADR 0044 で omitted にも出るようになったが、
      // trace の側でも辻褄が合っていることを読めるようにしておく。
      notComparable: notComparable.length,
      withinLimit: withinLimit.length,
    },
  });

  // -------------------------------------------------------------------
  // 段3: 矛盾の解決と必須の同伴取得（docs/recall.md §2 段3・§8）
  // -------------------------------------------------------------------
  const presentIds = new Set(withinLimit.map((c) => c.memory.id));
  const contestedNeedingCompanion = withinLimit.filter(
    (c) =>
      c.memory.status === "contested" &&
      c.memory.contestedWithId &&
      !presentIds.has(c.memory.contestedWithId),
  );
  const companionIds = [
    ...new Set(
      contestedNeedingCompanion
        .map((c) => c.memory.contestedWithId)
        .filter((id): id is MemoryId => id !== null && id !== undefined),
    ),
  ];

  const companions: ScoredCandidate[] =
    companionIds.length > 0
      ? (await deps.memoryStore.getMany(ctx, companionIds)).map((companionMemory) => {
          const owner = contestedNeedingCompanion.find(
            (c) => c.memory.contestedWithId === companionMemory.id,
          );
          const score = defaultScoringStrategy({
            now,
            tags: companionMemory.tags,
            queryTags,
            occurredAt: companionMemory.occurredAt,
            recordedAt: companionMemory.recordedAt,
            lastReinforcedAt: companionMemory.lastReinforcedAt,
            strength: companionMemory.strength,
            halfLifeHours: companionMemory.halfLifeHours,
          });
          return {
            memory: companionMemory,
            retrievedVia: "mandatory_companion" as const,
            companionOf: owner?.memory.id,
            score,
          };
        })
      : [];

  stages.push({
    stage: "contradiction_resolution",
    executed: true,
    detail: { companionsAdded: companions.length },
  });

  // -------------------------------------------------------------------
  // 隣接性の不変条件（docs/memory-model.md §5 機構3）: 対向関係にある Memory は
  // 提示順で必ず隣接させる。ここで「単位（Unit）」を組み、budget 切り詰め（段4）は
  // 単位ごとに行う——ペアを分割しない（docs/recall.md §8）。
  // -------------------------------------------------------------------
  const allCandidates = [...withinLimit, ...companions];
  const byId = new Map(allCandidates.map((c) => [c.memory.id, c]));
  const consumed = new Set<MemoryId>();
  const units: Unit[] = [];
  for (const candidate of withinLimit) {
    if (consumed.has(candidate.memory.id)) continue;
    consumed.add(candidate.memory.id);
    const companionId = candidate.memory.contestedWithId;
    const companion = companionId && !consumed.has(companionId) ? byId.get(companionId) : undefined;
    if (companion && companion.retrievedVia === "mandatory_companion") {
      consumed.add(companion.memory.id);
      units.push({ members: [candidate, companion], rankScore: candidate.score.total });
    } else if (companion) {
      // 両側とも独立に withinLimit に含まれていたケース。まだ処理していなければペアにする。
      consumed.add(companion.memory.id);
      units.push({
        members: [candidate, companion],
        rankScore: Math.max(candidate.score.total, companion.score.total),
      });
    } else {
      units.push({ members: [candidate], rankScore: candidate.score.total });
    }
  }
  units.sort((a, b) => b.rankScore - a.rankScore);
  // 段4の件数がどれだけ正確かは、この時点で決まっている（ADR 0045）。
  const unitsCountKind = countKindForUnits(units, allCandidates.length);

  // 🔴 単位を組む繰り返しから候補が漏れたら、黙らない（ADR 0043）。
  //
  // ⚠ **Phase 1 ではここは一度も通らない。**`Runtime`（observe/tick/recall/reextract）は
  // `contested` も `contestedWithId` も書かないため、一対一が破れた状態を作れない
  // （`docs/memory-model.md`「関係グラフ本体は Phase 2」）。
  // **⟹ これは「いま壊れているもの」ではなく、`contested` を作る主体が入ったときの契約である。**
  //
  // ⚠ 二重計上のときに出さない判断は `unitAssemblyShortfall` が持つ（その doc を参照）。
  const unitsShortfall = unitAssemblyShortfall(units, allCandidates.length);
  if (unitsShortfall > 0) {
    omitted.push({
      kind: "unit_assembly_dropped",
      count: unitsShortfall,
      // 二重計上が同時に起きていれば、その分だけ消失が隠れる。⟹ 下限しか言えない。
      countKind: "lower_bound",
    });
  }

  // -------------------------------------------------------------------
  // 段4: 予算による切り詰め（docs/recall.md §2 段4・§8）
  // -------------------------------------------------------------------
  const budget = validatedQuery.budget;
  let keptUnits = units;
  if (budget) {
    const maxMemoryChars = budget.maxMemoryChars;
    const maxTokens = effectiveTokenBudget(budget);
    const fits = (candidateUnits: Unit[]): boolean => {
      if (maxMemoryChars !== undefined) {
        const chars = candidateUnits.reduce((sum, u) => sum + unitChars(u), 0);
        if (chars > maxMemoryChars) return false;
      }
      if (maxTokens !== undefined) {
        const tokens = candidateUnits.reduce((sum, u) => sum + unitTokens(u, deps.tokenCounter), 0);
        if (tokens > maxTokens) return false;
      }
      return true;
    };
    let cut = units.length;
    while (cut > 0 && !fits(units.slice(0, cut))) {
      cut -= 1;
    }
    keptUnits = units.slice(0, cut);
    const droppedUnits = units.slice(cut);
    const droppedCount = droppedUnits.reduce((sum, u) => sum + u.members.length, 0);
    if (droppedCount > 0) {
      // ⚠ `'exact'` をリテラルで書かない（ADR 0045）。理由は countKindForUnits の doc を参照。
      omitted.push({ kind: "budget_dropped", count: droppedCount, countKind: unitsCountKind });
    }
  }

  stages.push({
    stage: "budget_truncation",
    executed: true,
    detail: { budgetApplied: budget !== undefined, unitsKept: keptUnits.length },
  });

  const finalMemories: RecalledMemory[] = keptUnits.flatMap((unit) =>
    unit.members.map((member) => {
      const recalled: RecalledMemory = {
        memoryId: member.memory.id,
        digest: member.memory.digest,
        retrievedVia: member.retrievedVia,
        // ⚠ リテラルを書かない。値は **その Memory の provenance そのもの**から引き継ぐ。
        // 出どころが将来変わったら、名乗りも一緒に変わる——countKind の exact が
        // リテラル固定のまま出どころだけ変わって嘘になった件（ADR 0011）の裏返しである。
        provenanceKind: member.memory.provenance.kind,
        score: member.score,
      };
      if (member.companionOf !== undefined) {
        recalled.companionOf = member.companionOf;
      }
      return recalled;
    }),
  );

  // -------------------------------------------------------------------
  // 段5: 目次帯の構築（索引: 集約クエリ。docs/recall.md §2 段5・§5）
  //
  // digestBand が担うのは「スコープ内に在るが `memories` に返していないもの」の
  // 1件1行の要旨である——`memories` に入った分の要旨は既に `RecalledMemory.digest` に
  // 在るので、ここでは `finalMemories` の memoryId を明示的に除外して集約を取る。
  // -------------------------------------------------------------------
  const digestBandLimit = validatedQuery.digestBandLimit ?? DEFAULT_DIGEST_BAND_LIMIT;
  const aggregate = await deps.memoryStore.aggregateScope(ctx, scope, {
    digestBand: {
      limit: digestBandLimit,
      excludeMemoryIds: finalMemories.map((m) => m.memoryId),
    },
  });
  const packedDigestBand = packDigestBand(aggregate.digests, aggregate.digestEligible.count, {
    limit: digestBandLimit,
    maxChars: DIGEST_BAND_MAX_CHARS,
    maxEntryChars: DIGEST_BAND_MAX_ENTRY_CHARS,
  });
  const indexBand: IndexBand = {
    groups: aggregate.groups,
    totalInScope: aggregate.totalInScope,
    countKind: aggregate.countKind,
    digestBand: packedDigestBand.band,
    digestBandCoverage: {
      shown: packedDigestBand.band.length,
      eligible: aggregate.digestEligible.count,
      countKind: aggregate.digestEligible.countKind,
      ...(packedDigestBand.limitedBy !== undefined
        ? { limitedBy: packedDigestBand.limitedBy }
        : {}),
    },
  };
  stages.push({
    stage: "index_band",
    // ⚠ detail に件数を足さない（ADR 0011）。件数は digestBandCoverage が名乗る。
    // detail は型無しの診断欄であり、同じ意味の件数を2箇所に置くと食い違いうる。
    executed: true,
    detail: { totalInScope: aggregate.totalInScope },
  });

  if (aggregate.filteredArchived.count > 0) {
    omitted.push({
      kind: "filtered",
      condition: "archived",
      count: aggregate.filteredArchived.count,
      countKind: aggregate.filteredArchived.countKind,
    });
  }
  // superseded と forgotten を別々に push する（ADR 0027）。前者は機構の都合
  // （より良い抽出への置き換え、または統合。置き換え先を持つ）、後者は製品の振る舞い
  // （利用者が意図して忘れさせた。置き換え先を持たない）——束ねると次の一手が
  // 判定できなくなる。
  if (aggregate.filteredSuperseded.count > 0) {
    omitted.push({
      kind: "filtered",
      condition: "superseded",
      count: aggregate.filteredSuperseded.count,
      countKind: aggregate.filteredSuperseded.countKind,
    });
  }
  if (aggregate.filteredForgotten.count > 0) {
    omitted.push({
      kind: "filtered",
      condition: "forgotten",
      count: aggregate.filteredForgotten.count,
      countKind: aggregate.filteredForgotten.countKind,
    });
  }
  if (aggregate.filteredPeriod.count > 0) {
    omitted.push({
      kind: "filtered",
      condition: "period",
      count: aggregate.filteredPeriod.count,
      countKind: aggregate.filteredPeriod.countKind,
    });
  }
  // 理由ごとに1件ずつ返す（`filtered` の `condition` と同じ形）。
  // 一時的な遅延（pending）と恒久的な失敗（failed）と意図した除外（skipped）を
  // 1つに潰さない——ADR 0008 の判定基準（次の一手が変わるか）による。
  for (const reason of NOT_INDEXED_REASONS) {
    const entry = aggregate.notIndexed[reason];
    if (entry.count > 0) {
      omitted.push({
        kind: "not_indexed",
        reason,
        count: entry.count,
        countKind: entry.countKind,
      });
    }
  }

  // -------------------------------------------------------------------
  // ann_unreached（ADR 0025 の実測、ADR 0026 の決定）: 「近似索引がこの scope に
  // 届かなかった」ことが `omitted` に一度も出ない、という ADR 0008 の破れを埋める。
  //
  // **⚠ ここは段5（`aggregate`）に依存する。** `eligible`（= scope 内で埋め込みがあり
  // ANN の候補になり得た件数）は段1の情報だけでは出せない——`aggregate.totalInScope` と
  // `aggregate.notIndexed` が要る。この関数には早期 return が無く、段5は常にここに
  // 到達する前に実行されている（`aggregate` は必ず存在する。§報告のとおり確認済み）。
  // **もし将来、段5をスキップする経路が実装されたら、この判定はそこでは行えない
  // ——「取りこぼしたかもしれない」と断言する根拠（eligible）が無いため、鳴らさないこと。**
  const notIndexedTotal =
    aggregate.notIndexed.pending.count +
    aggregate.notIndexed.failed.count +
    aggregate.notIndexed.skipped.count;
  const eligible = aggregate.totalInScope - notIndexedTotal;
  if (
    candidateGenerationExecuted &&
    kPrime > 0 &&
    // k' に達していない。達していれば ann_truncated の領域であり、これと同時には立てない
    // ——「打ち切り」（もっと在るはずだが LIMIT で切った）と「届かなかった」（scope の他所へ
    // ANN が行ってしまった）は別の出来事だから、同じ札に相乗りさせない（ADR 0026）。
    annHits.length < kPrime &&
    // scope 内にまだ見られていない候補が残っている。
    // ⚠ この条件を落とすと、小さい subject で候補が ANN に全部返った場合
    // （例: 候補3件・kPrime 40・hits 3。3 < 40 だが 3 == eligible）にも常に鳴るようになる
    // ——「鳴ってはいけない側」を守っているのはこの条件である。
    annHits.length < eligible
  ) {
    omitted.push({ kind: "ann_unreached", countKind: "unknown" });
  }

  // -------------------------------------------------------------------
  // usage（docs/recall.md §6）: 計測と強制を混同しない——強制は段4で既に行った。
  // ここでは実際に返した量を測るだけ。
  // -------------------------------------------------------------------
  const digestChars = finalMemories.reduce((sum, m) => sum + m.digest.length, 0);
  const indexBandText = JSON.stringify(indexBand);
  const indexChars = indexBandText.length;
  const totalChars = digestChars + indexChars;
  const memoryTokens = deps.tokenCounter.count(finalMemories.map((m) => m.digest).join("\n"));
  const tokenCount = deps.tokenCounter.count(
    finalMemories.map((m) => m.digest).join("\n") + indexBandText,
  );

  // share の分子は **memories tier だけ**である（目次帯を含めない）。
  //
  // 目次帯は budget の対象外なので（RecallBudget の doc 参照）、分子に含めると
  // 「予算の何割を使ったか」という問いに対して、予算が縛っていない量まで数えることになり、
  // 100% を超える——実際に 248% という「割合として成立しない値」が出ていた。
  // 段4の切り詰めが memories tier を予算内に収めることを保証しているので、
  // 分子を memories tier に限れば share は 1 を超えない。
  //
  // 「この応答は全体でいくらかかったか」は別の問いであり、`chars` と `indexChars` が答える。
  const tokenBudget = effectiveTokenBudget(budget);
  const usageShareDenominator = tokenBudget ?? budget?.maxMemoryChars;
  const usageShareNumerator = tokenBudget !== undefined ? memoryTokens.tokens : digestChars;
  const usage = {
    chars: totalChars,
    estimatedTokens: tokenCount.tokens,
    counter: tokenCount.counter,
    byTier: { full: 0, digest: digestChars, index: indexChars },
    indexChars,
    ...(usageShareDenominator !== undefined
      ? { share: usageShareNumerator / usageShareDenominator }
      : {}),
  };

  // -------------------------------------------------------------------
  // 段6: 記録（docs/recall.md §2 段6、ADR 0008）。必須の段。
  //
  // `stages` に 'record' 自身のトレースを、実際に書き込む**前**に積む——「記録した」ことを
  // 記録するには、記録が起きたという前提を先に確定する必要がある（この呼び出しが
  // 例外を投げれば `recall()` 自体が例外で終わるため、`explain.stages` が「記録した」と
  // 嘘をついたまま呼び出し側に届くことはない）。
  // -------------------------------------------------------------------
  stages.push({ stage: "record", executed: true });
  const recallId = await deps.memoryStore.createRecall(ctx, {
    tenantId: ctx.tenantId,
    subjectId: ctx.subjectId ?? null,
    query: validatedQuery,
    budget: budget ?? null,
    omitted,
    usage,
    indexBand,
    explain: { stages },
    returnedMemoryIds: finalMemories.map((m) => m.memoryId),
  });

  return {
    recallId,
    memories: finalMemories,
    omitted,
    index: indexBand,
    usage,
    explain: { stages },
  };
}
