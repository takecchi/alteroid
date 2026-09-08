import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { LLMProvider, StructuredRequest } from "../interfaces/llm-provider.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * `observe()` に渡した `occurredAt` が、`Memory.occurredAt` を経て
 * `recall()` の period フィルタに効くところまでを、一本の経路として検査する
 * （ADR 0037）。
 *
 * **なぜこの歯が要るか**: `ObserveInput.occurredAt` は3つの入力すべてに最初から在り、
 * `runtime.observe` は素通しし、`buildNewMemoryFromCandidate` が `Memory.occurredAt` へ
 * 写す。**しかしリポジトリ内でこの口に値を渡している箇所は0件だった**
 * （`packages` と `examples` 配下の `src` を検索。テストを含む）。
 * **⟹ 入口から出口まで、一度も通っていない経路だった。**
 *
 * `recall-runtime.ts` は `effectiveTime = memory.occurredAt ?? memory.recordedAt` で
 * `occurredAfter` / `occurredBefore` を当てる。**`occurredAt` が常に null だと、
 * 「いつの出来事か」を絞ると読める欄が、実際には「いつ言われたか」を絞る。**
 * 生の会話ログを後から取り込む（backfill）と `recordedAt` は今日になるので、
 * **この取り違えは静かに間違う。**
 */

const ctx: Ctx = { tenantId: "tenant-occurred-at" };
const DAY = 24 * 60 * 60 * 1000;
/** ADR 0032 のリース。この歯はリースの境界そのものを見ないので、十分長い固定値を使う。 */
const TEST_LEASE_MS = 60_000;

/**
 * ⚠ 「古い」側の日数を、既定の半減期（720時間 = 30日）に対して**わざと小さく**取る。
 * 例えば365日前にすると `freshness` が 0.000217 まで落ち、既定の `scoreThreshold`（0.1）で
 * 落ちてしまう——**period フィルタで落ちたのか閾値で落ちたのか、区別が付かなくなる。**
 * 20日前なら `freshness` は約 0.63 で閾値を超えるので、**落ちた理由は period しかありえない。**
 */
const OLD_DAYS = 20;
const RECENT_DAYS = 2;
const CUTOFF_DAYS = 10;

/** 観測された発話をそのまま1件の記憶にする LLM（`@mnemora/testkit` には依存しない）。 */
function echoingLlm(): LLMProvider {
  return {
    complete: async () => {
      throw new Error("not used");
    },
    completeStructured: async <T>(_c: Ctx, req: StructuredRequest<T>): Promise<T> => {
      const text = req.prompt.messages[req.prompt.messages.length - 1]?.content ?? "";
      return req.schema.parse({
        memories: [{ content: text, digest: text, provenanceKind: "stated" }],
      }) as T;
    },
  };
}

function buildRuntime() {
  const stores = createFakeRuntimeStores();
  const runtime = createRuntime({
    memoryStore: stores.memoryStore,
    outboxStore: stores.outboxStore,
    vectorStore: stores.vectorStore,
    eventStore: stores.eventStore,
    tenantSettingsStore: stores.tenantSettingsStore,
    llmProvider: echoingLlm(),
    embeddingProvider: stores.embeddingProvider,
    hashContent: (content: string) => `sha256(${content})`,
  });
  return { runtime, stores };
}

/**
 * 2件を取り込む。**content の長さを揃えてある**——`FakeEmbeddingProvider` は
 * `[text.length, 'a' の個数]` を返すので、長さが同じならベクトルが同一になり、
 * 類似度で差が付かない。**⟹ 返るか落ちるかの差は period フィルタだけに由来する。**
 */
const OLD_TEXT = "むかしの話です";
const RECENT_TEXT = "さいきんの話で";

async function ingest(
  runtime: ReturnType<typeof buildRuntime>["runtime"],
  now: Date,
  opts: { withOccurredAt: boolean },
): Promise<void> {
  await runtime.observe(ctx, {
    kind: "utterance",
    text: OLD_TEXT,
    externalId: "old",
    ...(opts.withOccurredAt ? { occurredAt: new Date(now.getTime() - OLD_DAYS * DAY) } : {}),
  });
  await runtime.observe(ctx, {
    kind: "utterance",
    text: RECENT_TEXT,
    externalId: "recent",
    ...(opts.withOccurredAt ? { occurredAt: new Date(now.getTime() - RECENT_DAYS * DAY) } : {}),
  });
  await runtime.tick(ctx, { kinds: ["embed"], leaseMs: TEST_LEASE_MS });
}

describe("observe() の occurredAt が Memory まで届く", () => {
  it("渡した occurredAt がそのまま Memory.occurredAt になる（recordedAt とは別物）", async () => {
    const { runtime, stores } = buildRuntime();
    const startedAt = Date.now();
    const occurredAt = new Date(startedAt - OLD_DAYS * DAY);
    const result = await runtime.observe(ctx, {
      kind: "utterance",
      text: OLD_TEXT,
      externalId: "old",
      occurredAt,
    });
    const memory = await stores.memoryStore.get(ctx, result.memoryIds[0]!);
    expect(memory?.occurredAt).toEqual(occurredAt);
    // recordedAt は「mnemora がいつ知ったか」なので、取り込んだ今日のまま——
    // occurredAt（20日前）とは別物である。
    expect(memory!.recordedAt.getTime()).toBeGreaterThanOrEqual(startedAt);
    expect(memory!.recordedAt.getTime() - occurredAt.getTime()).toBeGreaterThan(
      (OLD_DAYS - 1) * DAY,
    );
  });

  it("渡さなければ Memory.occurredAt は null のまま（既定は変えていない）", async () => {
    const { runtime, stores } = buildRuntime();
    const result = await runtime.observe(ctx, {
      kind: "utterance",
      text: OLD_TEXT,
      externalId: "old",
    });
    const memory = await stores.memoryStore.get(ctx, result.memoryIds[0]!);
    expect(memory?.occurredAt).toBeNull();
  });
});

describe("recall() の occurredAfter は、occurredAt を渡したときだけ「いつの出来事か」を絞る", () => {
  it("occurredAt を渡すと、cutoff より古い出来事が落ちて omitted に period として出る", async () => {
    const { runtime } = buildRuntime();
    const now = new Date();
    await ingest(runtime, now, { withOccurredAt: true });

    const result = await runtime.recall(ctx, {
      vector: [1, 0],
      occurredAfter: new Date(now.getTime() - CUTOFF_DAYS * DAY),
    });
    const digests = result.memories.map((m) => m.digest);
    expect(digests).toContain(RECENT_TEXT);
    expect(digests).not.toContain(OLD_TEXT);
    expect(result.omitted).toContainEqual({
      kind: "filtered",
      condition: "period",
      count: 1,
      countKind: "exact",
    });
    // ⚠ 閾値で落ちたのではないことを名指しで確かめる（落ちた理由を取り違えない）。
    expect(result.omitted.some((o) => o.kind === "below_threshold")).toBe(false);
  });

  it("⚠ 対照: occurredAt を渡さないと、同じ問い合わせで両方とも残る（絞りが効いていない）", async () => {
    const { runtime } = buildRuntime();
    const now = new Date();
    await ingest(runtime, now, { withOccurredAt: false });

    const result = await runtime.recall(ctx, {
      vector: [1, 0],
      occurredAfter: new Date(now.getTime() - CUTOFF_DAYS * DAY),
    });
    const digests = result.memories.map((m) => m.digest);
    // 20日前の出来事なのに残る——effectiveTime が recordedAt（＝取り込んだ今日）に落ちるため。
    expect(digests).toContain(OLD_TEXT);
    expect(digests).toContain(RECENT_TEXT);
    expect(result.omitted.some((o) => o.kind === "filtered" && o.condition === "period")).toBe(
      false,
    );
  });
});

/**
 * period の判定規則は、この repo に**4箇所**ある（ADR 0039）——
 * `recall-runtime.ts` の候補フィルタ、`PostgresMemoryStore.aggregateScope`、
 * `InMemoryMemoryStore.aggregateScope`、`packages/core` のテスト用
 * `FakeMemoryStore.aggregateScope`。
 *
 * **候補フィルタは「何が返るか」を決め、`aggregateScope` は「`omitted` が何と言うか」を決める。**
 * ⟹ **この2つが食い違うと、`omitted` が嘘をつく。**
 *
 * `packages/testkit` の適合テストは adapter 2つ（postgres / in-memory）に届くが、
 * `recall-runtime.ts` には届かない（`recall()` を呼ばないため）。
 * **ここで測るのは「候補フィルタと `aggregateScope` が、同じ境界に対して同じ答えを出すこと」である。**
 */
describe("recall() の period は境界を含み、返り値と omitted が食い違わない（ADR 0039）", () => {
  const BOUNDARY_TEXT = "きょうどの話です";
  const JUST_OUTSIDE_TEXT = "そのまえの話で";

  async function ingestBoundaryPair(
    runtime: ReturnType<typeof buildRuntime>["runtime"],
    cutoff: Date,
  ): Promise<void> {
    await runtime.observe(ctx, {
      kind: "utterance",
      text: BOUNDARY_TEXT,
      externalId: "boundary",
      occurredAt: cutoff,
    });
    await runtime.observe(ctx, {
      kind: "utterance",
      text: JUST_OUTSIDE_TEXT,
      externalId: "just-outside",
      // 境界の1ミリ秒だけ外。**1日ではなく1ミリ秒**にしてあるのは、
      // 境界を1つずらす変異（`>=` → `>`）だけを捕まえるためである。
      occurredAt: new Date(cutoff.getTime() - 1),
    });
    await runtime.tick(ctx, { kinds: ["embed"], leaseMs: TEST_LEASE_MS });
  }

  it("occurredAt === occurredAfter ちょうどの記憶は返り、1ミリ秒だけ外のものは落ちる", async () => {
    const { runtime } = buildRuntime();
    const cutoff = new Date(Date.now() - RECENT_DAYS * DAY);
    await ingestBoundaryPair(runtime, cutoff);

    const result = await runtime.recall(ctx, { vector: [1, 0], occurredAfter: cutoff });
    const digests = result.memories.map((m) => m.digest);

    // 候補フィルタ（recall-runtime.ts）の側: 境界は残り、1ミリ秒外は落ちる。
    expect(digests).toContain(BOUNDARY_TEXT);
    expect(digests).not.toContain(JUST_OUTSIDE_TEXT);
    // aggregateScope の側: 落ちたのはちょうど1件だと言っている。
    expect(result.omitted).toContainEqual({
      kind: "filtered",
      condition: "period",
      count: 1,
      countKind: "exact",
    });
    // ⚠ 閾値で落ちたのではないことを名指しで確かめる。
    expect(result.omitted.some((o) => o.kind === "below_threshold")).toBe(false);
    // ⟹ 「返った件数」と「落ちたと言っている件数」の合計が、取り込んだ2件と一致する。
    //    片方だけを直したときに、この等式が破れる。
    expect(digests.length + 1).toBe(2);
  });

  it("⚠ 鳴ってはいけない側: occurredAfter を渡さなければ、両方とも返り period の omission は出ない", async () => {
    const { runtime } = buildRuntime();
    const cutoff = new Date(Date.now() - RECENT_DAYS * DAY);
    await ingestBoundaryPair(runtime, cutoff);

    const result = await runtime.recall(ctx, { vector: [1, 0] });
    const digests = result.memories.map((m) => m.digest);
    expect(digests).toContain(BOUNDARY_TEXT);
    expect(digests).toContain(JUST_OUTSIDE_TEXT);
    expect(result.omitted.some((o) => o.kind === "filtered" && o.condition === "period")).toBe(
      false,
    );
  });

  /**
   * 上限（`occurredBefore`）側。下限側（上の `ingestBoundaryPair`）は「境界ちょうど」と
   * 「境界の1ミリ秒**前**」の対だが、上限側は向きが逆――「境界ちょうど」と「境界の1ミリ秒
   * **後**」の対が要る。既存の `ingestBoundaryPair` はそのまま残し、隣に対になるヘルパを
   * 足す（既存の歯の意味は変えない）。
   */
  async function ingestUpperBoundaryPair(
    runtime: ReturnType<typeof buildRuntime>["runtime"],
    cutoff: Date,
  ): Promise<void> {
    await runtime.observe(ctx, {
      kind: "utterance",
      text: BOUNDARY_TEXT,
      externalId: "boundary",
      occurredAt: cutoff,
    });
    await runtime.observe(ctx, {
      kind: "utterance",
      text: JUST_OUTSIDE_TEXT,
      externalId: "just-outside",
      // 境界の1ミリ秒だけ外。上限側なので「後」（下限側は「前」）。
      occurredAt: new Date(cutoff.getTime() + 1),
    });
    await runtime.tick(ctx, { kinds: ["embed"], leaseMs: TEST_LEASE_MS });
  }

  it("occurredAt === occurredBefore ちょうどの記憶は返り、1ミリ秒だけ後のものは落ちる", async () => {
    const { runtime } = buildRuntime();
    const cutoff = new Date(Date.now() - RECENT_DAYS * DAY);
    await ingestUpperBoundaryPair(runtime, cutoff);

    // 🔑 occurredBefore だけを渡す。occurredAfter は渡さない
    // ——下限側の変異に対してもこの歯が緑のままであるために必須。
    const result = await runtime.recall(ctx, { vector: [1, 0], occurredBefore: cutoff });
    const digests = result.memories.map((m) => m.digest);

    // 候補フィルタ（recall-runtime.ts）の側: 境界は残り、1ミリ秒外（後）は落ちる。
    expect(digests).toContain(BOUNDARY_TEXT);
    expect(digests).not.toContain(JUST_OUTSIDE_TEXT);
    // aggregateScope の側: 落ちたのはちょうど1件だと言っている。
    expect(result.omitted).toContainEqual({
      kind: "filtered",
      condition: "period",
      count: 1,
      countKind: "exact",
    });
    // ⚠ 閾値で落ちたのではないことを名指しで確かめる。
    expect(result.omitted.some((o) => o.kind === "below_threshold")).toBe(false);
    // ⟹ 「返った件数」と「落ちたと言っている件数」の合計が、取り込んだ2件と一致する。
    //    片方だけを直したときに、この等式が破れる。
    expect(digests.length + 1).toBe(2);
  });

  it("⚠ 鳴ってはいけない側: occurredBefore を渡さなければ、両方とも返り period の omission は出ない", async () => {
    const { runtime } = buildRuntime();
    const cutoff = new Date(Date.now() - RECENT_DAYS * DAY);
    await ingestUpperBoundaryPair(runtime, cutoff);

    const result = await runtime.recall(ctx, { vector: [1, 0] });
    const digests = result.memories.map((m) => m.digest);
    expect(digests).toContain(BOUNDARY_TEXT);
    expect(digests).toContain(JUST_OUTSIDE_TEXT);
    expect(result.omitted.some((o) => o.kind === "filtered" && o.condition === "period")).toBe(
      false,
    );
  });
});
