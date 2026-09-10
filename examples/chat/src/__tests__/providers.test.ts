import { describe, expect, it } from "vitest";
import { LocalEmbeddingProvider } from "@mnemora/local-embedding";
import { OpenAIEmbeddingProvider, OpenAILLMProvider } from "@mnemora/openai";
import type { Cassette } from "@mnemora/testkit";
import {
  CASSETTE_FORMAT_VERSION,
  CassetteRecorder,
  DeterministicEmbeddingProvider,
  DeterministicLLMProvider,
  RecordedEmbeddingProvider,
  RecordedLLMProvider,
  RecordingEmbeddingProvider,
  RecordingLLMProvider,
} from "@mnemora/testkit";
import {
  createProviders,
  decideProviderSource,
  describeProviderSourceReason,
  selectEmbeddingMode,
  selectLLMMode,
  selectProviderMode,
} from "../providers.js";
import { formatNoApiCallsNotice } from "../usage-meter.js";

/**
 * `selectProviderMode`/`createProviders` の唯一の分岐（`OPENAI_API_KEY` の有無）に、
 * 両方向から歯を通す。実際の OpenAI へのネットワーク呼び出しは行わない
 * （provider の構築だけを検査する。`packages/openai/src/__tests__/live.openai.test.ts` と
 * 同じ区別——構築のロジックと、本物の API 呼び出しは別に検査する）。
 */
describe("selectProviderMode", () => {
  it("OPENAI_API_KEY が無い場合は 'deterministic'", () => {
    expect(selectProviderMode({})).toBe("deterministic");
  });

  it("OPENAI_API_KEY が空文字の場合も 'deterministic'（falsy 扱い）", () => {
    expect(selectProviderMode({ OPENAI_API_KEY: "" })).toBe("deterministic");
  });

  it("OPENAI_API_KEY がある場合は 'openai'", () => {
    expect(selectProviderMode({ OPENAI_API_KEY: "sk-fake-for-test" })).toBe("openai");
  });
});

describe("createProviders", () => {
  it("鍵が無ければ deterministic な擬似 provider を返す", () => {
    const providers = createProviders({});
    expect(providers.mode).toBe("deterministic");
    expect(providers.llmProvider).toBeInstanceOf(DeterministicLLMProvider);
    expect(providers.embeddingProvider).toBeInstanceOf(DeterministicEmbeddingProvider);
  });

  it("鍵があれば OpenAI の provider を返す（構築のみ。ネットワーク呼び出しはしない）", () => {
    const providers = createProviders({ OPENAI_API_KEY: "sk-fake-for-test" });
    expect(providers.mode).toBe("openai");
    expect(providers.llmProvider).toBeInstanceOf(OpenAILLMProvider);
    expect(providers.embeddingProvider).toBeInstanceOf(OpenAIEmbeddingProvider);
  });
});

/**
 * `MNEMORA_LLM`/`MNEMORA_EMBEDDING` による個別上書き（本 PR (B)）。
 * **未指定なら `selectProviderMode` と一致する**——上の `describe("selectProviderMode")`
 * のテストが変わらず通ることが、この契約が壊れていないことの一次的な証拠でもある。
 */
describe("selectLLMMode / selectEmbeddingMode", () => {
  it("未指定なら selectProviderMode と同じ結果になる（鍵無し）", () => {
    expect(selectLLMMode({})).toBe("deterministic");
    expect(selectEmbeddingMode({})).toBe("deterministic");
  });

  it("未指定なら selectProviderMode と同じ結果になる（鍵あり）", () => {
    const env = { OPENAI_API_KEY: "sk-fake-for-test" };
    expect(selectLLMMode(env)).toBe("openai");
    expect(selectEmbeddingMode(env)).toBe("openai");
  });

  it("MNEMORA_LLM/MNEMORA_EMBEDDING を個別に上書きできる", () => {
    const env = {
      OPENAI_API_KEY: "sk-fake-for-test",
      MNEMORA_LLM: "deterministic",
      MNEMORA_EMBEDDING: "openai",
    };
    expect(selectLLMMode(env)).toBe("deterministic");
    expect(selectEmbeddingMode(env)).toBe("openai");
  });

  it("不明な値を渡すと例外を投げる（黙って無視しない）", () => {
    expect(() => selectLLMMode({ MNEMORA_LLM: "not-a-mode" })).toThrow(/MNEMORA_LLM/);
    expect(() => selectEmbeddingMode({ MNEMORA_EMBEDDING: "not-a-mode" })).toThrow(
      /MNEMORA_EMBEDDING/,
    );
  });
});

describe("createProviders: LLM/Embedding の個別上書き", () => {
  it("MNEMORA_LLM=deterministic + MNEMORA_EMBEDDING=openai で LLM だけ擬似物のままにできる", () => {
    const providers = createProviders({
      OPENAI_API_KEY: "sk-fake-for-test",
      MNEMORA_LLM: "deterministic",
      MNEMORA_EMBEDDING: "openai",
    });
    expect(providers.llmMode).toBe("deterministic");
    expect(providers.embeddingMode).toBe("openai");
    expect(providers.llmProvider).toBeInstanceOf(DeterministicLLMProvider);
    expect(providers.embeddingProvider).toBeInstanceOf(OpenAIEmbeddingProvider);
    // どちらか一方でも本物を使うので usage-meter が存在する。
    expect(providers.usageMeter).toBeDefined();
  });

  it("両方擬似物のときは usageMeter を持たない（API を叩く経路が無いため）", () => {
    const providers = createProviders({});
    expect(providers.usageMeter).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// ADR 0051: 第3のモード `"recorded"` の配線
//
// ⚠ **この節が無かったために、表示層の不具合が「691テスト緑」のまま出荷されかけた。**
// `ProviderMode` に `"recorded"` を足したとき、`createProviders` は直したが
// `describeMode`/`formatNoApiCallsNotice` は直しておらず、記録を再生している run が
// 画面には「決定的な擬似 provider」と出ていた。**モードを増やす変更は、provider の
// 構築だけでなく、それを人に見せる経路まで含めて検査する。**
// ---------------------------------------------------------------------------

/** 最小のカセット。中身の正しさは packages/testkit の歯が見るので、ここでは形だけ。 */
function minimalCassette(): Cassette {
  return {
    version: CASSETTE_FORMAT_VERSION,
    recordedAt: "2026-09-07T00:00:00.000Z",
    embedding: {
      space: { provider: "openai", model: "text-embedding-3-small", dimensions: 256 },
      entries: {},
    },
    llm: { model: "gpt-4o-mini", entries: {} },
  };
}

describe("createProviders — recorded モード（ADR 0051）", () => {
  it('MNEMORA_EMBEDDING="recorded" でカセットが無ければ落ちる（擬似物へ倒れない）', () => {
    expect(() => createProviders({ MNEMORA_EMBEDDING: "recorded" })).toThrow(
      /カセットが渡されていない/,
    );
  });

  it('MNEMORA_LLM="recorded" でカセットが無ければ落ちる（擬似物へ倒れない）', () => {
    expect(() => createProviders({ MNEMORA_LLM: "recorded" })).toThrow(/カセットが渡されていない/);
  });

  it("カセットがあれば Recorded* を返し、擬似物でも本物でもない", () => {
    const providers = createProviders(
      { MNEMORA_LLM: "recorded", MNEMORA_EMBEDDING: "recorded" },
      { cassette: minimalCassette() },
    );
    expect(providers.llmMode).toBe("recorded");
    expect(providers.embeddingMode).toBe("recorded");
    expect(providers.llmProvider).toBeInstanceOf(RecordedLLMProvider);
    expect(providers.embeddingProvider).toBeInstanceOf(RecordedEmbeddingProvider);
    expect(providers.llmProvider).not.toBeInstanceOf(DeterministicLLMProvider);
    expect(providers.embeddingProvider).not.toBeInstanceOf(DeterministicEmbeddingProvider);
  });

  it("recorded は API を叩かないので usageMeter を作らない", () => {
    const providers = createProviders(
      { MNEMORA_LLM: "recorded", MNEMORA_EMBEDDING: "recorded" },
      { cassette: minimalCassette() },
    );
    expect(providers.usageMeter).toBeUndefined();
  });

  it("recorded の埋め込み空間は、実 OpenAI と同じ空間である（別テーブルに分かれない）", () => {
    const providers = createProviders(
      { MNEMORA_EMBEDDING: "recorded" },
      { cassette: minimalCassette() },
    );
    expect(providers.embeddingProvider.space).toEqual({
      provider: "openai",
      model: "text-embedding-3-small",
      dimensions: 256,
    });
  });

  it("recorder を渡すと、本物の provider が記録用に包まれる", () => {
    const providers = createProviders(
      { OPENAI_API_KEY: "sk-fake-for-test" },
      { recorder: new CassetteRecorder() },
    );
    expect(providers.llmProvider).toBeInstanceOf(RecordingLLMProvider);
    expect(providers.embeddingProvider).toBeInstanceOf(RecordingEmbeddingProvider);
  });

  it("recorder を渡さなければ、本物の provider は包まれない", () => {
    const providers = createProviders({ OPENAI_API_KEY: "sk-fake-for-test" });
    expect(providers.llmProvider).not.toBeInstanceOf(RecordingLLMProvider);
    expect(providers.embeddingProvider).not.toBeInstanceOf(RecordingEmbeddingProvider);
  });

  it('MNEMORA_LLM に未知の値を与えたら、"recorded" を含む一覧を示して落ちる', () => {
    expect(() => createProviders({ MNEMORA_LLM: "cassette" })).toThrow(/"recorded"/);
  });
});

describe("formatNoApiCallsNotice — モードを取り違えない（ADR 0051）", () => {
  it("擬似 stub の run を「記録の再生」と言わない", () => {
    const notice = formatNoApiCallsNotice({
      llmMode: "deterministic",
      embeddingMode: "deterministic",
    });
    expect(notice).toContain("擬似 stub");
    expect(notice).not.toContain("記録の再生");
  });

  it("🔴 記録を再生した run を「擬似」と言わない（この取り違えが実際に起きた）", () => {
    const notice = formatNoApiCallsNotice({ llmMode: "recorded", embeddingMode: "recorded" });
    expect(notice).toContain("記録の再生");
    expect(notice).not.toContain("擬似 stub");
  });

  it("片側だけ recorded の run は、両側を別々に名指しする", () => {
    const notice = formatNoApiCallsNotice({
      llmMode: "deterministic",
      embeddingMode: "recorded",
    });
    expect(notice).toContain("LLM=擬似 stub");
    expect(notice).toContain("埋め込み=記録の再生");
  });

  it("記録の再生では「値の出所」と「費用」を別の話として明示する", () => {
    const notice = formatNoApiCallsNotice({ llmMode: "recorded", embeddingMode: "recorded" });
    expect(notice).toContain("この run 自体は API を叩いていない");
  });
});

// ---------------------------------------------------------------------------
// ADR 0068 ③: 「キーが在るだけで、カセット再生のつもりが実 API に倒れる」を塞ぐ
//
// **現物の欠陥**: 直していない旧 `resolveCassetteForRun`(`cli.ts`)は
// `process.env.OPENAI_API_KEY` の有無だけを見ており、`MNEMORA_LLM=recorded` を
// 渡しても救えなかった(`runRetrieval`/`runCompare` はどちらも `MNEMORA_LLM`/
// `MNEMORA_EMBEDDING` を自分で明示的に上書きするため)。「キーが在るときにカセットを
// 使う口」がどこにも無かった——`decideProviderSource` がその口を足す。
//
// **歯はキーが在る状態で測る**——キーが無い状態で緑にしても、この欠陥(キーが在ると
// 強制指定が効かなくなる)は一生捕まらない。
// ---------------------------------------------------------------------------

describe("decideProviderSource — カセット再生か実 API かの判定（ADR 0068 ③）", () => {
  const fakeKeyEnv = { OPENAI_API_KEY: "sk-test-dummy-not-real" };

  it('③-1: キーが在っても MNEMORA_PROVIDER_SOURCE="recorded" を明示すれば recorded を強制する', () => {
    expect(decideProviderSource({ ...fakeKeyEnv, MNEMORA_PROVIDER_SOURCE: "recorded" })).toEqual({
      source: "recorded",
      reason: "forced",
    });
  });

  it('MNEMORA_PROVIDER_SOURCE="openai" は、キーが在れば openai を強制する', () => {
    expect(decideProviderSource({ ...fakeKeyEnv, MNEMORA_PROVIDER_SOURCE: "openai" })).toEqual({
      source: "openai",
      reason: "forced",
    });
  });

  // -------------------------------------------------------------------------
  // ⚠ この歯は、本 PR の実装の途中で実際に踏んだ穴を殺すために足した。
  //
  // `MNEMORA_PROVIDER_SOURCE="openai"` をキー無しで指定できてしまうと、`cli.ts` の
  // `runCompare` はカセットを読まずに `process.env` をそのまま `createProviders` へ
  // 渡す——`selectProviderMode` が「キーが無い ⟹ deterministic」と判定するので、
  // **画面には「実 API を叩く」と出しながら擬似 provider で走り、数字の表を出して
  // EXIT=0 で終わる**。走らせて実際にこの出力を確認した。
  //
  // **⟹ ADR 0068 が塞ごうとしている「正直な顔をして違うことをする」形そのものを、
  // ③ の実装が新しく作っていた。**「明示した source と、実際に使われる provider が
  // 食い違う」経路は作らない。
  // -------------------------------------------------------------------------
  it('MNEMORA_PROVIDER_SOURCE="openai" をキー無しで指定したら例外（擬似 provider へ黙って倒れない）', () => {
    expect(() => decideProviderSource({ MNEMORA_PROVIDER_SOURCE: "openai" })).toThrow(
      /OPENAI_API_KEY/,
    );
    // 空文字のキーも「無い」側（`selectProviderMode` の falsy 判定と揃える）。
    expect(() =>
      decideProviderSource({ OPENAI_API_KEY: "", MNEMORA_PROVIDER_SOURCE: "openai" }),
    ).toThrow(/OPENAI_API_KEY/);
  });

  it("③-2: 未指定なら、いままで通りキーの有無だけで決まる（既定の振る舞いは変えていない）", () => {
    expect(decideProviderSource(fakeKeyEnv)).toEqual({ source: "openai", reason: "key-present" });
    expect(decideProviderSource({})).toEqual({ source: "recorded", reason: "no-key" });
    // 空文字は「未指定」として扱う（`parseModeOverride` と同じ作法）。
    expect(decideProviderSource({ MNEMORA_PROVIDER_SOURCE: "" })).toEqual({
      source: "recorded",
      reason: "no-key",
    });
  });

  it("③-3: 未知の値を渡すと例外を投げる（黙って既定へ倒れない）", () => {
    expect(() => decideProviderSource({ MNEMORA_PROVIDER_SOURCE: "cassette" })).toThrow(
      /MNEMORA_PROVIDER_SOURCE/,
    );
    expect(() =>
      decideProviderSource({ ...fakeKeyEnv, MNEMORA_PROVIDER_SOURCE: "cassette" }),
    ).toThrow(/MNEMORA_PROVIDER_SOURCE/);
  });

  it("describeProviderSourceReason は forced と自然に決まった場合を書き分ける", () => {
    expect(describeProviderSourceReason({ source: "recorded", reason: "forced" })).toContain(
      "明示指定",
    );
    expect(describeProviderSourceReason({ source: "recorded", reason: "no-key" })).not.toContain(
      "明示指定",
    );
  });
});

// ---------------------------------------------------------------------------
// Issue #109: 第4のモード `"local"`(`@mnemora/local-embedding`、ADR 0085)
//
// **embedding 専用である。** `selectProviderMode` の契約(既存テスト、本ファイル冒頭)は
// 変えていない——`MNEMORA_LLM`/`MNEMORA_EMBEDDING` を設定しない呼び出しは、この節を
// 足す前とまったく同じ結果になる(上の `describe("selectProviderMode", ...)` が
// そのまま緑であることが、その一次的な証拠でもある)。
// ---------------------------------------------------------------------------

describe("selectEmbeddingMode / selectLLMMode — 第4のモード local（Issue #109）", () => {
  it('MNEMORA_EMBEDDING="local" を受け付ける', () => {
    expect(selectEmbeddingMode({ MNEMORA_EMBEDDING: "local" })).toBe("local");
  });

  it('MNEMORA_LLM="local" は例外になる（LLM 側に local 実装は無い）', () => {
    expect(() => selectLLMMode({ MNEMORA_LLM: "local" })).toThrow(/MNEMORA_LLM/);
  });

  it("鍵の有無に関わらず MNEMORA_EMBEDDING=local を上書きできる", () => {
    expect(selectEmbeddingMode({ MNEMORA_EMBEDDING: "local" })).toBe("local");
    expect(
      selectEmbeddingMode({ OPENAI_API_KEY: "sk-fake-for-test", MNEMORA_EMBEDDING: "local" }),
    ).toBe("local");
  });
});

describe("createProviders — local モード（Issue #109、@mnemora/local-embedding）", () => {
  it("MNEMORA_EMBEDDING=local で LocalEmbeddingProvider を返す（カセット・鍵は不要）", () => {
    const providers = createProviders({ MNEMORA_EMBEDDING: "local" });
    expect(providers.embeddingMode).toBe("local");
    expect(providers.embeddingProvider).toBeInstanceOf(LocalEmbeddingProvider);
  });

  it("space は (provider, model, dimensions) が仕様通りである", () => {
    const providers = createProviders({ MNEMORA_EMBEDDING: "local" });
    expect(providers.embeddingProvider.space).toEqual({
      provider: "local",
      model: "ruri-v3-30m/sym",
      dimensions: 256,
    });
  });

  it("local は API を叩かないので usageMeter を作らない", () => {
    const providers = createProviders({ MNEMORA_EMBEDDING: "local" });
    expect(providers.usageMeter).toBeUndefined();
  });

  it("LLM は deterministic のまま個別に上書きできる（local は embedding だけを差し替える）", () => {
    const providers = createProviders({
      MNEMORA_LLM: "deterministic",
      MNEMORA_EMBEDDING: "local",
    });
    expect(providers.llmMode).toBe("deterministic");
    expect(providers.llmProvider).toBeInstanceOf(DeterministicLLMProvider);
    expect(providers.embeddingProvider).toBeInstanceOf(LocalEmbeddingProvider);
  });

  it('MNEMORA_LLM="local" は createProviders でも例外になる', () => {
    expect(() => createProviders({ MNEMORA_LLM: "local" })).toThrow(/MNEMORA_LLM/);
  });
});

describe("formatNoApiCallsNotice — local モードを「本物の OpenAI」と言わない（Issue #109）", () => {
  // 🔴 この歯が無かったら、Issue #109 の実装は
  // `formatNoApiCallsNotice` の `label` の非網羅な ternary(recorded/deterministic 以外は
  // 一律「本物の OpenAI」)にそのまま引っかかっていた——ローカル推論で課金も外部通信も
  // 無いのに「本物の OpenAI」と表示される、まさにこの repo が繰り返し警告している
  // 「条件を落とした数字」を新しく作るところだった(usage-meter.ts の docstring 参照)。
  it("擬似LLM + ローカル埋め込みの run を「本物の OpenAI」と言わない", () => {
    const notice = formatNoApiCallsNotice({ llmMode: "deterministic", embeddingMode: "local" });
    expect(notice).toContain("ローカル推論");
    expect(notice).not.toContain("本物の OpenAI");
  });
});
