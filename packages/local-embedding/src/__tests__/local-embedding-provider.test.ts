import { describe, expect, it } from "vitest";
import type { Ctx } from "@mnemora/core";
import {
  DEFAULT_LOCAL_EMBEDDING_DIMENSIONS,
  DEFAULT_LOCAL_EMBEDDING_MODEL_ID,
  LOCAL_EMBEDDING_PROVIDER_ID,
  LocalEmbeddingProvider,
} from "../local-embedding-provider.js";
import type {
  CreateLocalEmbeddingPipeline,
  LocalEmbeddingModelSpec,
  LocalEmbeddingPipeline,
} from "../pipeline.js";

/**
 * `LocalEmbeddingProvider` の歯。**本物のモデルは一切落とさない**——
 * `createPipeline` を注入して、このクラスが本当に持っているロジックだけを測る:
 * `space` の確定と凍結 / 遅延ロードを1回に畳むこと / 失敗後に再試行できること /
 * 次元と件数の検査 / prefix の適用 / `warmup()`。
 *
 * **擬似にしているのは「モデルを読み込んで推論する」往復だけである。**
 * 本物のモデルが実際に 256 次元を返すこと・日本語で意味のある近さを出すことは
 * `live.local-embedding.test.ts`（opt-in）が測る。
 */

const ctx: Ctx = { tenantId: "test-tenant" };

/** 呼ばれた回数と、渡された `spec` / テキストを記録する偽 pipeline。 */
function createRecordingPipeline(
  options: {
    dimensions?: number;
    /** 返すベクトルの件数を入力件数からずらす（件数不一致の歯で使う）。 */
    countDelta?: number;
    /** `createPipeline` の解決を止めておくためのゲート。 */
    gate?: Promise<void>;
  } = {},
) {
  const dimensions = options.dimensions ?? DEFAULT_LOCAL_EMBEDDING_DIMENSIONS;
  const state = {
    createCalls: 0,
    specs: [] as LocalEmbeddingModelSpec[],
    embeddedBatches: [] as string[][],
  };

  const pipeline: LocalEmbeddingPipeline = async (texts) => {
    state.embeddedBatches.push([...texts]);
    const count = texts.length + (options.countDelta ?? 0);
    return Array.from({ length: Math.max(count, 0) }, (_, row) =>
      Array.from({ length: dimensions }, (_, column) => (row + column) / 1000),
    );
  };

  const createPipeline: CreateLocalEmbeddingPipeline = async (spec) => {
    state.createCalls += 1;
    state.specs.push(spec);
    if (options.gate) await options.gate;
    return pipeline;
  };

  return {
    createPipeline,
    specs: state.specs,
    embeddedBatches: state.embeddedBatches,
    /** `createPipeline` が呼ばれた回数。**この数がこのファイルで一番大事な数である。** */
    get calls(): number {
      return state.createCalls;
    },
  };
}

describe("space（コンストラクタで同期に確定する）", () => {
  it("new した直後に既定値で確定している（pipeline の読み込みを待たない）", () => {
    const recorder = createRecordingPipeline();
    const provider = new LocalEmbeddingProvider({ createPipeline: recorder.createPipeline });

    expect(provider.space).toEqual({
      provider: LOCAL_EMBEDDING_PROVIDER_ID,
      model: DEFAULT_LOCAL_EMBEDDING_MODEL_ID,
      dimensions: 256,
    });
    // ⭐ 既定値そのものを書き下しておく。定数を参照するだけだと
    // 「既定値が変わった」ことをこの歯が検知できない。
    expect(provider.space.provider).toBe("local");
    expect(provider.space.model).toBe("ruri-v3-30m/sym");
    expect(provider.space.dimensions).toBe(256);
  });

  it("space を読むためにモデルを読み込まない", () => {
    const recorder = createRecordingPipeline();
    const provider = new LocalEmbeddingProvider({ createPipeline: recorder.createPipeline });
    void provider.space.model;
    expect(recorder.calls).toBe(0);
  });

  it("凍結されている（走っている途中で書き換えられない）", () => {
    const recorder = createRecordingPipeline();
    const provider = new LocalEmbeddingProvider({ createPipeline: recorder.createPipeline });

    expect(Object.isFrozen(provider.space)).toBe(true);
    // strict mode（ESM）では凍結オブジェクトへの代入は TypeError になる。
    expect(() => {
      (provider.space as { dimensions: number }).dimensions = 999;
    }).toThrow(TypeError);
    expect(provider.space.dimensions).toBe(256);
  });

  it("modelId / dimensions は差し替えられる", () => {
    const recorder = createRecordingPipeline({ dimensions: 8 });
    const provider = new LocalEmbeddingProvider({
      modelId: "ruri-v3-30m/asym",
      dimensions: 8,
      createPipeline: recorder.createPipeline,
    });
    expect(provider.space.model).toBe("ruri-v3-30m/asym");
    expect(provider.space.dimensions).toBe(8);
  });
});

describe("遅延ロード", () => {
  /**
   * ⭐ **この歯がこのファイルの本体である。**
   *
   * Promise を握らない素朴な実装（読み込み済みの pipeline だけを持つ形）では、
   * 同時に来た8本の `embed()` が全員それぞれモデルを読み込み、
   * 557ms / 406MB が 3,138ms / 1,009MB になることを実測している。
   * **`createPipeline` の呼び出し回数を数えることで、その形へ戻ったら赤くなる。**
   *
   * ゲートで読み込みを止めたまま8本を投げる——止めないと、1本目が
   * マイクロタスク1つで解決してしまい、競合の窓が開かないことがある。
   */
  it("並行する embed() 8本でも、モデルの読み込みは1回だけ", async () => {
    let openGate = (): void => {};
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    const recorder = createRecordingPipeline({ gate });
    const provider = new LocalEmbeddingProvider({ createPipeline: recorder.createPipeline });

    const inFlight = Array.from({ length: 8 }, (_, index) =>
      provider.embed(ctx, [`テキスト ${index}`]),
    );
    openGate();
    const results = await Promise.all(inFlight);

    expect(recorder.calls).toBe(1);
    expect(results).toHaveLength(8);
    for (const vectors of results) {
      expect(vectors).toHaveLength(1);
      expect(vectors[0]).toHaveLength(256);
    }
  });

  it("続けて呼んでも読み込みは増えない", async () => {
    const recorder = createRecordingPipeline();
    const provider = new LocalEmbeddingProvider({ createPipeline: recorder.createPipeline });

    await provider.embed(ctx, ["1本目"]);
    await provider.embed(ctx, ["2本目"]);
    await provider.embed(ctx, ["3本目"]);

    expect(recorder.calls).toBe(1);
  });

  /**
   * 失敗した Promise を握り続けると、**一度の一時的な失敗が、そのインスタンスを
   * 永久に使えなくする**（ネットワークが落ちていた最初の1回で終わる）。
   */
  it("読み込みに失敗しても、次の呼び出しで再試行できる", async () => {
    let attempts = 0;
    const createPipeline: CreateLocalEmbeddingPipeline = async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("ネットワークが落ちていた");
      return async (texts) => texts.map(() => Array.from({ length: 256 }, () => 0.1));
    };
    const provider = new LocalEmbeddingProvider({ createPipeline });

    // ⚠ 失敗は包まれる（下の describe を見ること）ので、cause 側で確かめる。
    await expect(provider.embed(ctx, ["1回目"])).rejects.toThrow(/モデルを読み込めなかった/);
    const vectors = await provider.embed(ctx, ["2回目"]);

    expect(attempts).toBe(2);
    expect(vectors).toHaveLength(1);
  });

  it("createPipeline が同期に throw しても、reject として返る（例外が素通りしない）", async () => {
    const createPipeline = (() => {
      throw new Error("同期に落ちた");
    }) as unknown as CreateLocalEmbeddingPipeline;
    const provider = new LocalEmbeddingProvider({ createPipeline });

    const error = await provider.embed(ctx, ["テキスト"]).then(
      () => undefined,
      (reason: unknown) => reason,
    );
    expect((error as Error | undefined)?.cause).toBeInstanceOf(Error);
    expect(((error as Error).cause as Error).message).toBe("同期に落ちた");
  });

  it("同時に来た8本が全部失敗しても、読み込みは1回だけで、その後再試行できる", async () => {
    let attempts = 0;
    const createPipeline: CreateLocalEmbeddingPipeline = async (_spec) => {
      attempts += 1;
      await Promise.resolve();
      if (attempts === 1) throw new Error("落ちた");
      return async (texts) => texts.map(() => Array.from({ length: 256 }, () => 0.1));
    };
    const provider = new LocalEmbeddingProvider({ createPipeline });

    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () => provider.embed(ctx, ["テキスト"])),
    );
    expect(results.every((r) => r.status === "rejected")).toBe(true);
    expect(attempts).toBe(1);

    await expect(provider.embed(ctx, ["テキスト"])).resolves.toHaveLength(1);
    expect(attempts).toBe(2);
  });
});

describe("読み込み失敗のメッセージ", () => {
  /**
   * 既定の repo は**個人の変換 repo** であり、消えうる。それを承知で選べているのは
   * **元モデルが公式（`cl-nagoya/ruri-v3-30m`, apache-2.0）で、変換をやり直せる**からである。
   * ⟹ **その情報が、repo が消えて落ちた人に届かなければ、選択の前提が成立しない。**
   * 届く先は doc ではなく、その人が最初に見るもの——**例外のメッセージ**である。
   *
   * ⚠ **文面を全文一致で固定しない。**そうすると文言のほうを直せなくなる。
   * 見るのは「必要なものが入っているか」だけ。
   */
  const failing: CreateLocalEmbeddingPipeline = async () => {
    throw new Error("HTTP 404: model not found");
  };

  async function loadFailure(
    options: ConstructorParameters<typeof LocalEmbeddingProvider>[0],
  ): Promise<Error> {
    const provider = new LocalEmbeddingProvider(options);
    const reason = await provider.embed(ctx, ["テキスト"]).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(reason, "読み込みが失敗したのに reject しなかった").toBeInstanceOf(Error);
    return reason as Error;
  }

  it("実際に使った repo 名が入る（既定値ではなく）", async () => {
    const error = await loadFailure({ repo: "someone/my-own-conversion", createPipeline: failing });
    expect(error.message).toContain("someone/my-own-conversion");
    expect(error.message).not.toContain("sirasagi62/ruri-v3-30m-ONNX");
  });

  it("既定で使ったときは既定の repo 名が入る", async () => {
    const error = await loadFailure({ createPipeline: failing });
    expect(error.message).toContain("sirasagi62/ruri-v3-30m-ONNX");
  });

  it("実際に使った dtype と cacheDir が入る", async () => {
    const error = await loadFailure({
      dtype: "fp32",
      cacheDir: "/tmp/mnemora-models",
      createPipeline: failing,
    });
    expect(error.message).toContain("fp32");
    expect(error.message).toContain("/tmp/mnemora-models");
  });

  it("元の例外を cause に保持している（404 とネットワーク断と dtype 誤りを潰さない）", async () => {
    const original = new Error("HTTP 404: model not found");
    const error = await loadFailure({
      createPipeline: async () => {
        throw original;
      },
    });
    expect(error.cause).toBe(original);
  });

  it("やり直せること（元モデル・変換・repo オプション）が書いてある", async () => {
    const error = await loadFailure({ createPipeline: failing });
    // 元モデルの識別子が無いと、読んだ人は何を変換すればよいか分からない。
    expect(error.message).toContain("cl-nagoya/ruri-v3-30m");
    // 変換したものをどこへ差すか。
    expect(error.message).toContain("repo");
    // 詳しい手順の在り処。
    expect(error.message).toContain("README");
  });

  it("包んでも、次の呼び出しで再試行できる（包むことと握り続けることは別）", async () => {
    let attempts = 0;
    const createPipeline: CreateLocalEmbeddingPipeline = async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("HTTP 404: model not found");
      return async (texts) => texts.map(() => Array.from({ length: 256 }, () => 0.1));
    };
    const provider = new LocalEmbeddingProvider({ createPipeline });

    await expect(provider.embed(ctx, ["1回目"])).rejects.toThrow(/モデルを読み込めなかった/);
    await expect(provider.embed(ctx, ["2回目"])).resolves.toHaveLength(1);
    expect(attempts).toBe(2);
  });
});

describe("warmup()", () => {
  it("読み込みを起こし、その後の embed() は読み込み直さない", async () => {
    const recorder = createRecordingPipeline();
    const provider = new LocalEmbeddingProvider({ createPipeline: recorder.createPipeline });

    expect(recorder.calls).toBe(0);
    await provider.warmup();
    expect(recorder.calls).toBe(1);

    await provider.embed(ctx, ["ウォームアップ後の1本目"]);
    expect(recorder.calls).toBe(1);
  });

  it("推論は走らせない（モデルへ勝手な入力を流さない）", async () => {
    const recorder = createRecordingPipeline();
    const provider = new LocalEmbeddingProvider({ createPipeline: recorder.createPipeline });

    await provider.warmup();
    expect(recorder.embeddedBatches).toEqual([]);
  });

  it("2回呼んでも読み込みは1回", async () => {
    const recorder = createRecordingPipeline();
    const provider = new LocalEmbeddingProvider({ createPipeline: recorder.createPipeline });

    await Promise.all([provider.warmup(), provider.warmup()]);
    await provider.warmup();

    expect(recorder.calls).toBe(1);
  });
});

describe("embed(ctx, [])", () => {
  it("[] を返し、モデルを一度も読み込まない", async () => {
    const recorder = createRecordingPipeline();
    const provider = new LocalEmbeddingProvider({ createPipeline: recorder.createPipeline });

    await expect(provider.embed(ctx, [])).resolves.toEqual([]);
    // ⚠ **だから空配列ではウォームアップできない。**`warmup()` が要る理由がこれである。
    expect(recorder.calls).toBe(0);
  });
});

describe("次元の検査", () => {
  /**
   * `interfaces/embedding-provider.ts` の「次元をモデルに応じて動的に変える実装は
   * 許容しない」を**実行時に守らせる歯**。宣言と中身が食い違ったまま DB へ入ると、
   * `EmbeddingSpaceId` はテーブル名スラグの導出元なので、後から分けられない。
   */
  it("宣言した次元と実物が食い違うと、初回 embed() で例外になる", async () => {
    const recorder = createRecordingPipeline({ dimensions: 384 });
    const provider = new LocalEmbeddingProvider({
      dimensions: 256,
      createPipeline: recorder.createPipeline,
    });

    await expect(provider.embed(ctx, ["テキスト"])).rejects.toThrow(/LocalEmbeddingProvider/);
  });

  it("例外のメッセージに、宣言値と実測値の両方が入る", async () => {
    const recorder = createRecordingPipeline({ dimensions: 384 });
    const provider = new LocalEmbeddingProvider({
      dimensions: 256,
      createPipeline: recorder.createPipeline,
    });

    // 片方だけ書いてあると、読んだ人は「何と食い違ったのか」を調べ直すことになる。
    await expect(provider.embed(ctx, ["テキスト"])).rejects.toThrow(/256/);
    await expect(provider.embed(ctx, ["テキスト"])).rejects.toThrow(/384/);
  });

  it("次元が合っていれば通る", async () => {
    const recorder = createRecordingPipeline({ dimensions: 256 });
    const provider = new LocalEmbeddingProvider({ createPipeline: recorder.createPipeline });

    const vectors = await provider.embed(ctx, ["あ", "い"]);
    expect(vectors.map((v) => v.length)).toEqual([256, 256]);
  });
});

describe("件数の検査", () => {
  it("返ったベクトルの件数が入力件数と違えば例外になる", async () => {
    const recorder = createRecordingPipeline({ countDelta: -1 });
    const provider = new LocalEmbeddingProvider({ createPipeline: recorder.createPipeline });

    // 黙って返すと、呼び出し側で memory とベクトルが1つずれて対応する。
    await expect(provider.embed(ctx, ["あ", "い", "う"])).rejects.toThrow(/3 件.*2 件/s);
  });

  it("多すぎても例外になる", async () => {
    const recorder = createRecordingPipeline({ countDelta: 1 });
    const provider = new LocalEmbeddingProvider({ createPipeline: recorder.createPipeline });

    await expect(provider.embed(ctx, ["あ"])).rejects.toThrow(/1 件.*2 件/s);
  });
});

describe("prefix", () => {
  it("既定（空文字）では、テキストに何も足さない", async () => {
    const recorder = createRecordingPipeline();
    const provider = new LocalEmbeddingProvider({ createPipeline: recorder.createPipeline });

    await provider.embed(ctx, ["紅茶が好き", "コーヒーが好き"]);

    expect(recorder.embeddedBatches).toEqual([["紅茶が好き", "コーヒーが好き"]]);
  });

  it("明示すると、全件に同じものが付く（クエリと文書を区別しない）", async () => {
    const recorder = createRecordingPipeline();
    const provider = new LocalEmbeddingProvider({
      prefix: "検索文書: ",
      createPipeline: recorder.createPipeline,
    });

    await provider.embed(ctx, ["紅茶が好き", "コーヒーが好き"]);

    // ⭐ 「全件に同じもの」が仕様である。embed() は渡されたテキストがクエリなのか
    // 文書なのかを知らないので、区別できるふりをしない（options.prefix の説明）。
    expect(recorder.embeddedBatches).toEqual([
      ["検索文書: 紅茶が好き", "検索文書: コーヒーが好き"],
    ]);
  });

  /**
   * 🔴 **呼び出し側が渡した配列を、下流へ素通ししない。**
   *
   * この歯が在るのは、実際に踏んだからである——`prefix` が空のときだけ
   * `texts` をそのまま `createPipeline` の先へ渡していた。書き換える pipeline を
   * 注入すると、**既定の設定でだけ呼び出し側の配列が壊れ、`prefix` を設定すると
   * 壊れなかった。振る舞いが設定に依存し、しかも壊れるほうが既定だった。**
   *
   * ⚠ **2つの設定の両方で測る。**片方だけだと、また分岐が生えたときに気づけない
   * （前回まさにその分岐が原因だった）。
   */
  it.each([
    ["既定（prefix が空）", undefined],
    ["prefix を設定したとき", "検索文書: "],
  ])("%s、下流が書き換えても呼び出し側の配列は壊れない", async (_label, prefix) => {
    const createPipeline = async (): Promise<LocalEmbeddingPipeline> => async (texts) => {
      texts[0] = "下流が書き換えた";
      return texts.map(() => [0, 0]);
    };
    const provider = new LocalEmbeddingProvider({ dimensions: 2, prefix, createPipeline });

    const mine = ["紅茶が好き", "コーヒーが好き"];
    await provider.embed(ctx, mine);

    expect(mine).toEqual(["紅茶が好き", "コーヒーが好き"]);
  });

  it("prefix を付けても、返るベクトルの件数は入力どおり", async () => {
    const recorder = createRecordingPipeline();
    const provider = new LocalEmbeddingProvider({
      prefix: "検索文書: ",
      createPipeline: recorder.createPipeline,
    });

    await expect(provider.embed(ctx, ["あ", "い", "う"])).resolves.toHaveLength(3);
  });
});

describe("モデル指定が createPipeline へ届く（配線）", () => {
  it("既定値がそのまま渡る", async () => {
    const recorder = createRecordingPipeline();
    const provider = new LocalEmbeddingProvider({ createPipeline: recorder.createPipeline });

    await provider.warmup();

    expect(recorder.specs[0]).toEqual({
      repo: "sirasagi62/ruri-v3-30m-ONNX",
      dtype: "q8",
      cacheDir: undefined,
      numThreads: 4,
    });
  });

  it("差し替えた値がそのまま渡る", async () => {
    const recorder = createRecordingPipeline();
    const provider = new LocalEmbeddingProvider({
      repo: "someone/other-onnx",
      dtype: "fp32",
      cacheDir: "/tmp/mnemora-models",
      numThreads: 1,
      createPipeline: recorder.createPipeline,
    });

    await provider.warmup();

    expect(recorder.specs[0]).toEqual({
      repo: "someone/other-onnx",
      dtype: "fp32",
      cacheDir: "/tmp/mnemora-models",
      numThreads: 1,
    });
  });
});
