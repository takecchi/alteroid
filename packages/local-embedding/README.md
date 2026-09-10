# @mnemora/local-embedding

`EmbeddingProvider` の、**外部サービスへ繋がない**実装。
[ruri v3 30m](https://huggingface.co/cl-nagoya/ruri-v3-30m) の ONNX 変換を
[transformers.js](https://github.com/huggingface/transformers.js) で
**同じプロセスの中**で走らせる（[docs/architecture.md](../../docs/architecture.md) §5.5）。

API キーは要らない。ネットワークが要るのは**初回のモデル取得のときだけ**である。

---

## ⚠ 何が良くなって、何が良くならないか

**先に読むこと。**「ローカルに置いたから精度が上がる」ではない。

### 良くなること

| | |
|---|---|
| **外部へテキストが出ない** | 埋め込むテキストがプロセスの外に出ない。API キーも要らない |
| **課金が無い・レート制限が無い** | 件数が増えても料金は増えない。429 で止まらない |
| **日本語** | 日本語で学習されたモデルである（`text-embedding-3-small` は多言語だが日本語特化ではない） |
| **ベクトルが小さい** | 256次元。`text-embedding-3-small` の 1536 次元に対して 1/6 で、索引も小さい |
| **軽い** | 重み 36MB（q8）/ peak RSS 362MB / 4スレッドで **985 文/秒**（32コア機での実測） |

### 🔴 良くならないこと（このモデルでも解けないもの）

**埋め込みは「似ている文字列」を近くに置く道具であって、意味を理解する道具ではない。**
ローカルにしても、そこは変わらない。

- **否定が解けない。**「紅茶は飲まない」と「紅茶を飲む」は近い。
- **時制が解けない。**「引っ越した」と「引っ越す予定だ」は近い。
- **矛盾が解けない。**実測: **「コーヒーより紅茶が好き」と「紅茶よりコーヒーが好き」の
  cos は 0.996** である。**逆のことを言っている2文が、ほぼ同一と判定される。**

⟹ **「どちらが正しいか」「いつの話か」を埋め込みに決めさせないこと。**
矛盾の検出・時系列の解決は、mnemora では埋め込みではなく別の層の仕事である
（[docs/memory-model.md](../../docs/memory-model.md)）。

### 🔴 入力は 8192 トークンまで。**超えると例外になる**（黙って切らない）

**このモデルの上限は 8192 トークンである**（`tokenizer_config.json` の `model_max_length`、
`config.json` の `max_position_embeddings`。日本語の自然文では**おおよそ 18,000 字**に相当したが、
⚠ **トークン数と文字数の比は文章によって変わるので、字数は目安にしかならない**）。

**上限を超えた入力を渡すと `embed()` は例外を投げる**（[ADR 0090](../../docs/decisions/0090-embedding-input-token-limit.md)）。

```ts
import { isLocalEmbeddingProviderError } from "@mnemora/local-embedding";

try {
  await provider.embed(ctx, [veryLongText]);
} catch (error) {
  if (isLocalEmbeddingProviderError(error) && error.kind === "input_too_long") {
    // error.detail = { index, tokens, maxInputTokens, characters }
    // ⚠ 同じ入力で再試行しても永久に失敗する。分割するか短くすること。
  }
}
```

⚠ **`instanceof` ではなく `kind` で分岐すること**（bundler がクラスを二重に読み込むと
`instanceof` は落ちるが、`kind` は値なので影響を受けない）。

**なぜ例外にするか。**transformers.js は `truncation: true` で呼ぶため、
**上限を超えた入力は黙って切り捨てられ、正常な形のベクトルが返る。**
⟹ **前 8192 トークンだけを表すベクトルが「成功」として DB に入り、
悪くなったことが検索結果の質にしか現れず、原因を追えなくなる。**
落とせば `runtime.tick()` が `embeddingStatus: 'failed'` を書くので、**問い合わせられる状態が残る。**

⛔ **このパッケージは入力を自動で分割しない。**どう割るか（文境界・重ね幅・割った後の統合）は
想起の質を直接動かす設計判断であり、**呼び出し側の判断として残してある**（ADR 0090 §3.5）。

### 確かめていないこと

- **`@mnemora/openai` と比べて想起の質がどうなるか**は、このパッケージの作業では測っていない。
  上の「日本語」は**モデルカードの主張であって、この repo のゴールデンセットでの実測ではない。**
- 実測してあるのは prefix 方式の比較だけである（次節）。
- **`observe()` に渡した長いテキストが、この上限に当たる経路は開いたままである**
  （LLM 抽出が失敗すると生の全文が `embed()` へ届く。ADR 0090 §1.5）。
  **このパッケージが買ったのは「当たったことが分かる」までであり、
  「当たらないようにする」ではない。**

---

## `space` の形 — 🔴 `ruri-v3-30m/sym` の `/sym` を消さないこと

```ts
{ provider: "local", model: "ruri-v3-30m/sym", dimensions: 256 }
```

- **`provider: "local"`** — **プロセス内推論であること**を表す。将来 `packages/tei` 等が
  同じモデルを別のランタイムで動かしても、出てくるベクトルはビット一致しない。
  ⟹ 空間を分けるのが正しい。
- **`model: "ruri-v3-30m/sym"`** — `/sym` は**対称 prefix**（クエリと文書に同じ prefix を
  付ける。ruri v3 では空文字）で作られたベクトルであることを表す。

  ruri v3 は本来 `検索クエリ: ` / `検索文書: ` という**非対称**の prefix を持つモデルで、
  reranking を入れる段でそちらへ切り替える判断はありうる。
  **そのとき、非対称で作ったベクトルと対称で作ったベクトルは同じ空間の点ではない。**
  `/sym` が無ければ `EmbeddingSpaceId` が等しくなり、**両者が同じ space に混ざる**——
  混ざったことは検索結果が少し悪くなる形でしか現れず、原因を追えない。

  `/sym` を持たせておけば、切り替えた実装は `ruri-v3-30m/asym` を名乗ることになり、
  **別 space ⟹ 再インデックスが強制される。**静かに壊れる代わりに、うるさく作り直させる。

**対称 prefix を既定にした根拠（実測）**: 非対称 prefix と比べて
**ΔMRR −0.031、95%CI [−0.094, +0.031]**。信頼区間が 0 をまたいでおり、
**品質は有意に落ちていない。**

---

## インストール

```bash
pnpm add @mnemora/local-embedding @mnemora/core
# または
npm i @mnemora/local-embedding @mnemora/core
```

## 前提

- Node.js >= 22
- **ESM のみ**（`"type": "module"`）
- **初回だけネットワークが要る**（Hugging Face から重みを取得する。既定の置き場所は
  `~/.cache/huggingface`）。2回目以降はキャッシュから読む
- ネイティブ依存として `onnxruntime-node` が入る。**このリポジトリでは
  `onnxruntime-node` の postinstall を拒否している**（`pnpm-workspace.yaml` の
  `allowBuilds`）——CPU 版のバイナリは tarball に同梱済みで、postinstall がやるのは
  CUDA execution provider（302MB）の追加ダウンロードだけだからである

## 使い方

```ts
import { createRuntime } from "@mnemora/core";
import { LocalEmbeddingProvider } from "@mnemora/local-embedding";

// 既定で ruri-v3-30m/sym・256次元・q8・4スレッド。
const embeddingProvider = new LocalEmbeddingProvider();

// space は new した直後に確定している（モデルの読み込みを待たない）。
console.log(embeddingProvider.space);
// { provider: "local", model: "ruri-v3-30m/sym", dimensions: 256 }

const runtime = createRuntime({
  // ...memoryStore / vectorStore / ... は省略
  embeddingProvider,
  llmProvider,
});
```

### モデルは**最初の `embed()` まで読み込まれない**

`new` はモデルを読まない。読むのは最初の `embed()` である。
**同時に何本 `embed()` が来ても、読み込みは1回に畳まれる**——
これを畳まない素朴な実装では、8本並行で**8回読み込み、
557ms / 406MB が 3,138ms / 1,009MB になる**ことを実測している。

読み込みに失敗したら、次の `embed()` で**やり直す**
（一度の失敗でインスタンスが永久に使えなくなることは無い）。

### 先に読み込ませたいときは `warmup()`

```ts
await embeddingProvider.warmup(); // 最初のリクエストにロード時間を被せない
```

⚠ **`embed(ctx, [])` ではウォームアップできない**——空配列は `[]` を即返し、
モデルを起こさない（`@mnemora/openai` と同じ）。だから `warmup()` が別に在る。

⚠ `warmup()` が済ませるのは**モデルの読み込みだけ**である。推論は一度も走らせない
（初回推論のグラフ確保ぶんは残る）。ウォームアップのつもりで
モデルへ勝手な入力を流さないため、意図してそうしてある。

### オプション

| オプション | 既定 | |
|---|---|---|
| `repo` | `"sirasagi62/ruri-v3-30m-ONNX"` | Hugging Face の repo id |
| `dtype` | `"q8"` | 量子化の別 |
| `dimensions` | `256` | **宣言する**次元数。実物と食い違えば初回 `embed()` で例外になる |
| `modelId` | `"ruri-v3-30m/sym"` | `space.model` に載る文字列 |
| `prefix` | `""` | 全テキストの先頭に付ける文字列 |
| `cacheDir` | 未指定（`~/.cache/huggingface`） | モデルの置き場所 |
| `numThreads` | `4` | onnxruntime の intra-op スレッド数 |
| `createPipeline` | transformers.js | モデルを読み込む関数（**テスト用の注入点**） |

**`numThreads` の既定が 4 なのは実測による**——32コア機で、既定（コア数まかせ）の
819 文/秒 に対し 4スレッドで **985 文/秒**だった。**増やすほど速くなるわけではない。**

### 🔴 `prefix` は1本の文字列である（クエリ用と文書用に分けられない）

これは意図した制限である。`EmbeddingProvider.embed(ctx, texts)` は、
**渡されたテキストがクエリなのか文書なのかを知らない。**
そしてそれを知っている呼び出し口（`recall-runtime.ts` / `runtime.ts`）は、
この interface 越しにしか provider を触らない。

⟹ 非対称 prefix を**表現できる型**（`{ query, document }`）にすると、
「設定できるのに、どちらが使われるかは呼ばれ方次第」という、
**設定した人が裏切られる形**になる。型のほうで対称性を強制して、それを起こせなくしてある。

**`prefix` を変えたら `modelId` も変えること**——変えないと、別の prefix で作った
ベクトルが同じ space に混ざる。

---

## モデルが取得できなくなったら（再変換の手順）

**このパッケージが読み込みに失敗したときの例外は、この節を指している。**

既定の `repo`（`sirasagi62/ruri-v3-30m-ONNX`）は**個人の変換 repo** である。
消える可能性は承知のうえで選んでいる。**成り立っている前提は、
「元モデルが公式で、変換を自分でやり直せる」ことである。**

| | |
|---|---|
| 元モデル | **`cl-nagoya/ruri-v3-30m`**（ライセンス **apache-2.0**） |
| 揃えるべき条件 | **dtype `q8` / mean pooling / L2 normalize / 256次元** |

pooling は ruri v3 の `1_Pooling/config.json` が mean pooling であることを確認した値である。
**pooling や正規化を変えると、出てくるベクトルは別物になる**——
そのときは `modelId` も変えて別 space にすること（`/sym` の節と同じ理由）。

### 変換（Optimum の CLI を使う想定）

```bash
pip install "optimum[onnxruntime]"

# 1. ONNX へ書き出す
optimum-cli export onnx \
  --model cl-nagoya/ruri-v3-30m \
  --task feature-extraction \
  ./ruri-v3-30m-onnx

# 2. q8（動的量子化）を作る。transformers.js は dtype="q8" のとき
#    onnx/model_quantized.onnx を探す
optimum-cli onnxruntime quantize \
  --onnx_model ./ruri-v3-30m-onnx \
  --avx512 \
  -o ./ruri-v3-30m-onnx-q8
```

⚠ **上のコマンド列は、この作業では実行していない**（Python 環境を用意していない）。
Optimum の文書から書いたものであり、**動くことを確かめていない。**
オプション名や出力ファイル名は Optimum の版で変わりうる。
確かなのは表の側——**元モデルの識別子・ライセンス・揃えるべき条件**である。

⛔ **重みをこのリポジトリへ持ち込まないこと**（オーナーの判断）。手順だけを置く。

### 変換したものをどこに置けば拾われるか

**確かめた経路**（このパッケージのコードとして成立している）:

```ts
// 自分の Hugging Face repo へ push して、その id を指す。
new LocalEmbeddingProvider({ repo: "your-org/ruri-v3-30m-ONNX" });

// 置き場所（キャッシュ）を移すだけならこちら。
new LocalEmbeddingProvider({ cacheDir: "/var/lib/mnemora/models" });
```

`repo` と `cacheDir` が `createPipeline` へそのまま渡ることは
`src/__tests__/local-embedding-provider.test.ts` で検査している。

#### ネットワークに一切出ずに、手元のファイルだけで動かす

🔴 **`repo` に絶対パスは渡せない。**transformers.js はモデル id を
`env.localModelPath` からの**相対**で解決するので、`repo` に渡すのは
「そのディレクトリの下のフォルダ名」である。⟹ **`env` を触る必要があり、
それは `createPipeline` を差す仕事になる**（このパッケージが `env` を
勝手に書き換えないのは、`env` がプロセス全体で共有される大域だからである）。

**この形が実際に動くことは確かめた**（2026-09-10T00:37Z にこの器で実行）:

```ts
import { LocalEmbeddingProvider, toVectors } from "@mnemora/local-embedding";

// 再変換した重みを /var/lib/mnemora/models/my-ruri へ置いた、という想定。
// （config.json / tokenizer.json / tokenizer_config.json / onnx/model_quantized.onnx）
const createPipeline = async (spec) => {
  const { env, pipeline } = await import("@huggingface/transformers");
  env.localModelPath = "/var/lib/mnemora/models";
  env.allowRemoteModels = false; // ⭐ ネットワークへ出ない
  const extractor = await pipeline("feature-extraction", spec.repo, {
    dtype: spec.dtype,
    session_options: { intraOpNumThreads: spec.numThreads, interOpNumThreads: 1 },
  });
  return async (texts) => toVectors(await extractor(texts, { pooling: "mean", normalize: true }));
};

const provider = new LocalEmbeddingProvider({ repo: "my-ruri", createPipeline });
```

**確かめたこと**: この形で 256 次元のベクトルが返り、
「今日は雨が降っている」と「本日は雨天である」の cos が **0.9482** になった。
`dimensions: 999` を宣言すると**この経路でも次元検査が発火する**ことも確認した
（＝ `createPipeline` を差しても、このパッケージの歯は素通しにならない）。

⚠ **確かめていないこと**: 上の `optimum-cli` の実行（Python 環境を用意していない）。
確かめたのは「**変換済みの重みがディレクトリに在るとき、そこから読めるか**」までである。

---

## テスト

- `src/__tests__/local-embedding-provider.test.ts` / `to-vectors.test.ts` —
  **`createPipeline` を注入して、本物のモデルを落とさずに走る。**CI で必ず走る。
  遅延ロードを1回に畳むこと・失敗後に再試行できること・次元と件数の検査・
  prefix の適用・`warmup()` を測る。
- `src/__tests__/input-token-limit.test.ts` — **擬似の extractor を注入して、
  上限の受け取りと超過の名乗り方を測る。**CI で必ず走る（ADR 0090）。
  ⚠ **ここでは `8192` という数字は測っていない**——それはモデルが持つ事実であり、
  下の live テストが固定する。
- `src/__tests__/embedding-space-name-budget.test.ts` — **`EmbeddingSpaceId` から導かれる
  Postgres のテーブル名・HNSW 索引名が、切り詰められずに 63 バイトに収まること**を、
  `@mnemora/postgres` の導出関数を import して測る。CI で必ず走る（ADR 0090 §4）。
- `src/__tests__/live.local-embedding.test.ts` — **本物のモデルを落として推論する。**
  `MNEMORA_LIVE_LOCAL_EMBEDDING` が空でない値のときだけ走る（既定では `skipped` と表示される）。

  ```bash
  MNEMORA_LIVE_LOCAL_EMBEDDING=1 pnpm --filter @mnemora/local-embedding test
  ```

  ⚠ opt-in を要求する理由は課金ではない（外部サービスへ繋がないので料金は発生しない）。
  **36MB のダウンロードと peak RSS 362MB の推論が、`pnpm run test` を1回打っただけで
  走ってしまう**からである。

## もっと詳しく

- [docs/architecture.md](../../docs/architecture.md) §5.5 — `EmbeddingProvider` の契約
- リポジトリ: https://github.com/takecchi/mnemora
