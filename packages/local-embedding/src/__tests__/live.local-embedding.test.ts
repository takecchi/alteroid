import { describe, expect, it } from "vitest";
import {
  DEFAULT_LOCAL_EMBEDDING_DTYPE,
  DEFAULT_LOCAL_EMBEDDING_NUM_THREADS,
  DEFAULT_LOCAL_EMBEDDING_REPO,
  LocalEmbeddingProvider,
} from "../local-embedding-provider.js";
import { buildLocalEmbeddingPipeline, createLocalEmbeddingPipeline } from "../pipeline.js";
import type {
  LocalEmbeddingExtractor,
  LocalEmbeddingModelSpec,
  LocalEmbeddingTokenizer,
} from "../pipeline.js";
import { describeEmbeddingProviderConformance } from "@mnemora/testkit";
import { isLocalEmbeddingProviderError } from "../errors.js";
import type { LocalEmbeddingProviderError } from "../errors.js";

/**
 * live テスト（**本物のモデルを Hugging Face から落として、プロセス内で推論する**。
 * 明示的な opt-in が要る）。
 *
 * **`packages/openai` の `live.openai.test.ts` と同じ形にしてある。**
 * そちらは「鍵を持っていることは、いま課金してよいという意思表示ではない」
 * （[ADR 0019 §5c](../../../../docs/decisions/0019-real-openai-measurement-cost.md)）
 * を理由に、環境変数での opt-in を要求している。
 *
 * **⚠ ここで opt-in を要求する理由は課金ではない**——このパッケージは外部サービスへ
 * 繋がないので、API 料金は発生しない。要求するのは、**36MB のモデルのダウンロードと、
 * peak RSS 362MB の推論が、`pnpm run test` を1回打っただけで走る**からである。
 * ネットワークの無い環境ではダウンロードで固まり、CI では毎回同じものを落とし直す。
 * **「無料だから黙って走らせてよい」ではない。**
 *
 * ⟹ 走る条件は1つ: `MNEMORA_LIVE_LOCAL_EMBEDDING` が空でない値であること。
 * `packages/openai` の2条件（鍵 + opt-in）のうち、**鍵に当たるものがここには無い。**
 *
 * `MNEMORA_LIVE_LOCAL_EMBEDDING` は**空でない値なら何でも opt-in とみなす**
 * （`1` / `true` / `yes`）。特定の綴りだけを受け付けて他を黙って無視すると、
 * 「設定したのに走らない」という静かな罠を作る。
 *
 * **CI では走らない。**この変数を設定していないため、CI 上ではこの `describe` の
 * 各 it が常に `skipped` として表示される（`it.skipIf` を使う——`describe.skip` や
 * 「ファイル自体を読み込まない」形にはしない。テスト名を消してしまう
 * `if (!live) return` は採らない——それだと「1件パスした」という誤った印象を残す）。
 *
 * ローカルで実行するには（**モデルを落とす。初回は数十秒かかる**）:
 *   MNEMORA_LIVE_LOCAL_EMBEDDING=1 pnpm --filter @mnemora/local-embedding test
 */
const live = (process.env.MNEMORA_LIVE_LOCAL_EMBEDDING ?? "") !== "";

/** cos 類似度。ベクトルは L2 正規化済みなので内積と一致するが、前提を置かずに割る。 */
function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (const [index, value] of a.entries()) {
    const other = b[index] ?? 0;
    dot += value * other;
    na += value * value;
    nb += other * other;
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

describe("live: local embedding (MNEMORA_LIVE_LOCAL_EMBEDDING が無ければ skipped と表示される)", () => {
  it.skipIf(!live)(
    "日本語2文を埋め込むと、宣言どおり 256 次元のベクトルが返る",
    async () => {
      const provider = new LocalEmbeddingProvider();
      const vectors = await provider.embed({ tenantId: "live-test" }, [
        "今日は雨が降っている",
        "会議は水曜日に延期になった",
      ]);

      expect(vectors).toHaveLength(2);
      expect(vectors[0]).toHaveLength(256);
      expect(vectors[1]).toHaveLength(256);
      // L2 正規化しているので、ノルムは 1 のはず。
      expect(cosine(vectors[0] ?? [], vectors[0] ?? [])).toBeCloseTo(1, 5);
    },
    120_000,
  );

  it.skipIf(!live)(
    "同義のペアのほうが、無関係なペアより cos が大きい",
    async () => {
      const provider = new LocalEmbeddingProvider();
      const [a, b, c] = await provider.embed({ tenantId: "live-test" }, [
        "猫が窓辺で眠っている",
        "ネコが窓のそばで寝ている",
        "為替相場が円安に振れた",
      ]);

      const synonymous = cosine(a ?? [], b ?? []);
      const unrelated = cosine(a ?? [], c ?? []);

      // ⚠ ここで測っているのは**その程度のことだけ**である。
      // 「否定・時制・矛盾を解ける」ことは測っていない——実際、解けない
      // （README「何が良くならないか」を見ること）。
      expect(synonymous).toBeGreaterThan(unrelated);
    },
    120_000,
  );
});

/**
 * live: 「8192トークンの壁」（`sirasagi62/ruri-v3-30m-ONNX` の `model_max_length`）。
 *
 * `packages/local-embedding/src/__tests__/input-token-limit.test.ts` は擬似 extractor で
 * 「上限をどう受け取り、超過をどう名乗るか」という**このパッケージ自身のロジック**を CI から測る。
 * ⚠ **8192 という数字そのものはそこでは測っていない。**それはモデルが持つ事実であり、
 * 本物のモデルを落とさないと確かめられない。ここが、その数字を固定する。
 *
 * 3本の歯:
 * 1. 本物のモデルが宣言する上限が、逐語で 8192 であること。
 * 2. 上限ちょうど（8192）は通り、1トークン超える（8193）と落ちること（境界が `>` であること）。
 * 3. 🔴 私たちの検査を外したら、実際に何が起きるか——8192 トークンを超えた入力が
 *    黙って切り捨てられ、後ろが一切ベクトルに効かなくなることを、同じ live テストの中で見せる。
 */
describe("live: 8192トークンの壁 (MNEMORA_LIVE_LOCAL_EMBEDDING が無ければ skipped と表示される)", () => {
  /**
   * 崩れにくい（＝同じ文字の連打で BPE に圧縮されない）巡回文字列。
   *
   * ⚠ **なぜ単純な1文字の繰り返し（`"あ".repeat(n)`）を使わないか（実測で確認済み）。**
   * `"あ".repeat(100)` は 15 トークンにしかならない——同じ文字の連続は大きな塊トークンに
   * 圧縮され、1文字足したときのトークン数の増分が予測できない（0 でも 2 以上でも起こりうる）。
   * ⟹ 二分探索で「ちょうど」を狙っても、その増分を飛び越えて外れることがある。
   *
   * 巡回させて連続する同一文字を無くすと、実測で**増分が常に 0 か 1**になる
   * （`n=1000` 付近で 30 文字ぶん実測して確認済み）。増分が高々1なら、文字数を1つずつ
   * 増やす道の途中で「ちょうど target」を必ず一度は通る——二分探索の結果を信用できる。
   */
  const KANA_CYCLE =
    "あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめもやゆよらりるれろわをん";

  function kanaText(length: number): string {
    let s = "";
    for (let i = 0; i < length; i++) s += KANA_CYCLE[i % KANA_CYCLE.length];
    return s;
  }

  /**
   * `kanaText(n)` の `n` を二分探索し、**トークン数がちょうど `target` になる文字列**を返す。
   *
   * 前提（上記コメント）が崩れていたら、返る文字列のトークン数は `target` と一致しない——
   * 呼び出し側で `tokenizer.encode(text).length` を実測して assert すること
   * （この関数自身は前提を信用して探すだけで、成立を保証しない）。
   */
  function findKanaTextWithExactTokenCount(
    tokenizer: LocalEmbeddingTokenizer,
    target: number,
  ): { text: string; length: number } {
    const tokenCountAt = (n: number) => tokenizer.encode(kanaText(n)).length;
    let hi = 1;
    while (tokenCountAt(hi) < target) hi *= 2;
    let lo = 0;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (tokenCountAt(mid) >= target) hi = mid;
      else lo = mid + 1;
    }
    return { text: kanaText(lo), length: lo };
  }

  /** `fromLength` から1文字ずつ伸ばして、トークン数がちょうど `target` になる文字列を探す。 */
  function extendKanaTextToExactTokenCount(
    tokenizer: LocalEmbeddingTokenizer,
    fromLength: number,
    target: number,
  ): { text: string; length: number } {
    let n = fromLength;
    let text = kanaText(n);
    while (tokenizer.encode(text).length < target) {
      n += 1;
      text = kanaText(n);
    }
    return { text, length: n };
  }

  /**
   * `extractor` を、**`tokenizer.model_max_length` だけ**巨大な値に差し替えて包む。
   *
   * ⚠ **`encode` は本物をそのまま使う**——差し替えるのは「上限として申告する値」だけである。
   * こうして作った extractor を `buildLocalEmbeddingPipeline` に渡すと、**私たちの
   * 事前チェック（推論の前にトークン数を数えて上限と比べる歯）は発火しなくなる。**
   *
   * ⟹ その状態で実際に埋め込みを取ると、`extractor(texts, ...)` 自体
   * （transformers.js の feature-extraction pipeline の内部）が、**この差し替えとは無関係に**
   * 本物のトークナイザの本物の `model_max_length`（8192）で `truncation: true` の
   * 黙った切り詰めを行う——それが歯3で実測する「穴」である。
   */
  function withHugeDeclaredLimit(extractor: LocalEmbeddingExtractor): LocalEmbeddingExtractor {
    return Object.assign(
      (texts: string[], options: { pooling: "mean"; normalize: boolean }) =>
        extractor(texts, options),
      {
        tokenizer: {
          model_max_length: 10_000_000,
          encode: (text: string) => extractor.tokenizer.encode(text),
        },
      },
    ) as unknown as LocalEmbeddingExtractor;
  }

  /**
   * 本物の feature-extraction extractor を、**プロセス内で1回だけ**読み込んで使い回す。
   *
   * ⚠ **`live` が真の `it` の中からしか呼ばれない**（`it.skipIf` の外・モジュール読み込み時点
   * では一切呼ばれない——opt-in していないときにモデルを読み込まないことは、このパッケージの
   * live テストが要求する固定点である。上の既存2本の it が `describe.skip` ではなく
   * `it.skipIf` を使っている理由と同じ）。
   *
   * 歯2・歯3が両方これを使うことで、**36MB のモデル読み込みを1回に畳む**——
   * 歯1は仕様どおり `createLocalEmbeddingPipeline`（公開関数）を直接使うので、
   * そちらは意図的に別読み込みになる。
   */
  let sharedRealExtractorPromise: Promise<LocalEmbeddingExtractor> | null = null;
  function loadSharedRealExtractor(): Promise<LocalEmbeddingExtractor> {
    sharedRealExtractorPromise ??= (async () => {
      const { pipeline } = await import("@huggingface/transformers");
      const extractor = await pipeline("feature-extraction", DEFAULT_LOCAL_EMBEDDING_REPO, {
        dtype: DEFAULT_LOCAL_EMBEDDING_DTYPE,
        session_options: {
          intraOpNumThreads: DEFAULT_LOCAL_EMBEDDING_NUM_THREADS,
          interOpNumThreads: 1,
        },
      });
      return extractor as unknown as LocalEmbeddingExtractor;
    })();
    return sharedRealExtractorPromise;
  }

  it.skipIf(!live)(
    "歯1: 本物のモデルが宣言する上限は、逐語で 8192 トークンである",
    async () => {
      const spec: LocalEmbeddingModelSpec = {
        repo: DEFAULT_LOCAL_EMBEDDING_REPO,
        dtype: DEFAULT_LOCAL_EMBEDDING_DTYPE,
        cacheDir: undefined,
        numThreads: DEFAULT_LOCAL_EMBEDDING_NUM_THREADS,
      };
      const pipeline = await createLocalEmbeddingPipeline(spec);

      // 二分探索は要らない——ここは「確実に超えている」ことだけが要る（歯2が「ちょうど」を測る）。
      // かな巡回 20,000 文字は実測比 (~1000字/782トークン) で 15,000 トークン超になり、
      // 8192 を確実に超える。
      const error = await pipeline([kanaText(20_000)]).then(
        () => null,
        (reason: unknown) => reason,
      );

      expect(isLocalEmbeddingProviderError(error)).toBe(true);
      const typed = error as LocalEmbeddingProviderError;
      expect(typed.kind).toBe("input_too_long");
      // ⚠ 8192 をどこかの定数から組み立てない。モデルが持つ事実を、逐語のリテラルで固定する。
      expect(typed.detail?.maxInputTokens).toBe(8192);
      console.error(`[歯1] detail.maxInputTokens = ${typed.detail?.maxInputTokens}`);
    },
    120_000,
  );

  it.skipIf(!live)(
    "歯2: 上限ちょうど（8192トークン）は通り、1トークン超える（8193トークン）と落ちる",
    async () => {
      const extractor = await loadSharedRealExtractor();
      const tokenizer = extractor.tokenizer;
      const pipeline = buildLocalEmbeddingPipeline(extractor);

      const exact8192 = findKanaTextWithExactTokenCount(tokenizer, 8192);
      const exact8192Tokens = tokenizer.encode(exact8192.text).length;
      expect(exact8192Tokens).toBe(8192);

      const exact8193 = extendKanaTextToExactTokenCount(tokenizer, exact8192.length + 1, 8193);
      const exact8193Tokens = tokenizer.encode(exact8193.text).length;
      expect(exact8193Tokens).toBe(8193);

      console.error(
        `[歯2] 8192トークンちょうど: ${exact8192.text.length} 文字 / ` +
          `8193トークンちょうど: ${exact8193.text.length} 文字`,
      );

      // 上限ちょうどは通る（推論まで走り、256次元のベクトルが返る）。
      const vectors = await pipeline([exact8192.text]);
      expect(vectors).toHaveLength(1);
      expect(vectors[0]).toHaveLength(256);

      // 1トークン超えると落ちる（境界が `>` であることの固定。`>=` なら8192ちょうども落ちるはず）。
      const error = await pipeline([exact8193.text]).then(
        () => null,
        (reason: unknown) => reason,
      );
      expect(isLocalEmbeddingProviderError(error)).toBe(true);
      const typed = error as LocalEmbeddingProviderError;
      expect(typed.kind).toBe("input_too_long");
      expect(typed.detail?.tokens).toBe(8193);
      expect(typed.detail?.maxInputTokens).toBe(8192);
    },
    240_000,
  );

  it.skipIf(!live)(
    "歯3: 🔴 検査を外すと、8192トークンを超えた分は黙って切り捨てられ、ベクトルに一切効かない",
    async () => {
      const extractor = await loadSharedRealExtractor();
      const tokenizer = extractor.tokenizer;

      // 共有の前半は 8300 トークン——8192 の切り詰め点より十分手前から始まり、
      // 「後半200文字が違う」という分岐点は切り詰め点よりずっと後ろに来る。
      const shared = findKanaTextWithExactTokenCount(tokenizer, 8300);
      expect(tokenizer.encode(shared.text).length).toBe(8300);

      const variantA = shared.text + "X".repeat(200);
      const variantB = shared.text + "Y".repeat(200);
      // 差し替えていない本物のトークナイザで数えても、どちらも 8192 を超えていることを確認する
      // （＝これは「本来なら input_too_long で拒否されるべき入力」である）。
      const tokensA = tokenizer.encode(variantA).length;
      const tokensB = tokenizer.encode(variantB).length;
      expect(tokensA).toBeGreaterThan(8192);
      expect(tokensB).toBeGreaterThan(8192);

      // 1. 私たちの検査を外した（model_max_length だけ差し替えた）pipeline: 発火しない。
      //    ⟹ 黙って推論まで進み、8192を超えた後ろは transformers.js 内部の
      //    truncation: true によって黙って切り捨てられる。
      const brokenPipeline = buildLocalEmbeddingPipeline(withHugeDeclaredLimit(extractor));
      const [vectorA] = await brokenPipeline([variantA]);
      const [vectorB] = await brokenPipeline([variantB]);
      const cos = cosine(vectorA ?? [], vectorB ?? []);
      // ⚠ 有効桁を落とさずに出力する（報告に数字を持ち帰るため）。
      console.error(
        `[歯3] 検査を外したときの cos(variantA, variantB) = ${cos} ` +
          `(共有前半 ${shared.text.length} 文字 / ${tokensA}トークン、後半200文字が違う)`,
      );
      // **黙って切り捨てられ、後ろが一切ベクトルに効いていない**ことの直接証拠。
      expect(cos).toBeCloseTo(1, 6);

      // 2. 差し替えていない本物の pipeline: 対になる証拠として、同じ2本が input_too_long で落ちる。
      const realPipeline = buildLocalEmbeddingPipeline(extractor);
      const error = await realPipeline([variantA, variantB]).then(
        () => null,
        (reason: unknown) => reason,
      );
      expect(isLocalEmbeddingProviderError(error)).toBe(true);
      const typed = error as LocalEmbeddingProviderError;
      expect(typed.kind).toBe("input_too_long");
      expect(typed.detail?.maxInputTokens).toBe(8192);
    },
    300_000,
  );
});

/**
 * live: **本物のモデル**に、ADR 0095 の適合テスト9本を当てる（Issue #116 の残債）。
 *
 * `./local-embedding-provider.conformance.test.ts` は同じ9本を、**本物のモデルの出力を
 * 写した pipeline の再生**に対して当てている。そちらが測れないのは
 * 「onnxruntime の推論そのもの」と「バッチの組み方に依らないか」——
 * ここがその2つを埋める唯一の経路である。
 *
 * ⭐ **`deterministic: true` の根拠は実測である（推測ではない）。**
 * 同じ extractor に同じ3本を2回渡し、**768 成分を要素ごとに比較して不一致 0 件・
 * 最大絶対差 0**（`./fixtures/real-ruri-embeddings.json` の `provenance.determinismCheck`
 * にも同じ測定が残してある）。⟹ 決定性依存の2本も本物に対して走る。
 * ⚠ **これは「この器のこの版で測ったら一致した」であって、仕様の保証ではない。**
 * 別のハードウェア・別の dtype・別の onnxruntime で崩れたら、**崩れたことを報告すること
 * ——⛔ 契約を緩めて通さないこと**（ADR 0095 決定1 の規律）。
 *
 * ⚠ **順序の歯は、ここで初めて本物のバッチ処理に当たる。**
 * `embed([a,b])` と `embed([b,a])` は**別々のバッチ**であり、本物のモデルは padding を
 * 伴うバッチ処理をする（ADR 0090 §1.4）。⟹ 成立するかどうかは、走らせるまで分からない
 * ——だからここで走らせる。
 *
 * **CI では走らない。**`MNEMORA_LIVE_LOCAL_EMBEDDING` は `.github/workflows/ci.yml` の
 * どのジョブにも設定されていない。⟹ **CI の費用も、CI が落ちる回数も増えない。**
 * （`identifier-probes` ジョブが重みを落とすのとは別の話である。あちらは
 * `actions/cache@v6` でキャッシュされている。）
 */
describe.skipIf(!live)(
  "live: 本物のモデルに対する EmbeddingProvider 適合テスト（ADR 0095 / Issue #116）",
  () => {
    describeEmbeddingProviderConformance({
      name: "LocalEmbeddingProvider（本物のモデル）",
      // ⚠ 既定のまま。**本物の重みを落として、プロセス内で推論する。**
      // suite は `createProvider` を `it` ごとに呼ぶ契約なので、モデルのロードも `it` ごとに走る。
      createProvider: () => new LocalEmbeddingProvider(),
      deterministic: true,
      texts: {
        a: "図書館は月曜日が休館日だ",
        b: "去年の夏は記録的な猛暑だった",
        c: "この味噌汁には出汁が効いている",
      },
      // モデルのロード（初回は取得も）が入るため、vitest の既定 5 秒ではまったく足りない。
      timeout: 300_000,
    });
  },
);
