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
  /**
   * 各 `it` のタイムアウト（ミリ秒）。**省略時は vitest の既定（5秒）。**
   *
   * **なぜ要るか**: この suite は本物の実装にも当たる（Issue #116 の残債）。
   * ネットワーク往復や、42MB の ONNX モデルのプロセス内ロードは 5 秒に収まらない。
   * しかも `createProvider` は**毎回新しいインスタンスを作る**契約なので、
   * その費用は `it` の本数だけ繰り返し掛かる。
   *
   * ⚠ **`deterministic` と違って、こちらは省略できてよい**——`undefined` は
   * 「vitest の既定に従う」という**曖昧さの無い**意味しか持たない。
   * `deterministic` の `undefined` が「決定的でない」と「宣言し忘れた」に
   * 割れてしまうのとは事情が違う（**決定2 の理由をここへ持ち込まないこと**）。
   * `it(name, fn, undefined)` が `it(name, fn)` と同じに振る舞うことは、
   * vitest 5.0.0 で実際に走らせて確かめてある。
   */
  timeout?: number;
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
  const { name, createProvider, deterministic, texts, ctx = defaultCtx, timeout } = options;
  const { a, b, c } = texts;

  describe(`EmbeddingProvider conformance (${name})`, () => {
    it(
      "space.provider / space.model は空でない文字列で、space.dimensions は正の整数である",
      async () => {
        const provider = await createProvider();

        expect(provider.space.provider.length).toBeGreaterThan(0);
        expect(provider.space.model.length).toBeGreaterThan(0);
        expect(Number.isInteger(provider.space.dimensions)).toBe(true);
        expect(provider.space.dimensions).toBeGreaterThan(0);
      },
      timeout,
    );

    it(
      "space は embed() の前後で変わらない（provider/model/dimensions とも）",
      async () => {
        const provider = await createProvider();
        const before = { ...provider.space };

        await provider.embed(ctx, [a, b, c]);

        expect(provider.space.provider).toBe(before.provider);
        expect(provider.space.model).toBe(before.model);
        expect(provider.space.dimensions).toBe(before.dimensions);
      },
      timeout,
    );

    it(
      "embed(ctx, []) は [] を返す",
      async () => {
        const provider = await createProvider();

        const vectors = await provider.embed(ctx, []);

        expect(vectors).toEqual([]);
      },
      timeout,
    );

    it(
      "embed(ctx, [a, b, c]) はちょうど3件返す",
      async () => {
        const provider = await createProvider();

        const vectors = await provider.embed(ctx, [a, b, c]);

        expect(vectors).toHaveLength(3);
      },
      timeout,
    );

    it(
      "返る各ベクトルの長さは space.dimensions と一致する",
      async () => {
        const provider = await createProvider();

        const vectors = await provider.embed(ctx, [a, b, c]);

        for (const vector of vectors) {
          expect(vector).toHaveLength(provider.space.dimensions);
        }
      },
      timeout,
    );

    it(
      "ベクトルの各成分は有限の数である（NaN/Infinity を含まない）",
      async () => {
        const provider = await createProvider();

        const vectors = await provider.embed(ctx, [a, b, c]);

        for (const vector of vectors) {
          for (const component of vector) {
            expect(Number.isFinite(component)).toBe(true);
          }
        }
      },
      timeout,
    );

    it(
      "1件だけ渡すと1件返る",
      async () => {
        const provider = await createProvider();

        const vectors = await provider.embed(ctx, [a]);

        expect(vectors).toHaveLength(1);
      },
      timeout,
    );

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
      timeout,
    );

    // ⚠ 順序の検査は決定性を前提にしている——決定的でない実装では、順序が正しいことを
    // この方法では確かめられない（同じ入力に毎回違うベクトルを返してよい実装にとって、
    // 「並べ替えた入力の結果を並べ直して比較する」ことに意味が無いため）。
    // これは潰してはならない区別である：`deterministic: false` を選んだ実装に対して
    // この歯を黙って走らせてはならない。
    //
    // 🔴🔴 **2件の入れ替え（`[a,b]` と `[b,a]`）ではなく、3件の巡回（`[a,b,c]` と
    // `[b,c,a]`）で測る。これは意図であって、大は小を兼ねる式の飾りではない。**
    //
    // **なぜ変えたか（Issue #116 の残債作業で実測して分かった）**: この歯は元々
    // 「`embed([a,b])[0]` と `embed([b,a])[1]` が一致するか」を見ていた。ところが
    // **入力順をつねに逆にして返す実装は、その等式を恒等的に満たす**
    // （`[a,b]→[vb,va]` なので0番目は `vb`、`[b,a]→[va,vb]` なので1番目も `vb`）。
    // ⟹ **2件では「入力順を守る」と「入力順をきっちり逆にする」を区別できない。**
    // 実測: `OpenAIEmbeddingProvider` から `index` による並べ直し（`.sort(...)`）を
    // 丸ごと外す変異を入れても、この歯は緑のままだった（落ちたのは
    // `packages/openai` 自身のユニットテスト1本だけ）。
    //
    // 3件の巡回にすると、同じ「つねに逆順」の実装は
    // `[a,b,c]→[vc,vb,va]` / `[b,c,a]→[va,vc,vb]` となり、
    // `abc[0]=vc` に対して `bca[2]=vb` ⟹ **落ちる。**
    // ⚠ **バッチ不変性は相変わらず要求していない**——比べる2回はどちらも3件のバッチであり、
    // 「`embed([a,b])` と `embed([a])` が一致するか」は依然として問うていない（決定5）。
    maybeIt(
      "順序が入力順に対応する: [a,b,c] と、1つ回した [b,c,a] で、同じテキストの位置どうしが一致する",
      async () => {
        const provider = await createProvider();

        const abc = await provider.embed(ctx, [a, b, c]);
        const bca = await provider.embed(ctx, [b, c, a]);

        // a は abc の0番目 / bca の2番目、b は abc の1番目 / bca の0番目、
        // c は abc の2番目 / bca の1番目に居る。
        expect(abc[0]).toEqual(bca[2]);
        expect(abc[1]).toEqual(bca[0]);
        expect(abc[2]).toEqual(bca[1]);
      },
      timeout,
    );
  });
}
