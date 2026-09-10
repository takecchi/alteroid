import OpenAI from "openai";
// 型だけの import。`providers.ts` が本モジュールを値として import しているが、
// `import type` は実行時に消えるため循環にならない。
import type { ProviderMode } from "./providers.js";

/**
 * 本物の OpenAI を使ったとき、実際に何回叩き・何トークン使い・いくら掛かったかを
 * 実測する（PR 本文 (A)）。
 *
 * **`packages/openai` は変更しない。** `OpenAILLMProvider` / `OpenAIEmbeddingProvider` は
 * どちらもコンストラクタで `client`（`Pick<OpenAI, "chat">` / `Pick<OpenAI, "embeddings">`）を
 * 注入できる（`packages/openai/src/__tests__/*.test.ts` が同じ穴を使っている）。この
 * provider 自身は `client.chat.completions.create` / `client.embeddings.create` が返す
 * `response.usage` を読んだあとに `{content}` / `T` / `number[][]` へ絞ってから呼び出し側へ
 * 返す——**usage 情報はそこで捨てられる**。したがって計測は provider の外からではなく、
 * provider が握る `client` そのものを横取りする必要がある。
 *
 * ここでは**本物の `OpenAI` インスタンスをそのまま生成し、そのインスタンス自身の
 * `chat.completions.create` / `embeddings.create` を集計付きの実装へ差し替える**——
 * 偽の `client` オブジェクトを新たに組み立てる案は採らなかった。OpenAI SDK の
 * `Chat` / `Completions` / `Embeddings` は `APIResource`（`protected _client` を持つ）を
 * 継承しており、素のオブジェクトリテラルでは構造的に型を満たせない
 * （`packages/openai` の既存テストが `client: {...} as never` とキャストで回避しているのが
 * その証拠）。本物のインスタンスをその場で書き換える形なら、返す `client` の型は
 * 最初から正真正銘の `OpenAI` であり、余計なキャストを host 側の型に対して行わずに済む。
 */

// ---------------------------------------------------------------------------
// 費用の定数表
// ---------------------------------------------------------------------------

/**
 * ⚠ 2026-09 時点で OpenAI が公開している価格をそのままコードに書き写したものである。
 * OpenAI の Billing API・ダッシュボードから動的に取得した値ではない。
 * モデルの値下げ・値上げ・新モデルの追加があってもこの定数表は自動更新されない
 * ——実際の請求額の確認は OpenAI のダッシュボードで行うこと。
 */
const PRICING_USD_PER_MILLION_TOKENS: Readonly<
  Record<string, { readonly input: number; readonly output?: number }>
> = {
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
  "text-embedding-3-small": { input: 0.02 },
};

// ---------------------------------------------------------------------------
// 集計
// ---------------------------------------------------------------------------

export interface OpenAIUsageTotals {
  chatCalls: number;
  chatPromptTokens: number;
  chatCompletionTokens: number;
  embeddingCalls: number;
  embeddingPromptTokens: number;
}

export interface OpenAIUsageCost {
  llmInputUsd: number;
  llmOutputUsd: number;
  embeddingUsd: number;
  totalUsd: number;
}

export interface UsageMeterOptions {
  apiKey?: string;
  /** 費用計算に使う LLM のモデル名。`PRICING_USD_PER_MILLION_TOKENS` のキーと一致させること。 */
  llmModel: string;
  /** 費用計算に使う embedding のモデル名。同上。 */
  embeddingModel: string;
}

export interface UsageMeter {
  /**
   * `OpenAILLMProvider` / `OpenAIEmbeddingProvider` の `client` オプションへそのまま渡す、
   * 集計機能付きの本物の `OpenAI` クライアント。
   */
  client: OpenAI;
  totals(): OpenAIUsageTotals;
  cost(): OpenAIUsageCost;
  /** 画面に出す最終レポート（呼び出し回数・トークン・USD）。 */
  formatReport(): string;
}

/** `Stream<ChatCompletionChunk>` かどうか。`AsyncIterable` を実装している点で判別する。 */
function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return typeof value === "object" && value !== null && Symbol.asyncIterator in value;
}

/**
 * 本物の `OpenAI` クライアントを1つ作り、`chat.completions.create` /
 * `embeddings.create` を集計付きの実装へその場で差し替える。
 *
 * **型についての注記**: OpenAI SDK の `create` はオーバーロード関数
 * （streaming / non-streaming / base の3つ、embeddings は base64 / 通常の2つ）である。
 * ここで書く実装は「元の呼び出しをそのまま転送し、返ってきた Promise を横から読むだけ」
 * であり、この処理系自体はどのオーバーロードに対しても同じ形で正しく動く。ただし
 * 単一の実装関数の型を、宣言側の複数オーバーロードの型（各オーバーロードの戻り値が
 * 互いにナロー）にそのまま代入することは TypeScript の型システム上できない
 * （例: `ChatCompletionCreateParamsNonStreaming` 版の戻り値 `APIPromise<ChatCompletion>`
 * に対して、実装は union 型 `APIPromise<Stream<...> | ChatCompletion>` を返すため、
 * 個別のオーバーロードの戻り値へは狭められない）。そのため代入の最後に一度だけ
 * 宣言側の型へ `as` で戻す。**実際に呼び出すコード（`OpenAILLMProvider` /
 * `OpenAIEmbeddingProvider`）は streaming も base64 も使わないため、実行時には常に
 * 非 streaming・非 base64 の分岐だけを通る**——この `as` は「型が合わないものを
 * 無理やり通す」のではなく、「オーバーロード関数を汎用的にラップする際に TS が
 * 表現しきれない型の対応」を1箇所に閉じ込めるためのものである。
 */
export function createUsageMeter(options: UsageMeterOptions): UsageMeter {
  const client = new OpenAI({ apiKey: options.apiKey });

  const totals: OpenAIUsageTotals = {
    chatCalls: 0,
    chatPromptTokens: 0,
    chatCompletionTokens: 0,
    embeddingCalls: 0,
    embeddingPromptTokens: 0,
  };

  type ChatCreate = OpenAI["chat"]["completions"]["create"];
  const originalChatCreate = client.chat.completions.create.bind(client.chat.completions);
  const meteredChatCreate = ((
    body: Parameters<ChatCreate>[0],
    requestOptions?: Parameters<ChatCreate>[1],
  ) => {
    const result = originalChatCreate(body, requestOptions);
    result
      .then((response) => {
        if (!isAsyncIterable(response)) {
          totals.chatCalls += 1;
          totals.chatPromptTokens += response.usage?.prompt_tokens ?? 0;
          totals.chatCompletionTokens += response.usage?.completion_tokens ?? 0;
        }
      })
      .catch(() => {
        // 集計の失敗で本来の呼び出しを壊さない。エラー自体は呼び出し元へ返した
        // `result`（同じ Promise インスタンス）がそのまま伝えるので、ここで二重に
        // 投げたり握りつぶした事実を隠したりはしない。
      });
    return result;
  }) as ChatCreate;
  client.chat.completions.create = meteredChatCreate;

  type EmbeddingsCreate = OpenAI["embeddings"]["create"];
  const originalEmbeddingsCreate = client.embeddings.create.bind(client.embeddings);
  const meteredEmbeddingsCreate = ((
    body: Parameters<EmbeddingsCreate>[0],
    requestOptions?: Parameters<EmbeddingsCreate>[1],
  ) => {
    const result = originalEmbeddingsCreate(body, requestOptions);
    result
      .then((response) => {
        totals.embeddingCalls += 1;
        totals.embeddingPromptTokens += response.usage?.prompt_tokens ?? 0;
      })
      .catch(() => {
        // 同上。
      });
    return result;
  }) as EmbeddingsCreate;
  client.embeddings.create = meteredEmbeddingsCreate;

  function cost(): OpenAIUsageCost {
    const llmPricing = PRICING_USD_PER_MILLION_TOKENS[options.llmModel];
    const embeddingPricing = PRICING_USD_PER_MILLION_TOKENS[options.embeddingModel];
    if (!llmPricing || llmPricing.output === undefined) {
      throw new Error(
        `usage-meter: 価格表に "${options.llmModel}" の input/output 単価が無い。` +
          "PRICING_USD_PER_MILLION_TOKENS に追加すること。",
      );
    }
    if (!embeddingPricing) {
      throw new Error(
        `usage-meter: 価格表に "${options.embeddingModel}" の単価が無い。` +
          "PRICING_USD_PER_MILLION_TOKENS に追加すること。",
      );
    }
    const llmInputUsd = (totals.chatPromptTokens / 1_000_000) * llmPricing.input;
    const llmOutputUsd = (totals.chatCompletionTokens / 1_000_000) * llmPricing.output;
    const embeddingUsd = (totals.embeddingPromptTokens / 1_000_000) * embeddingPricing.input;
    return {
      llmInputUsd,
      llmOutputUsd,
      embeddingUsd,
      totalUsd: llmInputUsd + llmOutputUsd + embeddingUsd,
    };
  }

  function formatReport(): string {
    const t = totals;
    const c = cost();
    const usd = (n: number) => `$${n.toFixed(6)}`;
    return [
      "--- OpenAI API 実測（usage-meter） ---",
      `chat.completions.create: 呼び出し ${t.chatCalls} 回 / ` +
        `prompt_tokens=${t.chatPromptTokens} / completion_tokens=${t.chatCompletionTokens}`,
      `embeddings.create      : 呼び出し ${t.embeddingCalls} 回 / prompt_tokens=${t.embeddingPromptTokens}`,
      "費用（2026-09 時点の公開価格表による概算。OpenAI の請求 API から取得した実額ではない）:",
      `  LLM input  : ${usd(c.llmInputUsd)}`,
      `  LLM output : ${usd(c.llmOutputUsd)}`,
      `  Embedding  : ${usd(c.embeddingUsd)}`,
      `  合計       : ${usd(c.totalUsd)}`,
    ].join("\n");
  }

  return {
    client,
    totals: () => ({ ...totals }),
    cost,
    formatReport,
  };
}

/**
 * API を叩かなかった run で画面へ出す明示的な注記。**0 を黙って出さない**——
 * 「呼び出し0回・費用$0」という表示は、一見しただけでは「本物を叩いて0回だった」のか
 * 「そもそも叩いていない」のかが区別できない。後者であることを文字で明言する。
 *
 * ⚠ **モードを引数で必ず受け取る**（ADR 0051）。以前は引数を取らず、本文に
 * 「擬似 provider（@mnemora/testkit）で走っている」と決め打ちで書いていた。
 * `"recorded"`（記録の再生）が入ったことで**その決め打ちは嘘になった**——記録の再生は
 * 本物の応答に由来する値であり、意味を持たない stub とは別物である。
 * **呼び出し側に真実を言わせるため、引数は省略可能にしていない。**
 *
 * ⚠ **Issue #109 で見つけた実測の穴**: `"local"`（`@mnemora/local-embedding`、ADR
 * 0085）を足す前、この関数の `label` は `mode === "recorded" ? ... : mode ===
 * "deterministic" ? ... : "本物の OpenAI"` という2択のternaryだった。`"local"` は
 * どちらにも一致しないため**このelse節に落ち、実際にはローカル推論なのに「本物の
 * OpenAI」と印字されるところだった**——課金も外部通信も無いモードを「本物の
 * OpenAI」と表示する、まさにこの repo が繰り返し警告している「条件を落とした数字」
 * の一種。`switch` に直し、網羅性チェック（`never`）で同じ抜けが今後増えないようにする。
 */
export function formatNoApiCallsNotice(modes: {
  llmMode: ProviderMode;
  embeddingMode: ProviderMode;
}): string {
  const label = (mode: ProviderMode): string => {
    switch (mode) {
      case "recorded":
        return "記録の再生";
      case "deterministic":
        return "擬似 stub";
      case "local":
        return "ローカル推論（@mnemora/local-embedding、外部サービスに繋がない）";
      case "openai":
        return "本物の OpenAI";
      default: {
        const exhaustive: never = mode;
        throw new Error(`formatNoApiCallsNotice: 未知の ProviderMode: ${String(exhaustive)}`);
      }
    }
  };
  const usesRecorded = modes.llmMode === "recorded" || modes.embeddingMode === "recorded";
  return (
    "--- OpenAI API 実測（usage-meter） ---\n" +
    `この run では OpenAI の API を一切叩いていない（LLM=${label(modes.llmMode)} / ` +
    `埋め込み=${label(modes.embeddingMode)}）。` +
    "呼び出し回数・トークン・費用は計測対象が存在しない（0 ではなく、計測していない）。" +
    (usesRecorded
      ? "\n⚠ 「記録の再生」が返す値は本物の API 応答に由来するが、" +
        "**この run 自体は API を叩いていない**——費用と、値の出所は別の話である。"
      : "")
  );
}
