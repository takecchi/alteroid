import type { EmbeddingProvider, LLMProvider } from "@mnemora/core";
import { LocalEmbeddingProvider } from "@mnemora/local-embedding";
import { OpenAIEmbeddingProvider, OpenAILLMProvider } from "@mnemora/openai";
import type { Cassette, CassetteRecorder } from "@mnemora/testkit";
import {
  DeterministicEmbeddingProvider,
  DeterministicLLMProvider,
  RecordedEmbeddingProvider,
  RecordedLLMProvider,
  RecordingEmbeddingProvider,
  RecordingLLMProvider,
} from "@mnemora/testkit";
import type { UsageMeter } from "./usage-meter.js";
import { createUsageMeter } from "./usage-meter.js";

/**
 * サンプルアプリが実際に使う provider の切り替え（PR 本文「LLM/Embedding は実 API キーが
 * 無くても動く」）。
 *
 * **黙って擬似物へフォールバックしない**——`mode` を呼び出し側（cli.ts）に返し、
 * 画面に必ず表示させる。どちらで動いているかを隠さない、という原則の姿3の適用。
 *
 * **LLM と Embedding を別々に選べる（本 PR の拡張）。** 理由: retrieval-quality の
 * ベンチで「順位が変わったのは埋め込みのせいか抽出のせいか」を切り分けたい場合、
 * 一方だけを本物に入れ替えられる必要がある。`MNEMORA_LLM` / `MNEMORA_EMBEDDING`
 * （`"openai" | "deterministic"`）で個別に上書きできる——**未指定なら、いままで通り
 * `OPENAI_API_KEY` の有無だけで両方が決まる**（`selectProviderMode` の契約は変えない。
 * 既存テストはこの2つの環境変数を設定しないため、そのまま通る）。
 */
/**
 * `"recorded"` は ADR 0051 で足した第3のモード——**記録した実 API の応答を再生する**。
 *
 * `"deterministic"`（意味を持たない stub）とも `"openai"`（実 API を叩く）とも違う。
 * 記録済みの入力に対しては `"openai"` と同じベクトル・同じ抽出結果を返し、
 * 記録に無い入力に対しては例外を投げる（黙って stub へ倒れない）。
 */
/**
 * `"local"` は Issue #109 で足した第4のモード——**`@mnemora/local-embedding`
 *（外部サービスへ繋がない、プロセス内 ONNX 推論、ADR 0085）を使う**。
 *
 * ⚠ **embedding 専用である。LLM 側に `"local"` は無い。** `@mnemora/local-embedding` は
 * `EmbeddingProvider` しか実装していない——LLM の代替は無い。`MNEMORA_LLM=local` は
 * 他の未知の値と同じく例外になる（`parseModeOverride` 参照）。`MNEMORA_EMBEDDING=local`
 * だけが有効。
 */
export type ProviderMode = "openai" | "deterministic" | "recorded" | "local";

export interface Providers {
  /**
   * 後方互換のために残す単一ラベル。`MNEMORA_LLM`/`MNEMORA_EMBEDDING` を使わない
   * 呼び出し（既存の `chat`/`compare`）では `llmMode`/`embeddingMode` と必ず一致する。
   * 個別に上書きした場合にどちらの実体を指すかは曖昧になるため、**新しいコードは
   * `llmMode`/`embeddingMode` を見ること**。
   */
  mode: ProviderMode;
  llmMode: ProviderMode;
  embeddingMode: ProviderMode;
  llmProvider: LLMProvider;
  embeddingProvider: EmbeddingProvider;
  /** `llmMode`/`embeddingMode` のどちらかが `"openai"` のときだけ存在する。 */
  usageMeter?: UsageMeter;
}

/** 本物の OpenAI を使う場合のモデル選定。サンプルアプリの裁量値であり、強い根拠は無い。 */
export const OPENAI_LLM_MODEL = "gpt-4o-mini";
export const OPENAI_EMBEDDING_MODEL = "text-embedding-3-small";
/** 次元を絞って埋め込みテーブル・HNSW 索引を軽くする（サンプルアプリの裁量値）。 */
export const OPENAI_EMBEDDING_DIMENSIONS = 256;

/** 擬似 provider が使う埋め込み空間。`DeterministicEmbeddingProvider` の既定と揃える。 */
export const DETERMINISTIC_EMBEDDING_SPACE = {
  provider: "testkit",
  model: "deterministic",
  dimensions: 8,
};

export type EnvLike = Partial<Record<string, string | undefined>>;

/**
 * `OPENAI_API_KEY` が空でない値として存在するかどうかだけを見る、切り替えの単一の分岐点。
 * `createProviders` から切り出してあるのは、副作用（provider の構築）無しに分岐の単体テストを
 * 書けるようにするため。
 *
 * **この関数のシグネチャ・振る舞いは変えていない**（既存テスト `providers.test.ts` が
 * 直接呼んでいるため）。`MNEMORA_LLM`/`MNEMORA_EMBEDDING` による個別上書きは
 * `selectLLMMode`/`selectEmbeddingMode` という別関数に足す。
 */
export function selectProviderMode(env: EnvLike): ProviderMode {
  return env.OPENAI_API_KEY ? "openai" : "deterministic";
}

/**
 * `MNEMORA_LLM` が受け付ける値。**`"local"` を含まない**——LLM 側に local 実装は無い
 * （`ProviderMode` の docstring 参照）。
 */
const LLM_MODES = ["openai", "deterministic", "recorded"] as const;

/**
 * `MNEMORA_EMBEDDING` が受け付ける値。`LLM_MODES` に `"local"` を足した形
 * （Issue #109、`@mnemora/local-embedding`）。
 */
const EMBEDDING_MODES = ["openai", "deterministic", "recorded", "local"] as const;

/**
 * `MNEMORA_LLM`/`MNEMORA_EMBEDDING` の値を検証する。空文字は「未指定」として扱う。
 *
 * **許可する値の集合を呼び出し側から渡す**（`LLM_MODES`/`EMBEDDING_MODES`）——
 * LLM と embedding で受け付ける `ProviderMode` の集合が違う（`"local"` は embedding だけ）
 * ため、1つの固定リストでは表現できない。**未知の値は例外**という既存の作法は変えない。
 */
function parseModeOverride(
  varName: "MNEMORA_LLM" | "MNEMORA_EMBEDDING",
  value: string | undefined,
  allowed: readonly ProviderMode[],
): ProviderMode | undefined {
  if (value === undefined || value === "") {
    return undefined;
  }
  if ((allowed as readonly string[]).includes(value)) {
    return value as ProviderMode;
  }
  throw new Error(
    `${varName} には ${allowed.map((m) => `"${m}"`).join(" / ")} のいずれかを指定すること` +
      `（実際: "${value}"）。`,
  );
}

/** `MNEMORA_LLM` が指定されていればそれを、無ければ `selectProviderMode` の結果を使う。 */
export function selectLLMMode(env: EnvLike): ProviderMode {
  return parseModeOverride("MNEMORA_LLM", env.MNEMORA_LLM, LLM_MODES) ?? selectProviderMode(env);
}

/** `MNEMORA_EMBEDDING` が指定されていればそれを、無ければ `selectProviderMode` の結果を使う。 */
export function selectEmbeddingMode(env: EnvLike): ProviderMode {
  return (
    parseModeOverride("MNEMORA_EMBEDDING", env.MNEMORA_EMBEDDING, EMBEDDING_MODES) ??
    selectProviderMode(env)
  );
}

// ---------------------------------------------------------------------------
// カセット再生か実 API かを決める(ADR 0068 ③)
//
// **現物の欠陥**: `cli.ts` の `resolveCassetteForRun` は「`OPENAI_API_KEY` が在れば
// 無条件に実 API」だった。カセット(`examples/chat/cassettes/*.json`)が在っても、
// キーが環境にあるだけで再生のつもりが実 API に倒れる——「明示すればカセットを
// 使える口」がどこにも無かった。
//
// **既定の振る舞いは変えない**（「キーが在れば実 API」は誰かが選んだ意図かもしれない）。
// `MNEMORA_PROVIDER_SOURCE` で**明示したときだけ**、キーの有無を上書きできる能力を足す。
// ---------------------------------------------------------------------------

/**
 * どちらを使うか と、なぜそう決まったか。**理由を捨てない**——`reason` が無いと
 * 「たまたま recorded になった」のか「明示して recorded にした」のかを画面から
 * 区別できず、ADR 0051 の「どちらで走ったかを隠さない」規律が骨抜きになる。
 */
export type ProviderSourceDecision =
  | { source: "openai"; reason: "key-present" }
  | { source: "recorded"; reason: "no-key" }
  | { source: "recorded"; reason: "forced" }
  | { source: "openai"; reason: "forced" };

/**
 * `MNEMORA_PROVIDER_SOURCE` が指定されていればそれを最優先する(カセット側はキーの有無に
 * 関わらず強制できる)。未指定(未設定または空文字)なら、いままで通り `OPENAI_API_KEY` の
 * 有無だけで決まる。
 *
 * **未知の値は例外**(`parseModeOverride` と同じ作法)——黙って既定へ倒れない。
 * **`"openai"` をキー無しで強制された場合も例外**(下のコメント参照)。
 */
export function decideProviderSource(env: EnvLike): ProviderSourceDecision {
  const forced = env.MNEMORA_PROVIDER_SOURCE;
  if (forced === "recorded") {
    return { source: "recorded", reason: "forced" };
  }
  if (forced === "openai") {
    // **キーが無いのに `openai` を強制されたら落とす。**
    //
    // ⚠ ここを「そのまま返す」だけにすると、この ADR が塞ごうとしている欠陥が
    // **新しい形で復活する**——呼び出し側(`cli.ts` の `runCompare`)は
    // `source === "openai"` のときカセットを読まずに `process.env` をそのまま
    // `createProviders` へ渡すので、`selectProviderMode` が「キーが無い ⟹
    // deterministic」と判定する。結果、**画面には「実 API を叩く」と出しながら
    // 意味を持たない擬似 provider で走り、数字の表を出して EXIT=0 で終わる**
    // (実装の途中で実際にこの状態を踏み、走らせて確認した。ADR 0068 参照)。
    //
    // **⟹「明示した source と、実際に使われる provider が食い違う」経路を作らない。**
    // これは ADR 0051 が `requireCassette` で引いたのと同じ線であり、
    // 反対側(`recorded` を強制したのにカセットが無い)は既にそこで落ちている。
    if (!env.OPENAI_API_KEY) {
      throw new Error(
        'MNEMORA_PROVIDER_SOURCE="openai" を指定したが、OPENAI_API_KEY が無い（ADR 0068）。' +
          "キーを設定するか、指定を外すこと（未指定なら記録の再生になる）。" +
          "黙って擬似 provider へは倒れない。",
      );
    }
    return { source: "openai", reason: "forced" };
  }
  if (forced !== undefined && forced !== "") {
    throw new Error(
      `MNEMORA_PROVIDER_SOURCE には "openai" / "recorded" のいずれかを指定すること` +
        `（実際: "${forced}"）。`,
    );
  }
  return env.OPENAI_API_KEY
    ? { source: "openai", reason: "key-present" }
    : { source: "recorded", reason: "no-key" };
}

/** `decideProviderSource` の結果を、画面に出すための一文にする。 */
export function describeProviderSourceReason(decision: ProviderSourceDecision): string {
  switch (decision.reason) {
    case "key-present":
      return "OPENAI_API_KEY が在るため実 API";
    case "no-key":
      return "OPENAI_API_KEY が無いため記録を再生";
    case "forced":
      return decision.source === "recorded"
        ? "MNEMORA_PROVIDER_SOURCE=recorded の明示指定（OPENAI_API_KEY の有無に関わらず再生する）"
        : "MNEMORA_PROVIDER_SOURCE=openai の明示指定（実 API を叩く）";
    default: {
      const exhaustive: never = decision;
      throw new Error(`describeProviderSourceReason: 未知の reason: ${JSON.stringify(exhaustive)}`);
    }
  }
}

export interface CreateProvidersOptions {
  /**
   * `"recorded"` モードで再生に使うカセット（ADR 0051）。`"recorded"` を選んだのに
   * これが無ければ**構築時に落ちる**——カセット未指定を「じゃあ擬似物で」と読み替えない。
   */
  cassette?: Cassette;
  /**
   * 実 API の入出力を記録する（ADR 0051）。`"openai"` を選んだ側だけが記録の対象になる
   * ——叩いていない API は記録しようがない。
   */
  recorder?: CassetteRecorder;
}

export function createProviders(
  env: EnvLike = process.env,
  options: CreateProvidersOptions = {},
): Providers {
  const mode = selectProviderMode(env);
  const llmMode = selectLLMMode(env);
  const embeddingMode = selectEmbeddingMode(env);
  const { cassette, recorder } = options;

  const requireCassette = (which: string): Cassette => {
    if (cassette === undefined) {
      throw new Error(
        `${which} に "recorded" を指定したが、カセットが渡されていない（ADR 0051）。` +
          "先に `record` サブコマンドで記録すること。",
      );
    }
    return cassette;
  };

  // LLM・Embedding のどちらか一方でも本物を使うなら、1つの usage-meter（1つの実
  // OpenAI クライアント）を両方で共有する——呼び出し回数・トークン・費用をこのプロセスの
  // 実行全体で一箇所に集計するため（PR 本文 (A)）。
  const usageMeter =
    llmMode === "openai" || embeddingMode === "openai"
      ? createUsageMeter({
          apiKey: env.OPENAI_API_KEY,
          llmModel: OPENAI_LLM_MODEL,
          embeddingModel: OPENAI_EMBEDDING_MODEL,
        })
      : undefined;

  const buildLLM = (): LLMProvider => {
    if (llmMode === "recorded") {
      return new RecordedLLMProvider({
        section: requireCassette("MNEMORA_LLM").llm,
        expectedModel: OPENAI_LLM_MODEL,
      });
    }
    if (llmMode !== "openai") {
      return new DeterministicLLMProvider();
    }
    const real = new OpenAILLMProvider({
      apiKey: env.OPENAI_API_KEY,
      model: OPENAI_LLM_MODEL,
      client: usageMeter?.client,
    });
    return recorder ? new RecordingLLMProvider(real, recorder, OPENAI_LLM_MODEL) : real;
  };

  const buildEmbedding = (): EmbeddingProvider => {
    if (embeddingMode === "recorded") {
      return new RecordedEmbeddingProvider({
        section: requireCassette("MNEMORA_EMBEDDING").embedding,
        expectedSpace: {
          provider: "openai",
          model: OPENAI_EMBEDDING_MODEL,
          dimensions: OPENAI_EMBEDDING_DIMENSIONS,
        },
      });
    }
    // Issue #109: 外部サービスへ繋がない埋め込み（ADR 0085）。鍵もカセットも要らない
    // ——`recorded`/`openai` より先に見る必要は無いが、`!== "openai"` の擬似物 fallback
    // より先に見ないと `local` が誤って `DeterministicEmbeddingProvider` に落ちてしまう。
    if (embeddingMode === "local") {
      // `MNEMORA_LOCAL_EMBEDDING_CACHE_DIR` が指定されていれば `cacheDir` として渡す
      // （`LocalEmbeddingProvider` のコンストラクタが元から持つオプション——**使うだけで
      // このパッケージ自体は変更していない**）。CI の `identifier-probes` ジョブが
      // `actions/cache` でモデル重みをキャッシュする場所を固定するために使う——
      // transformers.js の既定（`~/.cache/huggingface`）は環境によって場所が変わりうる
      // ため、明示したパスのほうが「次の実行でも同じ場所を見る」ことを保証しやすい。
      const cacheDir = env.MNEMORA_LOCAL_EMBEDDING_CACHE_DIR;
      return new LocalEmbeddingProvider(cacheDir ? { cacheDir } : {});
    }
    if (embeddingMode !== "openai") {
      return new DeterministicEmbeddingProvider(DETERMINISTIC_EMBEDDING_SPACE);
    }
    const real = new OpenAIEmbeddingProvider({
      apiKey: env.OPENAI_API_KEY,
      model: OPENAI_EMBEDDING_MODEL,
      dimensions: OPENAI_EMBEDDING_DIMENSIONS,
      client: usageMeter?.client,
    });
    return recorder ? new RecordingEmbeddingProvider(real, recorder) : real;
  };

  const llmProvider = buildLLM();
  const embeddingProvider = buildEmbedding();

  return {
    mode,
    llmMode,
    embeddingMode,
    llmProvider,
    embeddingProvider,
    ...(usageMeter !== undefined ? { usageMeter } : {}),
  };
}
