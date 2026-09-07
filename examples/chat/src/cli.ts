#!/usr/bin/env node
import { heuristicTokenCounter } from "@mnemora/core";
import { CassetteRecorder } from "@mnemora/testkit";
import type { CassetteTarget } from "./cassette-io.js";
import {
  cassetteExists,
  cassettePathFor,
  describeCassette,
  loadCassette,
  parseCassetteTarget,
  saveCassette,
} from "./cassette-io.js";
import {
  DEFAULT_COMPARE_SEQUENCE,
  formatComparisonTable,
  formatRecallQualityTable,
  runComparison,
} from "./compare.js";
import { formatRecall } from "./format.js";
import { buildMnemoraPrompt, ingestConversation, queryRecall } from "./mnemora-path.js";
import { measureNaive, naivePrompt } from "./naive-path.js";
import type { ProviderMode } from "./providers.js";
import {
  formatArmDetail,
  formatArmSummaryTable,
  formatProbeComparisonTable,
  runRetrievalQualityArm,
} from "./retrieval-quality.js";
import { createExampleRuntime } from "./runtime-factory.js";
import { buildConversation } from "./scenario.js";
import { formatBackfillDemo, runBackfillDemo } from "./backfill.js";
import { formatScopeDemo, runScopeDemo } from "./scope.js";
import { createMutableClock } from "./mutable-clock.js";
import { formatTimeTermReport, runTimeTermArm } from "./time-term-arm.js";
import { formatNoApiCallsNotice } from "./usage-meter.js";

/** `chat` サブコマンドで使う会話の長さ(filler 往復数)。サンプルアプリの裁量値。 */
const DEFAULT_CHAT_FILLER_PAIRS = 8;
/** budget が実際に切り詰めることを見せるための、意図的に小さい文字数予算。 */
const TINY_BUDGET_CHARS = 60;

function requireDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL が設定されていません。mnemora は Postgres + pgvector を要求する " +
        "（docs/roadmap.md 段階2）。examples/chat/README.md の手順でローカル DB を用意し、" +
        "DATABASE_URL を設定してから実行すること。",
    );
  }
  return url;
}

/**
 * **3層すべてを名指しする**（ADR 0051）。
 *
 * ⚠ ここは一度壊れていた——`ProviderMode` に `"recorded"` を足したとき、この関数は
 * 「`openai` でなければ擬似 provider」のままだった。その結果、記録を再生している run が
 * 画面には「決定的な擬似 provider」と出て、**同じ report の別の行（`llm=recorded`）と
 * 矛盾していた。**ADR 0051 が「どちらで走ったかを隠さない」ことを土台にしている以上、
 * これは最も起こしてはならない壊れ方である。**モードを増やすときは必ずここも増やすこと。**
 */
function describeMode(mode: ProviderMode): string {
  switch (mode) {
    case "openai":
      return "本物の OpenAI";
    case "recorded":
      return "記録した実 API 応答の再生（ADR 0051）";
    case "deterministic":
      return "@mnemora/testkit の決定的な擬似 provider";
    default: {
      const exhaustive: never = mode;
      throw new Error(`describeMode: 未知の ProviderMode: ${String(exhaustive)}`);
    }
  }
}

/**
 * どの組み合わせで動いているかを必ず画面に出す(黙って擬似物にフォールバックしない、
 * という原則の適用)。`MNEMORA_LLM`/`MNEMORA_EMBEDDING` で LLM と embedding を別々に
 * 上書きできるようになったため、`mode` 1個ではなく `llmMode`/`embeddingMode` を
 * それぞれ表示する。
 */
function printProviderMode(llmMode: ProviderMode, embeddingMode: ProviderMode): void {
  console.log(`[provider] LLM       : ${describeMode(llmMode)}`);
  console.log(`[provider] Embedding : ${describeMode(embeddingMode)}`);
  if (embeddingMode === "deterministic") {
    console.log(
      "  ⚠ 擬似 embedding は意味的な類似度を表現しないため、このモードでは recall の" +
        "関連度そのものは評価できない（examples/chat/README.md「正直に書くべき限界」参照）。",
    );
  }
}

/**
 * この実行が実 API を使うのか、記録の再生を使うのかを決める（ADR 0051 / 0052）。
 *
 * **キーがあれば実 API、無ければ記録。どちらでもなければ落ちる**——
 * 「記録が無いなら擬似物で」と読み替えない。擬似物は意味を持たない stub であり、
 * それで出た数字を物差しの表に載せると嘘になる（ADR 0051）。
 *
 * 返り値が `undefined` なら実 API を使う、という意味である。
 */
function resolveCassetteForRun(target: CassetteTarget) {
  if (process.env.OPENAI_API_KEY) {
    return undefined;
  }
  const path = cassettePathFor(target);
  if (!cassetteExists(path)) {
    throw new Error(
      `${target} を実キー無しで走らせるには記録が要る。OPENAI_API_KEY を設定するか、` +
        `先に \`record ${target}\` でカセットを作ること（ADR 0052）。`,
    );
  }
  const cassette = loadCassette(path);
  console.log(`[cassette] 記録した応答を再生する: ${describeCassette(cassette)}`);
  console.log(
    "  ⚠ これは記録した時点の API の姿である。実 API との乖離は `verify` で確かめること。",
  );
  return cassette;
}

async function runChat(): Promise<void> {
  const handle = await createExampleRuntime(requireDatabaseUrl());
  printProviderMode(handle.llmMode, handle.embeddingMode);
  try {
    const ctx = { tenantId: `example-chat-${Date.now()}` };
    const conversation = buildConversation(DEFAULT_CHAT_FILLER_PAIRS);

    console.log("\n=== 会話（全ターン） ===");
    for (const turn of conversation.turns) {
      console.log(`${turn.role}: ${turn.text}`);
    }
    console.log(`user(質問): ${conversation.query}`);

    console.log("\n=== 経路A（naive）: 会話ログを全部プロンプトへ積む ===");
    console.log(naivePrompt(conversation));
    const naive = measureNaive(conversation, heuristicTokenCounter);
    console.log(
      `naive usage: chars=${naive.chars} estimatedTokens=${naive.estimatedTokens} (counter=${naive.counter})`,
    );

    console.log("\n=== 経路B（mnemora）: observe() → tick() ===");
    await ingestConversation(handle.runtime, ctx, conversation);
    console.log(
      `${conversation.userUtterances.length} 件の user 発話を observe() し、tick() で embed を処理した。`,
    );

    console.log("\n=== recall()（budget 無し） ===");
    const withoutBudget = await queryRecall(handle.runtime, ctx, conversation);
    console.log(formatRecall(withoutBudget, "budget 無し"));
    console.log("呼び出し側がプロンプトへ積む文字列（recall() の返り値だけから組み立てる例）:");
    console.log(buildMnemoraPrompt(withoutBudget));

    console.log(
      `\n=== budget を渡すと実際に切り詰められる（maxMemoryChars=${TINY_BUDGET_CHARS}） ===`,
    );
    const withBudget = await queryRecall(handle.runtime, ctx, conversation, {
      budget: { maxMemoryChars: TINY_BUDGET_CHARS },
    });
    console.log(formatRecall(withBudget, `budget maxMemoryChars=${TINY_BUDGET_CHARS}`));

    console.log("\n=== まとめ ===");
    console.log(`naive chars                  : ${naive.chars}`);
    console.log(`mnemora chars (budget 無し)      : ${withoutBudget.usage.chars}`);
    console.log(`mnemora chars (budget あり)      : ${withBudget.usage.chars}`);
    console.log(
      "budget_dropped omission (budget あり):",
      withBudget.omitted.find((o) => o.kind === "budget_dropped") ?? "(発生しなかった)",
    );

    console.log("");
    console.log(
      handle.usageMeter
        ? handle.usageMeter.formatReport()
        : formatNoApiCallsNotice({
            llmMode: handle.llmMode,
            embeddingMode: handle.embeddingMode,
          }),
    );
  } finally {
    await handle.close();
  }
}

/**
 * `tenantId`/`subjectId` のスコープを「動く例」で見せるデモ(`src/scope.ts`)。
 * 北極星の主測定(`compare`/`retrieval`)には触れない、独立したデモ実行——
 * `runScopeDemo`/`formatScopeDemo` は `compare.ts`/`retrieval-quality.ts` を import しない。
 */
async function runScope(): Promise<void> {
  const handle = await createExampleRuntime(requireDatabaseUrl());
  printProviderMode(handle.llmMode, handle.embeddingMode);
  try {
    const tenantId = `example-chat-scope-${Date.now()}`;
    const otherTenantId = `${tenantId}-other`;
    console.log(
      "\n同じテナントの中に alice/bob という2つの subject を作り、別テナントも1つ用意して、" +
        "recall() のスコープの違いを実演する。\n",
    );
    const result = await runScopeDemo(handle.runtime, tenantId, otherTenantId);
    console.log(formatScopeDemo(result));
  } finally {
    await handle.close();
  }
}

/**
 * `observe()` の `occurredAt` を「動く例」で見せるデモ(`src/backfill.ts`、ADR 0037)。
 * 同じ2発話・同じ問い合わせを、`occurredAt` を渡す側と渡さない側の2テナントで走らせ、
 * **同じ問い合わせが取り込み方だけで別の答えを返す**ことを並べて見せる。
 * 北極星の主測定(`compare`/`retrieval`)には触れない、独立したデモ実行。
 */
async function runBackfill(): Promise<void> {
  const handle = await createExampleRuntime(requireDatabaseUrl());
  printProviderMode(handle.llmMode, handle.embeddingMode);
  try {
    const base = `example-chat-backfill-${Date.now()}`;
    console.log(
      "\n生の会話ログを後から取り込む(backfill)と、recordedAt は取り込んだ今日になる。" +
        "occurredAt を渡すかどうかで、同じ recall() が別の答えを返すことを実演する。\n",
    );
    const result = await runBackfillDemo(handle.runtime, {
      withOccurredAt: `${base}-with`,
      withoutOccurredAt: `${base}-without`,
    });
    console.log(formatBackfillDemo(result));
  } finally {
    await handle.close();
  }
}

async function runCompare(): Promise<void> {
  const databaseUrl = requireDatabaseUrl();
  // `retrieval` と同じ規律（ADR 0051）: キーがあれば実 API、無ければ記録の再生。
  // **どちらで走ったかは必ず画面に出す。**
  const cassette = resolveCassetteForRun("compare");
  const handle = await createExampleRuntime(
    databaseUrl,
    cassette
      ? { ...process.env, MNEMORA_LLM: "recorded", MNEMORA_EMBEDDING: "recorded" }
      : process.env,
    cassette ? { cassette } : {},
  );
  printProviderMode(handle.llmMode, handle.embeddingMode);
  try {
    console.log(
      "\n会話の長さを変えて、経路A（naive）と経路B（mnemora, budget 無し）の焼かれる量を測る。\n",
    );
    const rows = await runComparison(handle.runtime, {
      fillerPairsSequence: DEFAULT_COMPARE_SEQUENCE,
      memoryStore: handle.memoryStore,
    });
    console.log(formatComparisonTable(rows));
    console.log(
      "\n(注) mnemora chars は recall() の budget 無し usage.chars。切り詰めていない、そのままの量。",
    );

    console.log(
      "\n量を削っただけでは北極星の物差しに答えられない——" +
        "「削っても冒頭の事実が残っているか」「実際に何件と競って絞ったか」を測る:\n",
    );
    console.log(formatRecallQualityTable(rows));
    console.log(
      "\n(注) 「ANN の候補になれた件数」が「スコープ内の Memory」を下回っていたら、" +
        "そのぶんは `omitted` の `not_indexed` に理由付きで出ている" +
        "（docs/decisions/0021-drain-embed-ticks-in-ingest.md）。",
    );
    console.log("");
    console.log(
      handle.usageMeter
        ? handle.usageMeter.formatReport()
        : formatNoApiCallsNotice({
            llmMode: handle.llmMode,
            embeddingMode: handle.embeddingMode,
          }),
    );
  } finally {
    await handle.close();
  }
}

/**
 * PR 本文 (D)。arm A(擬似LLM+擬似embedding)・B(擬似LLM+本物embedding)・
 * C(本物LLM+本物embedding)の3通りを順に走らせ、probe set の順位を比較する。
 *
 * **arm ごとに別のテナントを使う**(PR 本文「実行時の規律」)——`runRetrievalQualityArm`
 * 自体は tenantId を受け取るだけで固定しないため、ここで3つの固定 tenantId を渡す。
 *
 * B・C は本物の OpenAI(embedding、C はさらに LLM も)を叩く。**CI には載せていない**——
 * `.github/**` は変更していない。本物の API を叩く実行はこのコマンドを手動で叩いたときだけ。
 */
/**
 * arm の定義（ADR 0051 で `source` を足した）。
 *
 * `source` は「本物の API を叩くか、記録した応答を再生するか」だけを切り替える。
 * **arm の意味（どちらが擬似で、どちらが本物由来か）は変えていない**——arm B は
 * 「擬似LLM＋本物由来の埋め込み」のままである。記録は本物の応答そのものなので、
 * ラベルの意味は保たれる。
 */
function buildArmSpecs(source: "openai" | "recorded"): {
  armLabel: string;
  tenantId: string;
  llmOverride: ProviderMode;
  embeddingOverride: ProviderMode;
  /**
   * この arm が実 API に触れるか。`record` は**この欄で**対象を選ぶ——
   * tenantId の文字列一致で除外すると、arm の id を変えた瞬間に静かに壊れる。
   */
  touchesApi: boolean;
}[] {
  return [
    {
      armLabel: "A: 擬似LLM+擬似埋め込み",
      tenantId: "retrieval-quality-arm-a",
      llmOverride: "deterministic",
      embeddingOverride: "deterministic",
      touchesApi: false,
    },
    {
      armLabel: "B: 擬似LLM+本物の埋め込み",
      tenantId: "retrieval-quality-arm-b",
      llmOverride: "deterministic",
      embeddingOverride: source,
      touchesApi: true,
    },
    {
      armLabel: "C: 本物LLM+本物の埋め込み",
      tenantId: "retrieval-quality-arm-c",
      llmOverride: source,
      embeddingOverride: source,
      touchesApi: true,
    },
  ];
}

async function runRetrieval(): Promise<void> {
  const databaseUrl = requireDatabaseUrl();

  // **キーがあれば本物、無ければ記録の再生。どちらで走ったかは必ず画面に出す**
  // （黙って別のものへ倒れない、という既存の規律の適用。ADR 0051）。
  // 判定は `compare` と同じ `resolveCassetteForRun` に寄せてある（ADR 0052）。
  const cassette = resolveCassetteForRun("retrieval");
  const armSpecs = buildArmSpecs(cassette ? "recorded" : "openai");

  const reports = [];
  for (const arm of armSpecs) {
    console.log(`\n########## arm ${arm.armLabel} ##########`);
    const handle = await createExampleRuntime(
      databaseUrl,
      {
        ...process.env,
        MNEMORA_LLM: arm.llmOverride,
        MNEMORA_EMBEDDING: arm.embeddingOverride,
      },
      cassette ? { cassette } : {},
    );
    printProviderMode(handle.llmMode, handle.embeddingMode);
    try {
      const report = await runRetrievalQualityArm({
        armLabel: arm.armLabel,
        tenantId: arm.tenantId,
        runtime: handle.runtime,
        memoryStore: handle.memoryStore,
        llmMode: handle.llmMode,
        embeddingMode: handle.embeddingMode,
        ...(handle.usageMeter !== undefined ? { usageMeter: handle.usageMeter } : {}),
      });
      reports.push(report);
      console.log(formatArmDetail(report));
    } finally {
      await handle.close();
    }
  }

  console.log("\n\n=== probe ごとの比較(3 arm を並べる) ===");
  console.log(formatProbeComparisonTable(reports));
  console.log("\n=== arm ごとのまとめ ===");
  console.log(formatArmSummaryTable(reports));
}

/**
 * 実 API の応答を記録してカセットに書き出す（ADR 0051）。
 *
 * **再生する当のもの（`retrieval` の arm B・C）をそのまま走らせて録る。**
 * probe set を読んで「必要そうな入力」を列挙する形は採らない——列挙が漏れると、
 * 再生時に「記録に無い」で落ちる。実行経路そのものが唯一の正しい入力一覧である。
 *
 * **arm B と C の両方を録る必要がある。**arm B は擬似 LLM が作った digest を、
 * arm C は本物の LLM が書き換えた digest を埋め込む——**埋め込みへの入力が arm 間で違う**。
 * arm A は API を一切叩かないため、記録の対象にならない。
 */
/**
 * `retrieval` の arm B・C を実 API で走らせて記録する（ADR 0051）。
 *
 * arm A は API を一切叩かないため記録の対象にならない。arm B と C の**両方**が要る——
 * arm B は擬似 LLM が作った digest を、arm C は本物の LLM が書き換えた digest を
 * 埋め込むので、**埋め込みへの入力が arm 間で違う。**
 */
async function recordRetrieval(
  databaseUrl: string,
  recorder: CassetteRecorder,
  runId: number,
): Promise<void> {
  // **id の文字列一致ではなく、宣言された欄で選ぶ。**
  const armSpecs = buildArmSpecs("openai").filter((a) => a.touchesApi);
  for (const arm of armSpecs) {
    console.log(`\n########## 記録中: arm ${arm.armLabel} ##########`);
    const handle = await createExampleRuntime(
      databaseUrl,
      { ...process.env, MNEMORA_LLM: arm.llmOverride, MNEMORA_EMBEDDING: arm.embeddingOverride },
      { recorder },
    );
    printProviderMode(handle.llmMode, handle.embeddingMode);
    try {
      await runRetrievalQualityArm({
        armLabel: arm.armLabel,
        tenantId: `${arm.tenantId}-record-${runId}`,
        runtime: handle.runtime,
        memoryStore: handle.memoryStore,
        llmMode: handle.llmMode,
        embeddingMode: handle.embeddingMode,
        ...(handle.usageMeter !== undefined ? { usageMeter: handle.usageMeter } : {}),
      });
    } finally {
      await handle.close();
    }
  }
}

/**
 * `compare` の全会話長を実 API で走らせて記録する（ADR 0052）。
 *
 * **`retrieval` より1桁高い。**`DEFAULT_COMPARE_SEQUENCE` の合計 = Σ(fillerPairs+1) 回の
 * LLM 呼び出しが要る（ADR 0019 §3 の見積もりで657回・約8〜15分・約 $0.023）。
 * だからこそ `record` は対象を明示させる（`parseCassetteTarget`）。
 */
async function recordCompare(
  databaseUrl: string,
  recorder: CassetteRecorder,
  runId: number,
): Promise<void> {
  console.log("\n########## 記録中: compare（全会話長） ##########");
  const handle = await createExampleRuntime(
    databaseUrl,
    { ...process.env, MNEMORA_LLM: "openai", MNEMORA_EMBEDDING: "openai" },
    { recorder },
  );
  printProviderMode(handle.llmMode, handle.embeddingMode);
  try {
    const rows = await runComparison(handle.runtime, {
      fillerPairsSequence: DEFAULT_COMPARE_SEQUENCE,
      tenantPrefix: `example-compare-record-${runId}`,
      memoryStore: handle.memoryStore,
    });
    // 記録しながら実測もできてしまうので、その場で出す——**この表が
    // 「本物の provider で走らせた compare」そのものである。**
    console.log(`\n${formatComparisonTable(rows)}`);
    console.log(`\n${formatRecallQualityTable(rows)}`);
    if (handle.usageMeter) {
      console.log(`\n${handle.usageMeter.formatReport()}`);
    }
  } finally {
    await handle.close();
  }
}

/**
 * 実 API の応答を記録してカセットに書き出す（ADR 0051 / 0052）。
 *
 * **再生する当のものをそのまま走らせて録る。**probe set や会話生成を読んで
 * 「必要そうな入力」を列挙する形は採らない——列挙が漏れると再生時に落ちる。
 * 実行経路そのものが唯一の正しい入力一覧である。
 */
async function runRecord(target: CassetteTarget): Promise<void> {
  const databaseUrl = requireDatabaseUrl();
  if (!process.env.OPENAI_API_KEY) {
    throw new Error(
      "record は本物の OpenAI を叩いて記録する。OPENAI_API_KEY を設定してから実行すること。",
    );
  }

  const recorder = new CassetteRecorder();

  // ⚠ **記録は必ず新しいテナントで走らせる。**`observe()` は `externalId` で
  // 重複排除するため、既に取り込み済みのテナントで走らせると抽出も埋め込みも呼ばれず、
  // 「1件も記録されていない」カセットができる（実際にこれで一度落ちた）。
  // 記録に必要なのはプロンプトと入力テキストの対応だけであり、それは probe set /
  // 会話生成関数から決まってテナントに依らない。
  const runId = Date.now();

  if (target === "retrieval") {
    await recordRetrieval(databaseUrl, recorder, runId);
  } else {
    await recordCompare(databaseUrl, recorder, runId);
  }

  const cassette = recorder.toCassette();
  const path = cassettePathFor(target);
  saveCassette(cassette, path);
  console.log(`\n書き出した: ${path}`);
  console.log(`  ${describeCassette(cassette)}`);
  console.log(
    "  ⚠ これはこの時点の API の姿の記録である。モデルが更新されても記録は変わらない——" +
      "乖離は `verify` で確かめること（ADR 0051 の「引き受ける負債」）。",
  );
}

/** コサイン類似度。`verify` が記録と実 API のベクトルを比べるためだけに使う。 */
function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * 記録が実 API から乖離していないかを測る（ADR 0051 の「覆る条件」を、測れる形にしたもの）。
 *
 * **埋め込みだけを照合する。**`gpt-4o-mini` の応答は同じ入力でも揺れるため、差が出ても
 * 「モデルが変わった」とは言えない——**照合できないものを照合したふりをしない**ので、
 * LLM 側は件数の確認だけに留める。
 *
 * ⚠ **埋め込みも、ビット単位では再現しない（本 PR の実測）。**同じ日・同じモデル
 * （`text-embedding-3-small` / 256次元）に同じ152件を投げ直したところ、
 * **20件が記録と完全一致しなかった**。最小コサイン類似度は **0.998647**。
 * 当初「埋め込みは決定的だから差が出たらモデルが変わった証拠」として `1e-6` を
 * 閾値に置いていたが、それは**この実測で否定された**——実 API 側に揺らぎがある。
 *
 * そこで閾値は `DRIFT_COSINE_THRESHOLD` に置き、**「完全一致したか」と「乖離したか」を
 * 別々に数える。**前者はほぼ常に一部が外れる（それが普通）。後者だけが記録し直す理由になる。
 */
/**
 * これを下回ったら「記録し直すべき乖離」とみなす境。
 *
 * **根拠**: 上記の実測で、同一モデルの揺らぎは最小 0.998647 に収まった（152件、1日、1回）。
 * モデルそのものが替われば、同じ文のベクトルはこれよりはるかに大きく動くと考えられる。
 * **ただし「モデルが替わったときにどこまで下がるか」は測っていない**——この 0.99 は
 * 揺らぎの実測の下に置いた線であって、モデル交代を実際に検出できると確かめた値ではない。
 */
const DRIFT_COSINE_THRESHOLD = 0.99;
async function runVerify(target: CassetteTarget): Promise<void> {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("verify は実 API と記録を突き合わせる。OPENAI_API_KEY を設定すること。");
  }
  const cassette = loadCassette(cassettePathFor(target));
  console.log(`照合するカセット（${target}）: ${describeCassette(cassette)}`);

  const { createProviders } = await import("./providers.js");
  const { embeddingProvider, usageMeter } = createProviders({
    ...process.env,
    MNEMORA_LLM: "deterministic",
    MNEMORA_EMBEDDING: "openai",
  });

  const entries = Object.values(cassette.embedding.entries);
  const texts = entries.map((e) => e.text);
  const fresh = await embeddingProvider.embed({ tenantId: "cassette-verify" }, texts);

  let worst = { similarity: 1, text: "" };
  let exact = 0;
  let drifted = 0;
  entries.forEach((entry, i) => {
    const similarity = cosine(entry.vector, fresh[i] ?? []);
    // 「完全一致したか」と「乖離したか」は別の問い。前者が欠けるのは普通のこと
    // （実 API 側の揺らぎ）であり、後者だけが記録し直す理由になる。
    if (similarity >= 1 - Number.EPSILON) {
      exact += 1;
    }
    if (similarity < DRIFT_COSINE_THRESHOLD) {
      drifted += 1;
    }
    if (similarity < worst.similarity) {
      worst = { similarity, text: entry.text };
    }
  });

  console.log(`\n埋め込み ${entries.length} 件を実 API と照合した。`);
  console.log(`  完全一致: ${exact} 件（一致しない分は実 API 側の揺らぎ。異常ではない）`);
  console.log(`  最小コサイン類似度: ${worst.similarity.toFixed(9)}`);
  console.log(`  最も離れた入力: ${JSON.stringify(worst.text)}`);
  console.log(`  閾値 ${DRIFT_COSINE_THRESHOLD} を割った件数: ${drifted}`);
  if (drifted > 0) {
    console.log("  🔴 記録が実 API から乖離している。記録し直すこと（ADR 0051）。");
    process.exitCode = 1;
  } else {
    console.log("  ✅ 揺らぎの範囲内。記録は実 API と整合している。");
  }
  console.log(
    `\nLLM（${cassette.llm.model}）の記録 ${Object.keys(cassette.llm.entries).length} 件は照合していない` +
      "——同じ入力でも応答が揺れるため、差が出ても「モデルが変わった」とは言えない。",
  );
  if (usageMeter) {
    console.log(usageMeter.formatReport());
  }
}

/**
 * `freshness`/`decay` を意味的類似度から分離して測る arm(PR 本文)。
 *
 * **provider は既定で `deterministic` に倒す。**理由: ペアの2件は本文が厳密に同一なので、
 * `DeterministicEmbeddingProvider` を使う限り `similarity` は構成上定数になる
 * (`time-term-probe-set.ts` の docstring 参照)。この測定は provider 層(擬似か本物か)に
 * 依らない——⟹ カセットの再録も `OPENAI_API_KEY` も要らない。
 * `MNEMORA_LLM`/`MNEMORA_EMBEDDING` が明示されていればそれを尊重する(既存の
 * `retrieval`/`compare` と同じ、上書き優先の規約)。
 *
 * ⚠ **ただし「想起の質」は主張しない**(AGENTS.md「`deterministic` で測った想起の質は、
 * 性能について何も言っていない」)。ここで測るのは「時間項が順位を決めているか」だけであり、
 * 「正しい記憶を引けているか」ではない。
 *
 * **`MutableClock` を注入する。**`decay-*` probe が `recordedAt` を過去へ振るには、
 * `createExampleRuntime` に渡した `Clock` と `runTimeTermArm` に渡す `clock` が
 * **同じインスタンス**でなければならない(`time-term-arm.ts` の
 * `RunTimeTermArmOptions.clock` の docstring 参照)。
 */
async function runTimeTerm(): Promise<void> {
  const databaseUrl = requireDatabaseUrl();
  const clock = createMutableClock();
  const handle = await createExampleRuntime(
    databaseUrl,
    {
      ...process.env,
      MNEMORA_LLM: process.env.MNEMORA_LLM ?? "deterministic",
      MNEMORA_EMBEDDING: process.env.MNEMORA_EMBEDDING ?? "deterministic",
    },
    {},
    clock,
  );
  printProviderMode(handle.llmMode, handle.embeddingMode);
  try {
    console.log(
      "\n「内容は同一・occurredAt/recordedAt だけ違う」ペアで、" +
        "freshness/decay が順位をどう動かすかを測る。\n",
    );
    const report = await runTimeTermArm({
      armLabel: "time-term",
      tenantIdPrefix: "time-term",
      runtime: handle.runtime,
      memoryStore: handle.memoryStore,
      llmMode: handle.llmMode,
      embeddingMode: handle.embeddingMode,
      clock,
    });
    console.log(formatTimeTermReport(report));
  } finally {
    await handle.close();
  }
}

function printHelp(): void {
  console.log(
    [
      "使い方:",
      "  DATABASE_URL=... pnpm --filter @mnemora/example-chat run chat       # observe/recall の往復・omitted/usage/budget を実演",
      "  DATABASE_URL=... pnpm --filter @mnemora/example-chat run compare    # 会話の長さを変えて経路A/経路Bの量を実測",
      "                                                                      #   OPENAI_API_KEY があれば実 API、無ければ記録の再生(ADR 0052)",
      "  DATABASE_URL=... pnpm --filter @mnemora/example-chat run scope      # tenantId/subjectId のスコープを実演",
      "  DATABASE_URL=... pnpm --filter @mnemora/example-chat run backfill   # observe() の occurredAt が period の絞りに効くことを実演",
      "  DATABASE_URL=... pnpm --filter @mnemora/example-chat run retrieval # 意味的関連性の probe set を3 arm(擬似/埋め込みのみ本物/フル本物)で比較",
      "                                                                      #   OPENAI_API_KEY があれば実 API、無ければ記録の再生(ADR 0051)",
      "  DATABASE_URL=... pnpm --filter @mnemora/example-chat run time-term # 時間項(freshness/decay)を意味的類似度から分離して測る",
      "                                                                      #   既定は擬似 provider(similarity が構成上定数になるため provider に依らない)",
      "  DATABASE_URL=... OPENAI_API_KEY=... pnpm --filter @mnemora/example-chat run record",
      "                                                                      # retrieval の応答を記録する(ADR 0051)",
      "  DATABASE_URL=... OPENAI_API_KEY=... pnpm --filter @mnemora/example-chat run record:compare",
      "                                                                      # compare の応答を記録する(ADR 0052。657回・8〜15分・約$0.023)",
      "  OPENAI_API_KEY=... pnpm --filter @mnemora/example-chat run verify   # retrieval の記録と実 API の乖離を測る",
      "  OPENAI_API_KEY=... pnpm --filter @mnemora/example-chat run verify:compare",
      "                                                                      # compare の記録と実 API の乖離を測る",
    ].join("\n"),
  );
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command === "chat") {
    await runChat();
  } else if (command === "compare") {
    await runCompare();
  } else if (command === "scope") {
    await runScope();
  } else if (command === "backfill") {
    await runBackfill();
  } else if (command === "retrieval") {
    await runRetrieval();
  } else if (command === "time-term") {
    await runTimeTerm();
  } else if (command === "record") {
    await runRecord(parseCassetteTarget(process.argv[3]));
  } else if (command === "verify") {
    await runVerify(parseCassetteTarget(process.argv[3]));
  } else {
    printHelp();
    if (command !== undefined) {
      process.exitCode = 1;
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
