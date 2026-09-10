import { defaultDecayStrategy } from "./decay.js";
import type { ScoreBreakdown } from "../recall.js";

/**
 * ScoringStrategy — Phase 1・純関数（docs/architecture.md §5.7、docs/recall.md §7）。
 *
 * docs は「減衰 × 類似度 × タグ一致 × 鮮度 × 強度を掛け合わせる」ことと、
 * 「鮮度スコアは occurred_at ?? recorded_at を使い、減衰は last_reinforced_at を使う」
 * ことだけを規定し、各要素の具体的な計算式までは規定していない。以下の実装は
 * その制約の範囲で選んだ Phase 1 の既定であり、`ScoringStrategy` を差し替えれば
 * 別の式を使える。
 *
 * - `decay`（時間減衰）と `strength`（生の強度）を分けて掛ける。`decay` は
 *   `defaultDecayStrategy.strengthAt` を `strength = 1` で呼んだ時間減衰係数のみを表し、
 *   生の強度は `total` の計算で別要素として掛ける（二重に強度を織り込まない）。
 * - `freshness` は同じ減衰関数を `occurredAt ?? recordedAt` を起点に、`strength = 1` で
 *   呼んで求める（「鮮度は occurred_at ?? recorded_at を使う」という規定を満たす）。
 *   **ただし 1 で頭打ちにする**（`MAX_FRESHNESS`。[ADR 0036](../../../../docs/decisions/0036-clamp-freshness-at-one.md)）。
 * - `tagMatch` はクエリタグが無ければ中立の 1、あれば `1 + 0.1 * 一致数` とし、
 *   タグが一致しないことで total を 0 に落とさない（タグは加点要素であり除外条件では
 *   ない、という recall.md §2 の位置づけ——段1のフィルタではなく段2の再スコアである
 *   ことに合わせた）。
 * - `similarity` は ANN 経由でない候補では存在しないため、中立の 1 として扱う。
 * - `lexicalMatch` は**語彙チャンネルが引き当てた候補にのみ**在る
 *   （[ADR 0084](../../../../docs/decisions/0084-lexical-recall-channel.md)、Issue #106）。
 *   **⚠ 第6の項として掛けるのではなく、`similarity` と同じ枠（`affinity`）を争う。**
 *   掛ける形にすると、語彙一致が無い ANN 候補の `total` が 0 に落ちる（あるいは
 *   中立の 1 を掛けるだけの死んだ項になる）。**どちらも「掛ける」を選んだ時点で決まってしまう。**
 *   ⟹ `affinity = max(similarity, lexicalMatch)` とし、
 *   **「この候補がクエリにどれだけ近いか」を、それを見つけたチャンネルのうち最も強いものが名乗る**形にした。
 *
 * **🔴 `lexicalMatch` が `undefined` のとき、式は ADR 0084 以前と1演算も変わらない。**
 * `affinity` は `similarity ?? 1` にそのまま退化する——`Math.max` を通さないのは意図的で、
 * **`similarity` は負になりうる**（コサイン距離は最大 2 まで出るので `1 - distance` は −1 まで下がる。
 * `interfaces/vector-store.ts` の `VectorHit.distance` の doc）。
 * `Math.max(similarity, 0)` のような形にすると、**負の類似度の候補の `total` が
 * 静かに変わる。**⟹ 既定の挙動を1バイトも変えないために、分岐で書いてある。
 */
export interface ScoringInput {
  now: Date;
  /** ANN 経由の場合のみ渡す。0〜1 の類似度（距離から変換済み）。 */
  similarity?: number;
  /**
   * 語彙チャンネルが引き当てた場合のみ渡す（ADR 0084）。
   * **現在の実装では常に 1 である**——理由と、それが順位に何を意味するかは
   * `ScoreBreakdown.lexicalMatch`（`recall.ts`）の doc に書いてある。
   */
  lexicalMatch?: number;
  tags: string[];
  queryTags: string[];
  occurredAt?: Date | null;
  recordedAt: Date;
  lastReinforcedAt?: Date | null;
  strength: number;
  halfLifeHours: number;
}

export type ScoringStrategy = (input: ScoringInput) => ScoreBreakdown;

/**
 * `freshness` の上限（[ADR 0036](../../../../docs/decisions/0036-clamp-freshness-at-one.md)）。
 *
 * **🔴 これは「まだ起きていない出来事は、最も古びていない」と決めたものである。**
 * 式の副作用として 1 になるのではなく、選んだ結果として 1 になる。
 *
 * `freshness` の起点は `occurredAt ?? recordedAt` であり、`occurredAt` は
 * docs/memory-model.md §3 の定義（「その出来事・事実がいつのものか」）上、**ふつうに未来になる**
 * （「来月、京都へ出張する」）。減衰式 `0.5 ** (elapsedHours / halfLifeHours)` は
 * 経過時間が負のとき 1 を超え、**上限を持たない**——実測で +30日 → 2.0、
 * +365日 → 4,597、+10年 → 4.2×10³⁶ になる。**上限が無いと、未来の日付を1つ持つ記憶が
 * そのテナントの想起を永久に支配する。**
 *
 * **⚠ これは「未来の出来事を優遇する」決定ではない。**`freshness` は**古び**を測る項なので、
 * まだ起きていない出来事は古びようがない——**「たったいま起きたこと」と同じ扱いにするだけ**である。
 *
 * **⚠ 上限を掛けるのは `freshness` だけで、`decay` には掛けない。**
 * `decay` の起点は `lastReinforcedAt ?? recordedAt` であり、どちらも「mnemora が知った時刻」
 * 系である。そして `defaultDecayStrategy` に手を入れると
 * [ADR 0010](../../../../docs/decisions/0010-decay-parameters.md) が価値を置いている
 * 「`floorAt` が `strengthAt(now) = threshold` の解析解として導かれ、両者が同じ式から
 * 機械的に一貫する」という性質が壊れる。**戦略の側で頭打ちにし、減衰関数そのものは変えない。**
 */
export const MAX_FRESHNESS = 1;

function computeTagMatch(tags: string[], queryTags: string[]): number {
  const tagSet = new Set(tags);
  const matchedCount = queryTags.filter((tag) => tagSet.has(tag)).length;
  return 1 + matchedCount * 0.1;
}

// ---------------------------------------------------------------------------
// 非 similarity 項の積の上界の宣言（ADR 0069 §5〜§7）
// ---------------------------------------------------------------------------

/**
 * `nonSimilarityUpperBound` の入力。**クエリ側だけで決まる**部分がある——`tagMatch` の上界
 * (`1 + 0.1 × queryTags.length`) はクエリのタグ数だけに依存し、候補側の情報を要らない
 * （`computeTagMatch` そのものの形）。これが「上界をクエリだけから宣言できる」ことの根拠。
 */
export interface NonSimilarityBoundInput {
  queryTags: readonly string[];
}

/**
 * 段2のスコアのうち `similarity` 以外の項（`decay` × `tagMatch` × `freshness` × `strength`）の
 * 積の上界（ADR 0069 §5）。
 *
 * **`number` ではなく判別可能な union にする**——宣言できたか / できなかったかを
 * 潰さない（[ADR 0008](../../../../docs/decisions/0008-absence-taxonomy.md)「無いには
 * 種類がある」を判定そのものへ適用する）。`kind: "declared"` を返す戦略でも、
 * その上界が**保証**か**前提**かは `assumptions` の中身（歯で検査する）で読み分ける——
 * この型自体は「宣言した」ことしか表さない。
 */
export type NonSimilarityUpperBound =
  | {
      kind: "declared";
      value: number;
      /**
       * この上界が成り立つために立てた前提。**歯にできていないものを含む**
       * （ADR 0069 §8。「厳密探索が前提」「decay ≤ 1 は起点が未来でないことが前提」等）。
       * 空配列は「前提なしの保証」を意味する——コメントではなく、この配列自身に語らせる。
       */
      assumptions: readonly string[];
    }
  | {
      kind: "undeclared";
      /** なぜ宣言できないか（この戦略が上界の機構そのものを持たない、等）。 */
      reason: string;
    };

/**
 * 上界を宣言できる戦略。`ScoringStrategy` を拡張するのではなく**足す**——
 * 呼び出し可能な関数はそのままに、そこへ `nonSimilarityUpperBound` メソッドを
 * `Object.assign` で生やす形にする（下記 `defaultScoringStrategy` 参照）。
 *
 * **⭐ この形にする理由**: `ScoringStrategy` 型そのもの（`(input) => ScoreBreakdown`）は
 * 変えられない——npm に `0.1.1` が既に出ており、型を破壊すると利用者を壊す。
 * 「呼べるが宣言を持たない素の関数」もそのまま `ScoringStrategy` として通したいので、
 * 宣言は本体の型に埋め込まず、後から生やせるプロパティとして表現する。
 * **⟹ こうしておくと「宣言しない戦略」が型の上でもそのまま表現できる**
 * （`isBoundedScoringStrategy` で判別不能を測るのに使う。ADR 0069 §7 の
 * 「宣言を持たない戦略は判定不能に落ちるだけで、黙って誤った上界を使うことにはならない」）。
 */
export interface BoundedScoringStrategy extends ScoringStrategy {
  nonSimilarityUpperBound(input: NonSimilarityBoundInput): NonSimilarityUpperBound;
}

/** 引数が `nonSimilarityUpperBound` を持つか（＝宣言できる戦略か）を実行時に見分ける。 */
export function isBoundedScoringStrategy(s: ScoringStrategy): s is BoundedScoringStrategy {
  return typeof (s as Partial<BoundedScoringStrategy>).nonSimilarityUpperBound === "function";
}

/**
 * 既定戦略が宣言する、非 similarity 項の積の上界が立っている**前提**（ADR 0069 §6）。
 *
 * **🔴 なぜ文字列で持たせるか。**この2つは「保証」ではなく「前提」である——
 * `freshness` と `tagMatch` は式の形そのものから上界が出る（`Math.min` が在る／
 * `1 + 0.1 × n` の形）が、この2つは**そうではない**。
 *
 * - **`decay ≤ 1`** — `decay` に clamp は**無い**。上の `MAX_FRESHNESS` の doc が
 *   「**上限を掛けるのは `freshness` だけで、`decay` には掛けない**」と明記している通りで、
 *   `0.5 ** (elapsed / halfLife)` は `elapsed < 0`（起点が未来）なら 1 を超える。
 * - **`strength ≤ 1`** — 型は `number`、DB 列は `real` である。
 *   `buildNewMemoryFromCandidate` が無条件に `strength: 1` を書き、
 *   [ADR 0041](../../../../docs/decisions/0041-reinforce-does-not-change-strength.md) が
 *   「`reinforce` は `strength` を動かさない」と決めているだけであって、
 *   **型が 1 以下を保証してはいない。**
 *
 * **⟹ コメントに書くだけでは検査されない。**だから戻り値に載せる——
 * この配列は歯で中身を検査され、`recall()` の `omitted` にもそのまま出る。
 * **「この判定はこの前提の上に立っている」を、結果自身に名乗らせる。**
 */
export const DEFAULT_STRATEGY_BOUND_ASSUMPTIONS: readonly string[] = [
  "decay <= 1: 減衰の起点（lastReinforcedAt ?? recordedAt）が now より未来でないこと。" +
    "freshness と違い decay に clamp は無い（ADR 0036 は freshness だけを頭打ちにした）。",
  "strength <= 1: Memory.strength に 1 以外が書かれないこと。" +
    "書き込み側が無条件に 1 を書いているだけで、型（number）も DB 列（real）も保証していない。",
];

const scoreWithDefaultStrategy: ScoringStrategy = (input) => {
  const decay = defaultDecayStrategy.strengthAt(input.now, {
    recordedAt: input.recordedAt,
    lastReinforcedAt: input.lastReinforcedAt,
    strength: 1,
    halfLifeHours: input.halfLifeHours,
  });

  const freshness = Math.min(
    MAX_FRESHNESS,
    defaultDecayStrategy.strengthAt(input.now, {
      recordedAt: input.occurredAt ?? input.recordedAt,
      lastReinforcedAt: null,
      strength: 1,
      halfLifeHours: input.halfLifeHours,
    }),
  );

  const tagMatch = computeTagMatch(input.tags, input.queryTags);
  const similarity = input.similarity;
  const lexicalMatch = input.lexicalMatch;

  // affinity — 「この候補はクエリにどれだけ近いか」を1つの数にしたもの（ADR 0084 §5）。
  // lexicalMatch が無いときは similarity ?? 1 にそのまま退化する（本ファイル冒頭の doc）。
  const affinity =
    lexicalMatch === undefined
      ? (similarity ?? 1)
      : similarity === undefined
        ? lexicalMatch
        : Math.max(similarity, lexicalMatch);

  const total = affinity * decay * tagMatch * freshness * input.strength;

  const score: ScoreBreakdown = {
    decay,
    tagMatch,
    freshness,
    strength: input.strength,
    total,
  };
  if (similarity !== undefined) {
    score.similarity = similarity;
  }
  if (lexicalMatch !== undefined) {
    score.lexicalMatch = lexicalMatch;
  }
  return score;
};

/**
 * 既定のスコアリング戦略。**上界の宣言を持つ**（ADR 0069 §6）。
 *
 * `Object.assign` で関数へメソッドを生やしているのは、`ScoringStrategy`
 * （`(input) => ScoreBreakdown`）という**呼び出し可能な形をそのまま保つ**ためである——
 * 型を `{ score, bound }` のようなオブジェクトへ変えると、npm に出ている `0.1.1` の
 * 利用者を壊す。**能力を足すだけにする。**
 *
 * **上界の内訳**（`total` から `similarity` を除いた4項の積）:
 *
 * | 項 | 上界 | 保証か、前提か |
 * |---|---|---|
 * | `freshness` | `MAX_FRESHNESS`（= 1） | **保証** — `Math.min` が式の中に在る（ADR 0036） |
 * | `tagMatch` | `1 + 0.1 × queryTags.length` | **保証** — `computeTagMatch` の形そのもの。**候補側を見ずにクエリだけで決まる** |
 * | `decay` | 1 | **🔴 前提** — clamp が無い（`DEFAULT_STRATEGY_BOUND_ASSUMPTIONS`） |
 * | `strength` | 1 | **🔴 前提** — 型も DB 列も保証していない（同上） |
 *
 * **⚠ `tagMatch` の上界に候補側の `tags` を使わない。**使えば上界は縮むが、
 * それには「窓の外の候補の tags」を知る必要があり、**窓の外は見えないというのが前提そのもの**である。
 * クエリタグ数だけで決まる形だからこそ、見えない候補にも当てられる。
 *
 * **🔴 `lexicalMatch` はこの上界に入らない。入れてはならない**（ADR 0084 §7）。
 * この上界は **`total` から similarity の枠を除いた積**の上界であり、
 * `lexicalMatch` は `affinity` としてその枠**の中**に居る（本ファイル冒頭の doc）。
 * ⟹ 4項の積という形も値も、ADR 0084 で変わっていない。
 *
 * **⚠ ただし、この上界を使う判定のほう（`decideAnnTruncation`）は変わる。**
 * 語彙チャンネルが走っているとき、**ANN の窓の外の候補が `affinity = 1` を名乗りうる**
 * ——「窓の外の similarity は `sim_k'` 以下」という前提が成り立たなくなる。
 * ⟹ `recall-runtime.ts` は、語彙チャンネルが走った run では
 * `ann_truncated` を `certainty: 'undecidable'` に落とす（ADR 0084 §7）。
 */
export const defaultScoringStrategy: BoundedScoringStrategy = Object.assign(
  scoreWithDefaultStrategy,
  {
    nonSimilarityUpperBound(input: NonSimilarityBoundInput): NonSimilarityUpperBound {
      const freshnessMax = MAX_FRESHNESS;
      const tagMatchMax = 1 + input.queryTags.length * 0.1;
      const decayMax = 1;
      const strengthMax = 1;
      return {
        kind: "declared",
        value: freshnessMax * tagMatchMax * decayMax * strengthMax,
        assumptions: DEFAULT_STRATEGY_BOUND_ASSUMPTIONS,
      };
    },
  },
);
