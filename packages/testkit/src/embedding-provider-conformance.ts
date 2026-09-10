import { describe, expect, it } from "vitest";
import type { Ctx, EmbeddingProvider } from "@mnemora/core";

/**
 * 適合テストが埋め込ませる3本のテキスト。
 *
 * **suite 側で文字列を決め打ちしない。**`RecordedEmbeddingProvider`（ADR 0051）は
 * 記録に無い入力を渡されると例外を投げるため、「a」「b」「c」に何を使うかは
 * 呼び出し側（カセットを持っている側）にしか決められない。
 */
export interface EmbeddingProviderConformanceTexts {
  readonly a: string;
  readonly b: string;
  readonly c: string;
}

export interface EmbeddingProviderConformanceOptions {
  /** 見出しに出す名前（どの実装を測っているかがログで分かる）。 */
  name: string;
  /**
   * **毎回新しいインスタンスを作る**関数。
   *
   * ⛔ 同じインスタンスを使い回さないこと——`describeEmbeddingProviderConformance` の
   * それぞれの `it()` は「1インスタンス = 1 space に固定される」（`EmbeddingProvider` の
   * interface doc、`packages/core/src/interfaces/embedding-provider.ts`）という契約を
   * 前提に、都度まっさらなインスタンスで検査する。使い回すと、ある `it()` が前の
   * `it()` の副作用（キャッシュ等）を踏んでいないかをこの suite では区別できなくなる。
   */
  createProvider: () => EmbeddingProvider | Promise<EmbeddingProvider>;
  /**
   * 🔴 **同じ入力に同じベクトルを返すか。省略できない（必ず宣言すること）。**
   *
   * `false` のとき、決定性に依存する歯は消えるのではなく **`it.skip` として名前だけ残る**
   * ——「測っていない」ことをテスト名で名乗る。⛔ 黙って消えてはならない。歯の名前が
   * 消えると、「そもそも無い」のか「走って通った」のかをログから区別できなくなる。
   */
  deterministic: boolean;
  /** 埋め込ませるテキスト3本。理由は `EmbeddingProviderConformanceTexts` の doc を参照。 */
  texts: EmbeddingProviderConformanceTexts;
  /** 省略時は `{ tenantId: "embedding-provider-conformance" }`。 */
  ctx?: Ctx;
}

const defaultCtx: Ctx = { tenantId: "embedding-provider-conformance" };

/**
 * `EmbeddingProvider` の適合テスト（Issue #116）。
 *
 * `packages/core/src/interfaces/embedding-provider.ts` が定める契約——
 * 「1つのインスタンスは1つの `EmbeddingSpaceId` に固定される」「`embed` は入力と
 * 同じ件数・同じ順序でベクトルを返す」——を、実装を問わず同じ歯で検査する。
 * 実装は実質4つある（`@mnemora/openai`／`@mnemora/local-embedding`／testkit の
 * `DeterministicEmbeddingProvider`／`RecordedEmbeddingProvider`）が、それらが
 * 同じ契約を満たすことを検査する歯はこれまで存在しなかった。
 *
 * ⛔ **バッチ不変性は検査しない**（`embed([a,b])` が `embed([a])` と `embed([b])` の
 * 連結と一致するか）。本物の埋め込みモデルは padding を伴うバッチ処理をするため、
 * 成立するとは限らず、まだ measure していない——ADR で「確かめていないこと」として
 * 扱う（PR 本文参照）。ここで測るのはあくまで「1回の `embed` 呼び出しの中で、
 * 返る順序が入力順に対応するか」までである。
 */
export function describeEmbeddingProviderConformance(
  options: EmbeddingProviderConformanceOptions,
): void {
  const { name, createProvider, deterministic, texts, ctx = defaultCtx } = options;
  const { a, b, c } = texts;

  describe(`EmbeddingProvider conformance (${name})`, () => {
    it("space.provider / space.model は空でない文字列で、space.dimensions は正の整数である", async () => {
      const provider = await createProvider();

      expect(provider.space.provider.length).toBeGreaterThan(0);
      expect(provider.space.model.length).toBeGreaterThan(0);
      expect(Number.isInteger(provider.space.dimensions)).toBe(true);
      expect(provider.space.dimensions).toBeGreaterThan(0);
    });

    it("space は embed() の前後で変わらない（provider/model/dimensions とも）", async () => {
      const provider = await createProvider();
      const before = { ...provider.space };

      await provider.embed(ctx, [a, b, c]);

      expect(provider.space.provider).toBe(before.provider);
      expect(provider.space.model).toBe(before.model);
      expect(provider.space.dimensions).toBe(before.dimensions);
    });

    it("embed(ctx, []) は [] を返す", async () => {
      const provider = await createProvider();

      const vectors = await provider.embed(ctx, []);

      expect(vectors).toEqual([]);
    });

    it("embed(ctx, [a, b, c]) はちょうど3件返す", async () => {
      const provider = await createProvider();

      const vectors = await provider.embed(ctx, [a, b, c]);

      expect(vectors).toHaveLength(3);
    });

    it("返る各ベクトルの長さは space.dimensions と一致する", async () => {
      const provider = await createProvider();

      const vectors = await provider.embed(ctx, [a, b, c]);

      for (const vector of vectors) {
        expect(vector).toHaveLength(provider.space.dimensions);
      }
    });

    it("ベクトルの各成分は有限の数である（NaN/Infinity を含まない）", async () => {
      const provider = await createProvider();

      const vectors = await provider.embed(ctx, [a, b, c]);

      for (const vector of vectors) {
        for (const component of vector) {
          expect(Number.isFinite(component)).toBe(true);
        }
      }
    });

    it("1件だけ渡すと1件返る", async () => {
      const provider = await createProvider();

      const vectors = await provider.embed(ctx, [a]);

      expect(vectors).toHaveLength(1);
    });

    // 以下は `deterministic: true` の実装だけに要求する歯。`false` のときは
    // 消さずに `it.skip` として名前を残す——「無い」と「決定的でないので測っていない」を
    // ログ上で区別できるようにするため（`EmbeddingProviderConformanceOptions.deterministic`
    // の doc を参照）。
    const maybeIt = deterministic ? it : it.skip;

    maybeIt(
      "同じ入力を2回渡すと、同じインスタンスからまったく同じベクトルが返る（要素ごとに厳密一致）",
      async () => {
        const provider = await createProvider();

        const first = await provider.embed(ctx, [a, b, c]);
        const second = await provider.embed(ctx, [a, b, c]);

        expect(second).toEqual(first);
      },
    );

    // ⚠ 順序の検査は決定性を前提にしている——決定的でない実装では、順序が正しいことを
    // この方法では確かめられない（同じ入力に毎回違うベクトルを返してよい実装にとって、
    // 「入れ替えた入力の結果を入れ替えて比較する」ことに意味が無いため）。
    // これは潰してはならない区別である：`deterministic: false` を選んだ実装に対して
    // この歯を黙って走らせてはならない。
    maybeIt(
      "順序が入力順に対応する: embed([a,b]) の0番目と embed([b,a]) の1番目が一致し、" +
        "embed([a,b]) の1番目と embed([b,a]) の0番目が一致する",
      async () => {
        const provider = await createProvider();

        const ab = await provider.embed(ctx, [a, b]);
        const ba = await provider.embed(ctx, [b, a]);

        expect(ab[0]).toEqual(ba[1]);
        expect(ab[1]).toEqual(ba[0]);
      },
    );
  });
}
