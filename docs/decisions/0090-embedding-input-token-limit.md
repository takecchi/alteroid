# ADR 0090: 埋め込みの入力が上限を超えたことを名乗る — 8192 トークンの壁と、導かれる識別子の余裕

- **状態**: 採用 (2026-09)
- **日付**: 2026-09-10

**⚠ 各主張の出所を分ける。**「【実測】」と書いたものは**この作業でこの器から実行して取った**ものである。
「【実測・委】」は**委譲先の作業者が測り、書き手が受け取った**もの。
「【受領】」は**オーナーから前提として渡され、この作業では裏を取っていない**もの。

---

## 問い（2つ）

`packages/local-embedding`（ADR 0085）について、誰も測っていなかった2点を測る。

1. **入力はどこで切り捨てられ、そのとき何か言うのか。**
2. **この provider の `EmbeddingSpaceId` から導かれる Postgres の識別子は、63 バイトに収まるのか。**

**⟹ どちらも、渡された前提が現物では成り立たなかった。**その訂正がこの ADR の中身の半分である。

---

## 1. 渡された前提と、現物

### 1.1 【受領】前提

> 別モデル（`Xenova/paraphrase-multilingual-MiniLM-L12-v2`）の実測では、
> **日本語で 800〜1200 字の間で切られ、エラーが出ない**（1200 字と 2700 字のベクトルが
> `cos=1.00000012` で一致）。**OpenAI の上限は 8191 トークン**なので、
> 契約に書かれていない振る舞いの差である。

### 1.2 🔴 【実測】`ruri-v3-30m` では再現しない。壁は 8192 トークンである

`sirasagi62/ruri-v3-30m-ONNX` の宣言値を、この器から直接取得した（どちらも `HTTP 200`）:

| ファイル | 欄 | 値 |
|---|---|---|
| `tokenizer_config.json` | `model_max_length` | **8192** |
| `config.json` | `max_position_embeddings` | **8192** |
| `config.json` | `hidden_size` | 256 |

**【実測・委】隣り合う長さのベクトルの cos は、400 / 800 / 1200 / 2000 / 4000 / 8000 / 16000 字の
どの区間でも 1.0 に張り付かなかった**（0.976〜0.995）。
**張り付き始めたのは 18,442 字から**で、そこから 30,000 字まで
`cos = 1.0000000000000002`（浮動小数点誤差の範囲で 1.0）で完全に一致した。
トークナイザを直接呼んだ二分探索では **18,441 字 = 8192 トークン / 18,442 字 = 8193 トークン**。

⟹ **800〜1200 字は、このモデルでは 1 桁半外れている。**

🔴 **【実測】そして「字数」は前提にできない。**
本 PR の live テストは、かな 46 文字を巡回させた文字列でトークン数を二分探索している。
そちらでは **8192 トークン = 10,469 字 / 8193 トークン = 10,470 字**だった。
**同じ 8192 トークンが、合成文では 18,441 字、かな巡回では 10,469 字である**
（比が 0.444 対 0.783 トークン/字）。
⟹ ⛔ **字数で上限を語らないこと。判定に使えるのはトークン数だけである。**
（⚠ 単純な 1 文字の繰り返しはさらに外れる——**`"あ".repeat(100)` は 15 トークンにしかならない。**
BPE が同じ文字の連続を大きな塊トークンへ圧縮するためで、
**繰り返し文字列で測ると切り捨て点を測り損なう。**）

**【実測】そして、切り捨ては実際に「後ろが一切効かない」形で起きる。**
`model_max_length` の申告だけを巨大な値へ差し替えて本 PR の検査を外し、
**共有の前半 8,300 トークン ＋ 末尾 200 字だけが違う 2 本**を埋め込むと、
**`cos = 1.0000000000000002`**（浮動小数点誤差の範囲で 1.0）になった。
⟹ **末尾 200 字はベクトルに一切効いていない。**
同じ 2 本を、差し替えていない pipeline へ渡すと `kind: "input_too_long"` で落ちる。
**穴と、それを塞ぐ歯が、同じ live テストの中で対になっている。**

### 1.3 🔴 【実測】そして「OpenAI との差」は、上限の値ではなかった

**8192 > 8191。**⟹ **`ruri-v3-30m` の上限は OpenAI より 1 トークン広い。**
【受領】の「契約に書かれていない振る舞いの差」は、**上限の値の話としては成立しない。**

⚠ **成立するのは、上限に当たったときの振る舞いの差である。**
【受領】OpenAI は上限超過を**サーバが拒否する**（この作業では実 API を叩いておらず、
**裏を取っていない**）。一方 `packages/local-embedding` は**黙って切って、正常な顔のベクトルを返す。**

⟹ **問題は「上限が狭い」ではなく「上限に当たったことが分からない」である。**
本 ADR が塞ぐのはこちらだけである。

### 1.4 【実測】誰が切っているのか — 実装ではなく、ライブラリの呼び方

`packages/local-embedding/src/` に**長さの処理は 1 行も無い**（prefix 付与・件数検査・次元検査だけ）。
切っているのは `@huggingface/transformers@4.2.0` である。**該当箇所を逐語で読んだ**:

| 場所 | 何をしているか |
|---|---|
| `src/pipelines/feature-extraction.js:89-92` | `this.tokenizer(texts, { padding: true, truncation: true })` ——**`max_length` を渡さず、`truncation: true` を常に渡す** |
| `src/tokenization_utils.js:405` | `max_length === null` なら `max_length = this.model_max_length` |
| `src/tokenization_utils.js:428` | `max_length = Math.min(max_length, this.model_max_length ?? Infinity)` |
| `src/tokenization_utils.js:438` | `truncateHelper(encodedTokens[i], max_length)` |
| `src/tokenization_utils.js:121-127` | `truncateHelper` は `item[key].length = length` ——**配列をその場で切るだけ。戻り値も、ログも、警告も無い** |
| `src/tokenization_utils.js:436` | 切るのは `input_ids.length > max_length` のとき ——⭐ **上限ちょうどは切られない** |
| `src/tokenization_utils.js:323-324` | `get model_max_length()` は `this._tokenizerConfig.model_max_length ?? Infinity` |

**【実測・委】stdout / stderr にライブラリ由来の出力は 0 件。**
返り値は `vectors.length === texts.length` かつ 256 次元を満たす、**正常な形のベクトルである。**
既存の件数検査・次元検査は、どちらも**切り捨てを検出できる種類の検査ではない。**

### 1.5 🔴 【実測】「いま噛まない」は、カセットについては真で、コードについては偽

**【実測・委】現物のカセットは噛まない。**
`examples/chat/cassettes/retrieval.json` は 152 件・平均 22.36 字・最長 38 字
（【受領】の「平均22.4字・最長38字」と一致した）。
`compare.json` は 68 件・平均 15.49 字・最長 31 字（**こちらは別分布であり、
【受領】の数字は `retrieval.json` 限定のものだった**）。**壁から 2 桁以上下である。**

⚠ **しかしそれは固定のカセットの話であって、経路の話ではない。**
**【実測】`observe()` に渡した生テキストが、一切切られずに 1 本の文字列として
`embed()` へ渡る経路が在る。**連鎖を逐語で確かめた:

1. `packages/core/src/observation.ts:122-131` — `ObserveDocumentInputSchema.content` は
   `z.string().min(1)`。**`.max()` が無い。**（`ObserveUtteranceInputSchema.text` も同じ）
2. `packages/core/src/extraction.ts:206-217` — `completeStructured` が例外を投げた `catch` で
   `fallbackWholeObservationCandidate(observation)` を返す。
3. `packages/core/src/extraction.ts:123-129` — その `content` は
   `observationPayloadText(observation)` = `payload.text` / `payload.content` **無加工**
   （`extraction.ts:42-57`）。
4. `packages/core/src/runtime.ts:1011` — `processEmbedJob` が `memory.content` を
   **そのまま** `embed(ctx, [memory.content])` に渡す。

⟹ **`observe({ kind: 'document', content: <18,000 字超> })` ＋ LLM 抽出の失敗**で、
**生の全文が壁を越え、黙って切られる。**`document` は仕様上の入力種であり、長さ上限は無い。

**【実測・委】他に長さの上限は、この経路のどこにも無い**
（`DEFAULT_DIGEST_FALLBACK_LENGTH = 200` は `digest` にしか効かない。
`DIGEST_BAND_MAX_CHARS = 4000` / `DIGEST_BAND_MAX_ENTRY_CHARS = 120` /
`RecallBudget.*` はすべて **`recall()` の出力側**の予算であり、`embed()` の入力には効かない）。
**`docs/recall.md` §6「焼かれる量の計測と予算」に、入力長の記述は無い。**

**【実測・委】`Runtime.consolidate()`（ADR 0089）も上限を持たない。**
`strategies/consolidate.ts:16` の `content` は `z.string().min(1)` のみ、
`consolidate.ts:108` は LLM 出力をそのまま格納する。統合対象の選定（`runtime.ts:1234-1288`）は
`status === 'active'` だけを見るので、**以前の統合結果が次の統合の対象に再び入りうる**。
プロンプトは「矛盾する内容がある場合はどちらも書き残してください」（`consolidate.ts:34`）——
**縮める指示ではない。**⟹ **反復で `content` が縮む保証はコードに無い**
（⚠ **実際に単調増加することは測っていない**）。

⟹ **【受領】の「いまは噛まない見込み」は、⛔「保証」としては書けない。**
**噛まないのは標本の側であり、経路は開いている。**

---

## 2. 決定

### 決定1: 上限を超えた入力は、**例外にする**（黙って切らせない）

`kind: "input_too_long"` を持つ `LocalEmbeddingProviderError` を投げる。
検査は **推論の前**に行う（超過が確定している入力に 36MB のモデルを回す費用を払わせない）。
境界は **`>`** ——`tokenization_utils.js:436` と揃える。**上限ちょうどは拒否しない。**

**なぜ例外か。**
- **ADR 0075 が同じ形を LLM 側で既に決めている**（`finish_reason === "length"` を
  `kind: "truncated"` の例外にした）。**打ち切りを「空の成功」にしない**という同じ固定点である。
- `embed()` の戻りは `number[][]` であり、**`Omission` 相当を返す余地が型に無い。**
  そこを作るには `EmbeddingProvider` の契約（`packages/core`）を変えることになる
  ——ADR 0085 決定2 が「契約を変えない」を選んだ線を、本 ADR で崩さない。
- **例外は「黙る」の反対側に、名前の付いた状態として着地する。**
  `runtime.ts:1017-1020` の `processEmbedJob` は `catch` で
  `setEmbeddingStatus(ctx, memory.id, "failed")` を書いてから再送出する
  （コメント自身が「索引の遅れ・失敗を黙って無かったことにしない」と言っている）。
  ⟹ **`embeddingStatus: 'failed'` という、問い合わせられる状態が残る。**
- ⚠ **代償を隠さない**: その Memory はベクトルで引けなくなる。
  **しかし「引けない」は語彙チャンネル（ADR 0084）と `embeddingStatus` から見える。**
  黙って切った場合に残るのは、**前 8192 トークンだけを表す、正しい顔をしたベクトル**であり、
  **悪くなったことが検索結果の質にしか現れず、原因を追えない。**
  ⟹ **うるさく落ちるほうを採る**（ADR 0085 決定3 と同じ選び方）。

### 決定2: 上限が**宣言されていない**ことを、「上限が無い」と読まない

`tokenization_utils.js:323-324` のとおり、宣言が無いと `model_max_length` は **`Infinity`** になる。
**`Infinity` を素通しにすると、切り捨ては再び黙る。**
⟹ 有限の正の整数でなければ、**pipeline の組み立て自体を失敗させる**
（`kind: "unknown_input_limit"`）。

**逃げ道は既に在るものを使う**——`options.createPipeline` で pipeline を注入する
（ADR 0085 負債3 の「オフライン導入は『できない』のではなく『注入点を使う』である」と同じ形）。

### 決定3: 🔴 検査を**純関数に切り出して**、CI から測れる場所へ置く

上限の判定に必要な知識（`model_max_length` と、切り詰めない符号化）は
**トークナイザだけが持っており、トークナイザは本物のモデルを落とさないと触れない場所に居る。**
⟹ そこへ検査を書くと、**検査が CI から測れず、歯にならない**
（`pipeline.ts` のヘッダ自身が「`createLocalEmbeddingPipeline` はユニットテストで測っていない」と
書いていた）。

だから「**extractor を受け取って pipeline を組み立てる**」ところだけを
新しい公開の純関数 `buildLocalEmbeddingPipeline(extractor)` に切り出し、
**擬似の extractor を注入して CI から測る。**
残る未測定は「`pipeline("feature-extraction", …)` が返すものが本当にこの形をしているか」だけで、
**cast は 1 箇所に閉じてあり**、形が違えば live テストが落ちる。

### 決定4: ⛔ **公開 API を壊さない。**壊す案は提起までにする

**採らなかった案**（下記 3.1）は `LocalEmbeddingPipeline` を
`{ maxInputTokens, countTokens, embed }` の**必須 interface** に変えるものだった。
そちらのほうが強い——**注入された pipeline にも上限の宣言を強制できる**。

⛔ **`docs/autonomy.md` §3 は「公開 API の破壊的変更」を
「ADR を書き、実装は別 PR にして、承認を待つ」と定めている。**
`LocalEmbeddingPipeline` / `CreateLocalEmbeddingPipeline` は `src/index.ts` から公開されている。
⟹ **本 PR では壊さない。**§5 の負債1 に、**オーナーへの提起として**残す。

### 決定5: 種類の付いた失敗は、読み込み失敗の文面で**包まない**

`#startLoad` は `createPipeline` の失敗を
`describeLoadFailure`（「repo が消えたなら再変換できる」という助言）で包んでいた。
**それは `unknown_input_limit` に対しては嘘の助言である**——repo は取得できているし、
再変換しても上限は宣言されない。
⟹ `isLocalEmbeddingProviderError(error)` なら**そのまま再送出**する。
**包むのは、種類が分かっていない失敗だけにする。**

---

## 3. 検討した選択肢

### 3.1 `LocalEmbeddingPipeline` を必須 interface に変える（**最も強い。⛔ 提起までにする**）

```ts
interface LocalEmbeddingPipeline {
  readonly maxInputTokens: number;
  countTokens(texts: string[]): number[];
  embed(texts: string[]): Promise<number[][]>;
}
```
**利点**: 注入された pipeline も上限を宣言しなければ**型検査が通らない** ⟹
「宣言を忘れた pipeline が黙って検査を失う」形を**構造で消せる**
（ADR 0085 決定2 の「型のほうで強制して裏切りを起こせなくする」と同じ手）。

**却下の理由**: 公開 API の破壊的変更であり、`docs/autonomy.md` §3 の ⛔ 項目。
既存の注入点（`async (texts) => number[][]`）を使っている呼び出し側がすべて壊れる。
**⟹ 決定4 のとおり、提起する。**

### 3.2 上限とトークン数え器を、**任意の**プロパティとして関数型に足す

```ts
type LocalEmbeddingPipeline = ((texts: string[]) => Promise<number[][]>) & {
  readonly maxInputTokens?: number;
  countTokens?: (texts: string[]) => number[];
};
```
非破壊だが**却下**。任意にすると、`LocalEmbeddingProvider` は
**「この pipeline に上限が無い」と「この pipeline が上限の宣言を忘れた」を区別できない。**
⟹ **区別できない 2 種を 1 つに潰す**という、この repo が一貫して避けてきた形そのものになる
（ADR 0008 の判定基準に照らして落とした）。

### 3.3 上限を、`dimensions` と同じ「宣言するオプション」にする

`options.maxInputTokens`（既定 8192）を足し、`dimensions` と同じ形（ADR 0085 決定5）で
実物との食い違いを実行時に落とす案。**却下。**
**トークン数を数えるのに、結局トークナイザが要る。**
`@mnemora/core` の `TokenCounter`（ADR 0083 の CJK 対応ヒューリスティック）で代用すると、
**本物のトークナイザとの誤差が、そのまま誤検出（拒否しすぎ）と見逃し（切り捨てを通す）になる。**
⛔ **誤検出率を測れない門は置かない。**

### 3.4 例外ではなく警告をログに出す

**却下。**このパッケージはロガーを持たず、`@mnemora/core` も provider へロガーを渡さない。
ロガーを足すのは別の決定である。**そして「ログに出したが処理は続けた」は、
`embeddingStatus: 'ready'` の、中身が切れたベクトルを DB に残す**
——1.5 の「原因を追えない壊れ方」がそのまま残る。

### 3.5 入力を自動で分割して、複数のベクトルにする（chunking）

**却下。**`EmbeddingProvider.embed(ctx, texts)` の契約は
**`texts` と同じ件数のベクトルを返すこと**であり、1 件を N 件に割ると契約が壊れる。
そして「どう割るか」（文境界・重ね幅・割った後の統合）は
**想起の質を直接動かす設計判断**であり、ゴールデンセットが 7 件しかない現状
（ADR 0085 負債6）では**測れない。**⟹ 呼び出し側の判断として残す。

### 3.6 `observe()` の入力スキーマに `.max()` を足す

**却下（この PR では）。**`packages/core` の公開スキーマの破壊的変更であり、
**上限の値はモデルごとに違う**（`packages/openai` は 8191、`local` は 8192、
別の repo を指せばまた別）。⟹ **core が特定のモデルの数字を持つのは、層が違う。**
`docs/roadmap.md` §5 行きの性格の判断でもある。**ここでは経路の存在を記録するに留める。**

---

## 4. 問い② — 導かれる識別子のバイト長

### 4.1 【実測】63 バイトに収まっている。改名は要らない

`packages/postgres/src/embedding-space-table.ts` の導出関数を**実際に走らせた**。
`{ provider: "local", model: "ruri-v3-30m/sym", dimensions: 256 }` から:

| 何 | 名前 | バイト長 | 余裕 |
|---|---|---|---|
| テーブル | `memory_embeddings_local_ruri_v3_30m_sym_256` | **43 B** | 20 B |
| HNSW 索引 | `idx_memory_embeddings_hnsw_local_ruri_v3_30m_sym_256` | **52 B** | **11 B** |

⟹ **切り詰めも、ハッシュへの化けも起きていない。**【受領】の 2 例も同じ関数で再現した
（`local/multilingual-e5-small/384` → 49 B、
`transformers-js/Xenova\/multilingual-e5-small/384` → 63 B で切り詰め＋ハッシュ）。

⭐ **ADR 0085「これが覆るとしたら」が予告している `"ruri-v3-30m/asym"` への移行も、
1 バイト増えるだけで収まる**（テーブル 44 B / 索引 53 B）。

### 4.2 🔴 【実測】締め付けているのは索引名のほうである（受領した前提の穴）

接頭辞が違う: `idx_memory_embeddings_hnsw_`（**27 B**）対 `memory_embeddings_`（**18 B**）。
⟹ **索引名はテーブル名より常に 9 バイト長い。**
【受領】の 2 例はテーブル名だけで語られていたが、**先に溢れるのは索引名である。**
⟹ **テーブル名だけを見る歯は、索引名が化けている状態を緑で通す。**

### 4.3 🔴 「63 バイト以内」は、そのままでは**歯にならない**

`embeddingSpaceTableName` / `embeddingSpaceIndexName` は、
63 バイトを超える名前を**切り詰めてハッシュ片を足すことで、必ず 63 バイト以内に収める。**
⟹ **`byteLength <= 63` は導出関数の事後条件そのものであり、どんな `model` を渡しても真になる。
永久に緑の、嘘の歯である。**

⭐ **固定すべきは「名前が化けていないこと」である。**
切り詰め形は末尾を捨てて `_<sha256 の先頭 8 桁>` を足すので、
**3 つ組の最後の要素（`dimensions`）が名前の末尾から消える。**
⟹ 歯は **`endsWith(`_${dimensions}`)`** を見る。
切り詰め形の最後の `_` の後ろは必ず 16 進 8 文字なので、`_256` にはなりえない。
**その「なりえない」ことを、長すぎる `model` で実際に化かす歯で裏打ちしてある**
——検出器が壊れたら、そちらが赤くなる。

**期待値の `63` は逐語で持つ。**⛔ `MAX_IDENTIFIER_BYTES` から組み立てない
——**定数を書き換える変異とこの歯が自己整合して素通りする**（この repo で実際に起きている形）。
PostgreSQL の `NAMEDATALEN - 1` は外の世界が決めた値であって、この repo の変数ではない。

### 4.4 歯の住所

`packages/local-embedding/src/__tests__/embedding-space-name-budget.test.ts`。
**`packages/postgres` 側ではなく、こちら側に置いた**——
`packages/postgres` に `test` script が無く（`test:db` だけ）、
`pnpm -r run test` では走らないため、**DB 無しで毎 PR 走る主ジョブ**に載せるにはこちらである。
`@mnemora/postgres` を devDependency（`workspace:*`）で足し、
`vitest.config.mts` と `tsconfig.json` の alias / paths で **`src` を直接参照**する
（`packages/postgres` が `@mnemora/testkit` を参照しているのと同じ作法・同じ理由——
CI は `test` を `build` より先に走らせるので `dist` が無い）。

⛔ **名前をベタ書きしない**——導出関数を import して使う。ベタ書きすると、
導出が変わったときに歯が嘘になる。

---

### 4.5 【実測】変異試験 — 歯が噛むこと、そして 4.2 / 4.3 の主張の裏付け

**手順は「歯を書く → ベースライン緑を確かめる → 撃つ」。**復元は `cp` ＋ `cmp` の
バイト比較で毎回確認した（`git checkout` は使っていない）。
ベースラインは `63 passed | 5 skipped`（`packages/local-embedding`）。

| # | 変異 | 期待 | 結果 |
|---|---|---|---|
| M1 | `DEFAULT_LOCAL_EMBEDDING_MODEL_ID` を 34 字へ伸ばす | 赤 | ✅ 赤（下記 ⭐） |
| M2 | `MAX_IDENTIFIER_BYTES` を 63 → 40 | 赤 | ✅ 赤（5本。下記 ⭐⭐） |
| M3 | `HNSW_INDEX_PREFIX` を 16 バイト伸ばす | 赤 | ✅ 赤（**索引の歯ちょうど1本**） |
| M4 | 境界を `tokens > max` → `tokens >= max` | 赤 | ✅ 赤（「上限ちょうどは通る」1本） |
| M5 | 上限超過の検査を黙らせる（`if (false && …)`） | 赤 | ✅ 赤（7本） |
| M6 | `unknown_input_limit` の門を外す | 赤 | ✅ 赤（7本） |
| M7 | 種類の付いた失敗も読み込み失敗で包む（決定5 を戻す） | 赤 | ✅ 赤（1本） |
| M8 | 検査を推論の**後**へ動かす | 赤 | ✅ 赤（2本） |
| **C1** | **切り詰め形のハッシュを `sha256` → `sha1`** | ⚠ **緑のまま** | ✅ **緑**（`63 passed`） |

**C1 は「赤くなってはいけない変異」である。**歯は切り詰めの**検出**を固定しているだけで、
**ハッシュの中身は固定していない。**ここが赤くなるなら、歯は無関係な実装細部に過適合している。

⭐ **M1 が、4.2 の主張をそのまま実測に変えた。**
`model` を 34 字にすると **テーブル名は 62 バイトで収まり（緑）、索引名は 71 バイトで化ける（赤）。**
⟹ **落ちたのは索引の歯だけだった。テーブル名だけを見る歯は、この変異を緑で通していた。**

⭐⭐ **M2 が、4.3 の主張をそのまま実測に変えた。**
`MAX_IDENTIFIER_BYTES` を 40 にしても、**`byteLength <= 63` の 2 本は緑のままだった**
（名前は 40 バイト以内に収まるので、契約は満たされ続ける）。
**赤くなったのは `endsWith(_${dimensions})` の歯と、検出器そのものの歯だけである。**
⟹ **「63 バイト以内」が永久に緑の嘘の歯であることは、推論ではなく変異で示されている。**

---

## 5. 結果（この決定が招くもの）

**良い面**
- **8192 トークンを超えた入力が、`kind` の付いた例外として名乗る。**
  `processEmbedJob` 経由なら `embeddingStatus: 'failed'` という問い合わせ可能な状態が残る。
- **「上限が宣言されていない」が「上限が無い」に潰れない。**
- **`createLocalEmbeddingPipeline` の中身のうち、測れる部分が CI から測れるようになった。**
- **識別子の余裕が歯で固定された。**`model` を伸ばした人は、書くまで CI が赤い。

**引き受けた負債**

1. 🔴 **注入された pipeline には上限の検査が無い。**
   検査は `buildLocalEmbeddingPipeline` が組み立てた pipeline の中に在るので、
   `options.createPipeline` で別のものを注入した呼び出し側には効かない。
   ⟹ **これは 3.1 の必須 interface で構造的に消せる。⛔ 公開 API の破壊的変更なので、
   `docs/autonomy.md` §3 に従って実装せず、ここで提起する。オーナーの判断を待つ。**
2. **トークン数を、推論の前にもう 1 回数えている。**
   `feature-extraction` の中でも数えるので、**符号化が 2 回走る。**
   **【実測・委】8000 トークン（10,222 字）1 本で、`encode` の中央値は 748ms / 823ms
   （独立に 2 回計測、各 5 試行）、推論の中央値は 8,258ms / 10,137ms。**
   ⟹ **比は 11〜12 倍で、余分な符号化は推論全体の約 8〜9%。**
   **無視できるほど小さくはないが、推論より 1 桁小さい。**
   ⚠ **この比は、この機・この入力長での 2 回の実測だけである**（他の機・他の長さでは未確認）。
   ⟹ 1 回に畳むには、トークン列を pipeline へ直接渡す口が要る。transformers.js の
   `feature-extraction` にその口は無い。
3. **`observe()` の入力に上限は無いままである**（1.5 の経路は開いている）。
   本 ADR は「壁に当たったことが分かる」までしか買っていない。
   **当たらないようにする**（分割・要約・スキーマの上限）のは別の決定である（3.5 / 3.6）。
4. **`packages/openai` 側は 1 行も触っていない。**
   `packages/openai/src/embedding-provider.ts` にも入力長の検査は無い
   （【実測】`texts.length === 0` の早期 return だけ）。
   ⚠ **そちらはサーバが拒否する（と受領している）ので同じ穴ではない可能性が高いが、
   この作業では実 API を叩いておらず、確かめていない。**
5. **`EmbeddingProvider` の適合テストは今も無い**（ADR 0085 負債4 / [#116](https://github.com/takecchi/mnemora/issues/116)）。
   ⟹ **本 ADR の歯は `packages/local-embedding` の中だけに在る。**
   同じ穴が他の provider に在るかを横断で検査する歯は無い。
6. **`docs/recall.md` に入力長の節を足していない。**
   §6 は `recall()` の出力の予算を扱う節であり、入力の壁は別の場所の話である
   （どこへ書くかを決めていない ⟹ 足さなかった）。

---

## 6. これが覆るとしたら

- **オーナーが 3.1（必須 interface）を承認したとき。**負債1 が消え、決定4 が覆る。
- **`options.repo` を `model_max_length` の宣言が無いモデルへ向けたとき。**
  決定2 により**組み立てが失敗する。**それが厳しすぎると判断されたら、
  「宣言が無いモデルを使う」ための口（オプションか注入）を決め直すことになる。
- **transformers.js が `truncation` の既定を変えたとき**、あるいは
  **切り捨てを警告するようになったとき。**1.4 の表の行が動く。
- **入力の分割（chunking）を入れる要求が立ったとき。**3.5 へ戻る。
  ⚠ **そのときはゴールデンセットが 7 件では測れない**（ADR 0085 負債6 / #109）。
- **`model` を伸ばして識別子が 63 バイトを超えたとき。**歯が赤くなる。
  ⚠ **既に本番で使われている space の改名は移行を伴う** ⟹ オーナーの判断である。

---

## 7. 確かめていないこと

- **【受領】OpenAI の 8191 トークンと、その上限超過時の振る舞い（サーバが拒否するのか）を、
  実 API で確かめていない。**1.3 の比較は、その前提の上に立っている。
- **出所の内訳。**書き手が**自分の手でこの器から**引いたのは、
  **宣言値（8192）・ライブラリの該当コード（1.4 の表）・`observe()` からの経路（1.5）・
  識別子のバイト長（4.1）・live の 3 本の歯（8192=10,469 字 / 8193=10,470 字 /
  `cos = 1.0000000000000002`）・6 つの門・4.5 の変異試験**である。
  **委譲先から受け取ったまま再実行していないのは、
  合成文コーパスでの 18,441 字境界と隣接 cos の表（1.2 前半）・
  カセットの長さ分布（1.5）・`consolidate` の監査（1.5）・
  符号化と推論の費用比（負債2）**である。
- **反復 `consolidate()` で `content` が実際に単調増加することを測っていない。**
  言えているのは「縮む保証がコードに無い」までである。
- **`observe()` の生テキスト経路（1.5）が実運用でどの頻度で起きるかを測っていない。**
  LLM 抽出の失敗率に依存する。
- **`Infinity` 以外の壊れた `model_max_length`（例: 文字列）を、本物の
  transformers.js が返しうるかを確かめていない。**歯は擬似の extractor で測っている。
- **8192 トークンちょうどの入力が、モデルの中で本当に切られていないこと**は
  live テストの振る舞い（例外を投げず、ベクトルが返る）でしか見ていない。
  **トークン列を直接覗いて確認したわけではない。**
