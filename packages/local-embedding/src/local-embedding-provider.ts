import type { Ctx, EmbeddingProvider, EmbeddingSpaceId } from "@mnemora/core";
import type {
  CreateLocalEmbeddingPipeline,
  LocalEmbeddingDtype,
  LocalEmbeddingModelSpec,
  LocalEmbeddingPipeline,
} from "./pipeline.js";
import { createLocalEmbeddingPipeline } from "./pipeline.js";
import { isLocalEmbeddingProviderError } from "./errors.js";

/**
 * `EmbeddingProvider` の**プロセス内**実装（外部サービスへ繋がない）。
 *
 * 契約は `packages/core/src/interfaces/embedding-provider.ts` のまま——
 * 1インスタンス = 1 `EmbeddingSpaceId` に固定し、次元をモデルに応じて動的に変えない。
 * このクラスはその契約に**実行時の歯**を1本足す（`embed()` の次元検査。下記）。
 */

/** `space.provider`。**プロセス内推論であること**を表す。 */
export const LOCAL_EMBEDDING_PROVIDER_ID = "local";

/** 既定の Hugging Face repo（ONNX 変換済みの ruri v3 30m）。 */
export const DEFAULT_LOCAL_EMBEDDING_REPO = "sirasagi62/ruri-v3-30m-ONNX";

/** 既定の dtype。重み 36MB / peak RSS 362MB はこの値での実測である。 */
export const DEFAULT_LOCAL_EMBEDDING_DTYPE: LocalEmbeddingDtype = "q8";

/** 既定の次元数。 */
export const DEFAULT_LOCAL_EMBEDDING_DIMENSIONS = 256;

/**
 * 既定の `space.model`。
 *
 * 🔴 **`/sym` を消さないこと。これは飾りではなく、再インデックスの引き金である。**
 *
 * `/sym` は「**対称 prefix**（クエリと文書に同じ prefix を付ける。ruri v3 では空文字）で
 * 作られたベクトルである」ことを表す。ruri v3 は本来
 * `検索クエリ: ` / `検索文書: ` という**非対称**の prefix を持つモデルであり、
 * reranking を入れる段でそちらへ切り替える判断はありうる。
 *
 * **そのとき、非対称 prefix で作ったベクトルと、いまの対称 prefix で作ったベクトルは
 * 同じ空間の点ではない。**`space.model` が同じままだと、`EmbeddingSpaceId` は
 * `(provider, model, dimensions)` で等しくなり、**両者が同じ space のテーブルに混ざる。**
 * 混ざったことは検索結果が少し悪くなる形でしか現れず、原因を追えない。
 *
 * `/sym` を持たせておけば、prefix 方式を変えた実装は `ruri-v3-30m/asym` のような
 * 別の `space.model` を名乗ることになり、**別 space になる ⟹ 再インデックスが強制される。**
 * 静かに壊れる代わりに、うるさく作り直させる。
 */
export const DEFAULT_LOCAL_EMBEDDING_MODEL_ID = "ruri-v3-30m/sym";

/**
 * 既定の prefix。**ruri v3 の対称 prefix は空文字である。**
 *
 * 実測: 対称 prefix（空文字）に落としても品質は有意に落ちない
 * （ΔMRR −0.031、95%CI [−0.094, +0.031] ——0 を含む）。
 */
export const DEFAULT_LOCAL_EMBEDDING_PREFIX = "";

/**
 * 既定の onnxruntime intra-op スレッド数。
 *
 * 32コア機での実測で、**既定（コア数まかせ）より速かった**: 985 文/秒 対 819 文/秒。
 * 埋め込みは他の仕事と同居するので、コア数だけスレッドを立てても
 * オーバーサブスクリプションで損をする。
 */
export const DEFAULT_LOCAL_EMBEDDING_NUM_THREADS = 4;

export interface LocalEmbeddingProviderOptions {
  /** Hugging Face の repo id。既定 `sirasagi62/ruri-v3-30m-ONNX`。 */
  repo?: string;
  /** 量子化の別。既定 `"q8"`。 */
  dtype?: LocalEmbeddingDtype;
  /** 宣言する次元数。既定 `256`。**実物と食い違えば初回 `embed()` で例外になる。** */
  dimensions?: number;
  /**
   * `space.model` に載せる文字列。既定 `"ruri-v3-30m/sym"`。
   * **prefix 方式を変えるなら、ここも変えること**（`DEFAULT_LOCAL_EMBEDDING_MODEL_ID` の説明）。
   */
  modelId?: string;
  /**
   * 全テキストの先頭に付ける文字列。既定は `""`。
   *
   * 🔴 **ここが「1本の文字列」なのは意図的である。クエリ用と文書用を分けられる形
   * （`{ query, document }`）にしてはならない。**
   *
   * 理由: `EmbeddingProvider.embed(ctx, texts)` は、渡されたテキストが**クエリなのか
   * 文書なのかを知らない。**そして、それを知っている呼び出し口
   * （`packages/core/src/recall-runtime.ts` / `runtime.ts`）は
   * この interface 越しにしか provider を触れない。
   * ⟹ 非対称 prefix を**表現できる型**にすると、「設定できるのに、どちらの prefix が
   * 使われるかは呼ばれ方次第」という、**設定した人が裏切られる形**になる。
   * 型のほうで対称性を強制して、その裏切りを起こせなくしてある。
   *
   * 非対称 prefix が本当に要るようになったら、それは `EmbeddingProvider` の契約を
   * 変える話であって、このオプションの形を変える話ではない。
   */
  prefix?: string;
  /** モデルファイルの置き場所。未指定なら transformers.js の既定。 */
  cacheDir?: string;
  /** onnxruntime の intra-op スレッド数。既定 `4`。 */
  numThreads?: number;
  /**
   * モデルを読み込む関数。**テストで本物のモデルを落とさないための注入点である**
   * （`packages/openai` の `client` と同じ役目）。未指定なら transformers.js を使う。
   */
  createPipeline?: CreateLocalEmbeddingPipeline;
}

export class LocalEmbeddingProvider implements EmbeddingProvider {
  /**
   * ⭐ **コンストラクタで同期に確定し、凍結する。**
   *
   * モデルの読み込み（`pipeline()`）は非同期だが、**`space` の確定はそれを待たない。**
   * `space` は `(provider, model, dimensions)` という**宣言**であり、モデルから
   * 読み取った値ではない。⟹ `new` した直後に `provider.space` を読んで
   * ベクトル空間のテーブルを用意する呼び出し側が、そのまま動く。
   *
   * 凍結するのは、`EmbeddingSpaceId` がテーブル名スラグの導出元
   * （`docs/memory-model.md`）だからである。**走っている途中で書き換えられると、
   * 同じインスタンスが2つの space へ書く。**
   */
  readonly space: EmbeddingSpaceId;

  readonly #spec: LocalEmbeddingModelSpec;
  readonly #prefix: string;
  readonly #createPipeline: CreateLocalEmbeddingPipeline;

  /**
   * ⭐ **読み込み中／読み込み済みの Promise そのものを握る**（`LocalEmbeddingPipeline` ではなく）。
   *
   * **なぜ Promise を握るか（実測で踏んだ穴）**: 「読み込み済みの pipeline」だけを持って
   * `if (this.#pipeline) ... else await load()` と書くと、**同時に来た `embed()` が
   * 全員 `else` に入り、全員が別々にモデルを読み込む。**8本並行で 8回読み込み、
   * 557ms / 406MB が **3,138ms / 1,009MB** になることを実測している。
   * Promise を握れば、2本目以降は同じ Promise を await するだけになる。
   *
   * 失敗したら `null` へ戻す——**失敗した Promise を握り続けると、
   * 一度の一時的な失敗が、そのインスタンスを永久に使えなくする。**
   */
  #ready: Promise<LocalEmbeddingPipeline> | null = null;

  constructor(options: LocalEmbeddingProviderOptions = {}) {
    this.#spec = Object.freeze({
      repo: options.repo ?? DEFAULT_LOCAL_EMBEDDING_REPO,
      dtype: options.dtype ?? DEFAULT_LOCAL_EMBEDDING_DTYPE,
      cacheDir: options.cacheDir,
      numThreads: options.numThreads ?? DEFAULT_LOCAL_EMBEDDING_NUM_THREADS,
    });
    this.#prefix = options.prefix ?? DEFAULT_LOCAL_EMBEDDING_PREFIX;
    this.#createPipeline = options.createPipeline ?? createLocalEmbeddingPipeline;
    this.space = Object.freeze({
      provider: LOCAL_EMBEDDING_PROVIDER_ID,
      model: options.modelId ?? DEFAULT_LOCAL_EMBEDDING_MODEL_ID,
      dimensions: options.dimensions ?? DEFAULT_LOCAL_EMBEDDING_DIMENSIONS,
    });
  }

  /**
   * モデルを先に読み込んでおく。**契約（`EmbeddingProvider`）には無い追加のメソッドである。**
   *
   * **なぜ要るか**: `embed(ctx, [])` は `[]` を即返すので（`packages/openai` と同じ）、
   * **空配列ではウォームアップできない。**かといってウォームアップのために
   * 意味の無い文字列を1件埋め込ませるのは、呼び出し側に「どんな文字列なら安全か」を
   * 考えさせる。ここに名前を付けておけば、最初の実リクエストが
   * 557ms のロードを被る形を避けられる。
   *
   * ⚠ **これはモデルの読み込みだけを済ませる。**推論そのものは一度も走らせない
   * （初回推論のグラフ確保ぶんは残る）。ここで適当な文字列を1件通すことも考えたが、
   * **「ウォームアップしただけのつもりが、モデルへ勝手な入力が流れる」**ほうが
   * 説明しづらいと判断した。
   */
  async warmup(): Promise<void> {
    await this.#load();
  }

  async embed(_ctx: Ctx, texts: string[]): Promise<number[][]> {
    // `packages/openai` と同じ早期 return。**空でモデルを起こさない。**
    // ⟹ ウォームアップは `warmup()` を使うこと。
    if (texts.length === 0) {
      return [];
    }

    const pipeline = await this.#load();

    // ⭐ **prefix が空でも、必ず新しい配列を作る**（`this.#prefix === "" ? texts : ...` と
    // 分岐して素通しにしない）。
    //
    // **なぜ**: 素通しにすると、**呼び出し側が渡した配列そのものが `createPipeline` の
    // 先へ渡る。**注入された pipeline がそれを書き換えると、呼び出し側の配列が変わる。
    // 実際に、書き換える pipeline を注入して確かめた——**既定（prefix が空）でだけ
    // 呼び出し側の配列が壊れ、prefix を設定したときは壊れなかった。**
    // ⟹ **振る舞いが設定に依存して変わり、しかも壊れるほうが既定だった。**
    //
    // 分岐を消して、経路を1本にしてある。`"" + text` は元の文字列そのものなので、
    // 増えるのは配列1本の確保だけで、その費用は推論の前では見えない。
    const prefixed = texts.map((text) => this.#prefix + text);
    const vectors = await pipeline(prefixed);

    // ⭐ 件数の一致だけは確かめる。
    //
    // `packages/openai` は応答の `index` で並べ直して「順序は保たれる」という前提を
    // 作らないようにしている。ここには `index` に当たるものが無いので、順序までは
    // 確かめようがない——**確かめられるもの（件数）だけを確かめ、確かめていないことは
    // 確かめていないと書く。**件数が合っていないベクトルを黙って返すと、
    // 呼び出し側で memory とベクトルが1つずれて対応する。
    if (vectors.length !== texts.length) {
      throw new Error(
        `LocalEmbeddingProvider: ${texts.length} 件のテキストに対して ` +
          `${vectors.length} 件のベクトルが返った（${this.#spec.repo}）`,
      );
    }

    // ⭐ 宣言した次元と実物の食い違いを、ここで落とす。
    //
    // `interfaces/embedding-provider.ts` の「次元をモデルに応じて動的に変える実装は
    // 許容しない」を**実行時に守らせる歯**である。repo を差し替えた・dtype を変えたら
    // 次元が違った、を**黙って通すと、宣言と中身が食い違ったまま DB へ入る**
    // （`EmbeddingSpaceId` はテーブル名スラグの導出元なので、後から気づいても
    // 混ざったものは分けられない）。
    for (const [index, vector] of vectors.entries()) {
      if (vector.length !== this.space.dimensions) {
        throw new Error(
          `LocalEmbeddingProvider: 宣言した次元数 ${this.space.dimensions} に対して、` +
            `モデル（${this.#spec.repo} / dtype=${this.#spec.dtype}）が返したベクトルは ` +
            `${vector.length} 次元だった（${index} 番目）。` +
            `options.dimensions を実物に合わせるか、repo を見直すこと`,
        );
      }
    }

    return vectors;
  }

  /**
   * 読み込みを1回に畳む。**同期の関数である**（`async` にしない）——
   * `#ready` の確認と代入の間に await が入ると、そこが競合の窓になる。
   */
  #load(): Promise<LocalEmbeddingPipeline> {
    const existing = this.#ready;
    if (existing !== null) {
      return existing;
    }
    const pending = this.#startLoad();
    this.#ready = pending;
    // 失敗した Promise を握り続けない。**自分が入れたものだけを消す**——
    // 失敗が返ってくる頃に別の読み込みが始まっていたら、そちらを巻き添えにしない。
    pending.catch(() => {
      if (this.#ready === pending) {
        this.#ready = null;
      }
    });
    return pending;
  }

  /**
   * `createPipeline` を呼ぶ薄い層。2つのことをする。
   *
   * 1. **同期の throw を reject に均す**（`async` 関数なのでこれは自動で起きる）。
   * 2. **失敗を包んで、次に何ができるかを一緒に投げる**（下記）。
   */
  async #startLoad(): Promise<LocalEmbeddingPipeline> {
    try {
      return await this.#createPipeline(this.#spec);
    } catch (error) {
      // 🔴 **種類の付いた失敗は包まない**（ADR 0090）。
      //
      // `describeLoadFailure` が足す文面は「**repo が消えたなら再変換できる**」という
      // 助言である。**それは `unknown_input_limit` に対しては嘘の助言になる**
      // ——repo は取得できているし、再変換しても上限は宣言されない。
      // ⟹ 包むと、原因の種類が「モデルが落ちてこなかった」に潰れる。
      // **包むのは、種類が分かっていない失敗だけにする。**
      if (isLocalEmbeddingProviderError(error)) {
        throw error;
      }
      throw new Error(describeLoadFailure(this.#spec), { cause: error });
    }
  }
}

/**
 * モデルの読み込みに失敗したときのメッセージを組み立てる。
 *
 * 🔴 **なぜ素の例外をそのまま投げないか。**
 *
 * 既定の repo（`sirasagi62/ruri-v3-30m-ONNX`）は**個人の変換 repo** であり、
 * **消えうる**。それを承知でこのモデルを選べているのは、
 * **元モデルが公式（`cl-nagoya/ruri-v3-30m`, apache-2.0）で、ONNX 変換を
 * 自分でやり直せる**からである。
 *
 * ⟹ **その「やり直せる」が、必要になった人に届かなければ、選択の前提が成立しない。**
 * そして届く先は doc ではない——repo が消えた人が最初に見るのは、
 * transformers.js が投げる素の 404 である。**だからここに書く。**
 *
 * ⚠ **元の例外は `cause` に必ず残す。**ネットワーク断・repo 消滅・dtype 名の間違いは
 * 別の問題であり、包んだ文面だけになると区別が付かなくなる。
 * ここで足しているのは「次に何ができるか」だけで、**何が起きたかは cause の側にある。**
 */
function describeLoadFailure(spec: LocalEmbeddingModelSpec): string {
  const where =
    spec.cacheDir !== undefined ? `cacheDir=${spec.cacheDir}` : "cacheDir=未指定（既定の場所）";
  return (
    `LocalEmbeddingProvider: モデルを読み込めなかった` +
    `（repo=${spec.repo} / dtype=${spec.dtype} / ${where}）。` +
    `原因は cause を見ること——ネットワーク断・repo の消滅・dtype 名の誤りは別の問題である。` +
    ` repo が取得できなくなっている場合: 元モデルは公式の cl-nagoya/ruri-v3-30m（apache-2.0）` +
    `であり、ONNX への変換は自分でやり直せる。変換したものは options.repo に指すことで使える` +
    `（別の変換先でも、自分で変換したものでもよい）。` +
    ` 手順は @mnemora/local-embedding の README「モデルが取得できなくなったら（再変換の手順）」にある`
  );
}
