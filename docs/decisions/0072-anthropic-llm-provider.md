# ADR 0072: `@mnemora/anthropic` を足す — `LLMProvider` だけを実装し、翻訳先はネイティブの構造化出力にする

- **状態**: 採用 (2026-09)
- **日付**: 2026-09-09

**⚠ 各主張の出所を分ける。**「私が実行して確かめた」と「人から受け取った前提」と「推測」を混ぜない。
本 ADR で「実測」と書いたものは、断りの無い限り**この作業者がこの器で実行して取った**ものである。

---

## 問い

**provider が `@mnemora/openai` の1つしか無かった。**

`docs/architecture.md` §3.6 は「実体（Postgres・OpenAI・BullMQ）は adapter パッケージ側にしか
存在しない」と述べ、§4 は core を「誰にも依存されるが、誰にも依存しない」と図示している。
`packages/testkit` が置かれた理由も、§4 が自分で書いているとおりである:

> 「差し替え可能」という主張は、適合テストが無ければ願望に留まる。（…）**2つ目の
> adapter が書かれた瞬間に、型は同じでも振る舞いが違う実装が紛れ込む。**

**この論法は Store 系にだけ適用され、provider には適用されていなかった。**
`LLMProvider` の実装は1つしか無く、**1つしか無い抽象は、抽象であることを一度も検証されていない。**
「ベンダー固有の型を漏らさない」という §3.8 の契約が実際に守られているかは、
2つ目の実装を書くまで分からない——**漏れていても、1つしか無ければ誰も気付かない。**

### オーナーの指示（出所: 人から受け取った。逐語）

> **「あとmnemoraのAnthropicがないなら作ってくれよ。」**
> **「なんでそれをしないでOpenAIを使う選択肢取ろうとしてんの？」**

**これはオーナーの決定である。**

### ⚠ 設計としては既に決まっていた。欠けていたのは実装だけである

**本 ADR は新しい方針を決めていない。**`docs/architecture.md` は最初から
`packages/anthropic` を設計に含めており、**`EmbeddingProvider` を置かない理由まで
既に書いてあった**（§4「オーナー案から変えた3点」）:

> **`anthropic` に `EmbeddingProvider` を置かない。**
> これはオーナーの package 表への**事実訂正**である。Anthropic は埋め込み API を提供していない
> （公式には外部の埋め込みモデルの利用を案内している）。`packages/anthropic` は `LLMProvider` のみを
> 実装する。埋め込みが要る構成では `openai` か将来追加される別 provider が必要になる。

`packages/core/src/interfaces/embedding-provider.ts:10` にも同じ注記が在る。
**⟹ 「Anthropic には埋め込み API が無い」は、このリポジトリでは既に織り込み済みの事実であって、
Anthropic を足さない理由ではなかった。**抽出（LLM）と埋め込みは別の interface であり、
**片方だけ実装できる**——`packages/core` の型定義がそう書かれている。

一方 `docs/roadmap.md` の Phase 1 完了条件（段階6）は
「CI で `core` / `testkit` / `postgres` / `openai` の主要パスが緑になる」であり、
**`anthropic` は Phase 1 のスコープに入っていなかった。**だから実装が無かった。

---

## 決定

### 1. `packages/anthropic` を作り、`LLMProvider` **だけ**を実装する

`EmbeddingProvider` は実装しない。**そして、それをパッケージ自身に名乗らせる**
（README と `src/index.ts` の冒頭コメント）。**黙って未実装にしない**——
使う側が「在るはず」と思って探すためである。

**⚠ このパッケージ単独では runtime を組めない。**`packages/core/src/runtime.ts` の
`RuntimeDeps` は `llmProvider` と `embeddingProvider` を**どちらも必須フィールド**として
要求している（`?` が付いていない。同じ interface 内の `clock?` / `config?` /
`tokenCounter?` と対比すれば意図的なことが分かる）。`recall-runtime.ts` の
`RecallRuntimeDeps` も同様である。

**⟹ `core` の改修は要らない。**両者は `RuntimeDeps` の**別々のフィールド**であり、
`llmProvider` に Anthropic、`embeddingProvider` に OpenAI を渡す形が型検査を通る。
「provider 一式を1つのパッケージが揃える」という要求は、そもそもどこにも無い。
README にこの組み合わせ方の例を載せた。

### 2. zod → 構造化出力の翻訳先は、**強制 tool use ではなくネイティブの構造化出力**にする

**出所: 私が `@anthropic-ai/sdk` 0.124.0 の現物（`.d.ts` と `.js`）を読んで確認した。**

Anthropic には `messages.create()` の `output_config.format` というネイティブの構造化出力が在る:

```ts
interface JSONOutputFormat { schema: { [key: string]: unknown }; type: 'json_schema' }
interface OutputConfig { effort?: ...; format?: JSONOutputFormat | null }
```

公式の zod ヘルパ `zodOutputFormat`（`@anthropic-ai/sdk/helpers/zod`）も在り、
中身は `transformJSONSchema(z.toJSONSchema(zodObject, { reused: 'ref' }))` である。
**`packages/anthropic` はこのヘルパの変換結果を使い、JSON Schema を自前で組み直さない。**

**⟹ `docs/architecture.md` §3.8 の「Anthropic の強制 tool use 相当」という記述は、
現行の API に対しては古い。**本 PR でその1文を実測に合わせて直した。

**強制 tool use を採らなかった理由**（下の「採らなかった案」にも再掲）:
`tool_choice` の `{type:"any"}` / `{type:"tool"}` は **Claude Fable 5.1 系のモデルで
400 になる**。つまり強制 tool use に寄せた翻訳は、**モデルを新しくした日に壊れる。**

### 3. `@mnemora/openai` と揃えるもの / 意図的に揃えないもの

**揃えたもの（＝「差し替えられる」の中身）:**

| 事項 | 両パッケージ共通の契約 |
|---|---|
| `completeStructured` の戻り値 | 常に**検証済みの `T`**（`req.schema.parse` を通したもの） |
| 構造化出力が返らなかったとき | **例外を投げる。** `Error("〜LLMProvider: structured completion returned no content")` |
| JSON として壊れていたとき | `JSON.parse` の `SyntaxError` を**そのまま伝播**（catch しない） |
| スキーマに適合しなかったとき | `ZodError` を**そのまま伝播**（`.safeParse` を使わない） |
| `complete` のテキストが取れないとき | `{ content: "" }` を返す |
| モデル名 | **既定値を持たない。`options.model` は必須。**呼び出し側が決める |
| SDK 型の露出 | `core`・呼び出し側にベンダー固有の型を漏らさない |

**⚠ `complete` だけが「黙って空を返す」形になっているのは、`@mnemora/openai` が
既にそうなっているからである**（`llm-provider.ts` の `?? ""`）。
**揃えることを優先した。**片方だけ throw にすると、それこそ差し替えられなくなる。
これは**引き受けた負債**として下に再掲する。

**意図的に揃えないもの（＝ベンダーの差そのもの）:**

| 事項 | `@mnemora/openai` | `@mnemora/anthropic` |
|---|---|---|
| 翻訳結果の形 | `{ name, strict: true, schema }` | `{ type: "json_schema", schema }`（**`name` も `strict` も無い**） |
| `additionalProperties: false` | **自前で付ける**（`hardenForStrictMode`） | **SDK 側の変換が付ける** |
| `.optional()` の扱い | **全キーを `required` に入れ、省略可能は nullable へ変換** | **`required` は元のまま。optional は optional のまま残る** |
| 返ってきた JSON の後処理 | **`stripNulls` が要る**（`null` → キー省略へ戻す） | **要らない** |
| `max_tokens` | 不要 | **必須**（`DEFAULT_MAX_TOKENS = 16000`、`options.maxTokens` で上書き可） |
| `system` の渡し方 | `messages` に `role:"system"` として積む | **top-level の `system` パラメータ**（`messages` は `user`/`assistant` のみ） |

**最後の2行は、翻訳ではなくリクエストの組み立ての差である。**
`PromptSpec.messages` に `role:"system"` が入っていた場合は
**top-level の `system` へ連結する。黙って捨てない。**

### 3b. ⚠ 実装中に実測で見つかった差 — enum は制約として送られない

**出所: 私が `zodOutputFormat` を実際に呼んで出力を目視した。**

Anthropic の公式ヘルパの `transformJSONSchema` は、`type` / `description` / `title` と
type 別の少数のキーしか素通りさせない。**それ以外に残ったキーは削除されるのではなく、
`description` に JSON 文字列として埋め込まれる。**

```
z.enum(["a","b"])   → { type: "string", description: "{enum: [\"a\",\"b\"]}" }
z.number().min(1)  → { type: "number", description: "{minimum: 1}" }
```

**⟹ これは他人事ではない。**core が `completeStructured` へ実際に渡す
`ExtractionResultSchema` は **`provenanceKind: z.enum(["stated", "inferred"])`** を持つ
（オーナーの原則7——AI の推論とユーザーが言った事実を区別する——を型で担保している箇所である）。
`confidence: z.number().min(0).max(1)` も同様に降格する。

| | `@mnemora/openai` | `@mnemora/anthropic` |
|---|---|---|
| `enum` の送り方 | JSON Schema の `enum` キー（**生成時に制約される**） | `description` の説明文（**制約されない**） |
| 列挙から外れた値が来たら | 生成段で防がれる（はず） | `req.schema.parse` の `ZodError` で弾かれる |

**⟹ 強制力は違うが、呼び出し側から見た契約は同じである**——どちらも
**黙って通すことはしない。**止まる場所が違うだけである
（`provider-parity.test.ts` に両方の歯を置いた）。

**⚠ ただし、止まる場所の違いには実際の帰結が在る。**
`packages/core/src/extraction.ts` の `extractCandidates` は
`completeStructured` の例外を `try/catch` で飲み、
**`ExtractionOutcome: "llm_failed_whole_observation"` へフォールバックする。**
⟹ Anthropic 側では、列挙違反が「抽出の失敗」として記録される経路を通る。
**この頻度は測っていない**（実 API を叩いていないため）。下の「確かめていないこと」に置いた。

**翻訳を「直す」ことはしない。**公式ヘルパの変換をそのまま使うという決定2 を優先した。
自前で `enum` を復元し始めると、ADR 0072 が却下した「自前で JSON Schema を書く」案へ
戻ることになる。**代わりに、この形を歯で固定した**——SDK 側が将来 `enum` を
素通りさせるようになれば、その歯が赤くなって気づける。

**⚠ 副産物として観測したもの**: root スキーマの `description` に
`"{$schema: \"https://json-schema.org/draft/2020-12/schema\"}"` が漏れる
（`@mnemora/openai` 側は `$schema` を明示的に削除している）。
**害があるかは測っていない**——モデルへ無意味な説明文が1つ増えるだけだと考えているが、
確かめていない。

### 4. 歯は `@mnemora/openai` と同じ形にする（testkit には置かない）

**実測: `packages/testkit` の適合テストは Store 系5種（`MemoryStore` / `VectorStore` /
`EventStore` / `OutboxStore` / `TenantSettingsStore`）だけを対象にしており、
provider 向けの適合テストは1本も無い。**testkit が provider について持っているのは
**擬似実装（`Deterministic*` / `Recorded*`）＝テストの入力側**であって、
**他人の実装を検査するスイートではない。**

**⟹ `@mnemora/openai` は「自前の単体テストだけ」で担保されている。**
`@mnemora/anthropic` も同じ形にした（翻訳結果の直接検査・偽 client によるリクエスト組み立ての検査・
異常系・opt-in の実 API テスト）。

**そのうえで1本だけ足した**: `provider-parity.test.ts` — **同じ入力を両 provider に与えて、
同じ形の値が返ることを検査する。**これが「差し替えられる」の、このリポジトリで最初の実測である。

**⚠ これは適合テストの代わりではない。**`@mnemora/anthropic` の中に置いた歯であり、
3つ目の provider が来ても自動的には効かない。下の「引き受けた負債」を見ること。

### 5. `scripts/publish-targets.mjs` に足す（publish はしない）

publish 対象は固定リストであり「新しい publish 対象が増えたら手で足す必要がある」と
当のファイルが書いている。**足さないと、次の Release で黙って対象外になる。**

**⚠ 足したのはリストだけで、publish も Release も行っていない**（`docs/autonomy.md` §3 の ⛔）。
**実際に npm へ出るかはオーナーの判断である。**

---

## 測ったこと

**出所: 私がこの器で実行した。**

- **実 API の呼び出しは 0 回。** `ANTHROPIC_API_KEY` はこの実行環境に在らず（有無のみ確認。値は読んでいない）、
  **記録（カセット）も作っていない。**
- **カセットは要らなかった。** ADR 0051 の `recorded-provider-cassette` は
  **`examples/chat` の想起ベンチ（北極星の物差し）専用の仕組み**であって、
  provider パッケージの単体テストの仕組みではない。`@mnemora/openai` の実 API テスト
  （`live.openai.test.ts`）は `OPENAI_API_KEY` と `MNEMORA_LIVE_OPENAI` の**二重の opt-in**で
  守られており、CI では常に skip される。`@mnemora/anthropic` も同じ形にした。
- **branch protection の required 4本**（`gh api repos/takecchi/mnemora/branches/main/protection` で実測）:
  `typecheck / lint / test / build` / `packages/postgres (本物の Postgres + pgvector)` /
  `examples/chat (本物の Postgres + pgvector、擬似 provider)` /
  `ルートの test 門の DB 段（…ADR 0015）`。`enforce_admins=true`、`strict=false`。

門の終了コードと変異試験の結果は PR 本文に書いた。

---

## 採らなかった案

- **強制 tool use（`tools` の `input_schema` + `tool_choice`）へ翻訳する。**
  却下。`docs/architecture.md` §3.8 が当初想定していた形だが、**`tool_choice` の
  `any`/`tool` は Claude Fable 5.1 系で 400 になる**（出所: `@anthropic-ai/sdk` に同梱の
  ドキュメントとモデル一覧。**私は 400 を実際に受け取ってはいない**——下の「確かめていないこと」）。
  ネイティブの構造化出力が在るのに、壊れる方を選ぶ理由が無い。
- **JSON Schema への変換を自前で書く**（`@mnemora/openai` の `json-schema.ts` と同じ形にする）。
  却下。OpenAI 側が自前で書いているのは **strict モードの要求（全キー required + nullable 化）を
  満たすため**であって、変換そのものを持ちたかったからではない。Anthropic 側は公式ヘルパが
  同じことをしてくれる。**同じ理由が無いのに同じ形にするのは、対称性のための対称性である。**
- **`EmbeddingProvider` を「例外を投げるだけの実装」として置く。**
  却下。**在るように見えて動かないものが、いちばん質が悪い。**`docs/architecture.md` §4 が
  既に「置かない」と決めており、`packages/core` の interface コメントもそう書いている。
- **`@mnemora/anthropic` 用の適合テストを `packages/testkit` に新設する。**
  却下（**今回は**）。provider の適合テストは Store 系と違って
  **「同じ入力に同じ出力」を要求できない**（LLM は非決定的である。ADR 0051 の arm C が
  実測でそれを示している）。**何を契約として固定できるかを先に決める必要があり、
  それはこの PR の範囲を超える。**下の「引き受けた負債」1 に置いた。
- **`maxTokens` も `model` と同じく必須にする。**
  却下。`model` を必須にしたのは**モデル選定が製品の判断だから**である。`max_tokens` は
  Anthropic の API が機械的に要求するパラメータであって、選定ではない。ただし
  **既定値を隠さない**ために `DEFAULT_MAX_TOKENS` として export した。
- **`docs/architecture.md` を大きく直す。**
  却下。§3.8 の「強制 tool use 相当」の1文だけを実測に合わせた。
  **`docs/autonomy.md` §2 の「ついでに直すをしない」に従う。**

---

## ⚠ 追記（2026-09-09、PR #89 マージ後）— 初版に穴が1つ在った

**状態: 初版の決定は覆っていない。契約を1つ足した。**

### 何が抜けていたか

**初版は `content` を読む前に `stop_reason` を見ていなかった。**
`packages/anthropic/src/` にも `__tests__/` にも `stop_reason` / `refusal` は
**1件も無かった**（実測。マージ後に grep した）。

**⚠ Anthropic の拒否は HTTP 200 で返る。**`stop_reason: "refusal"` が付いた
**成功応答**であり、SDK は例外を投げない。`content` にはテキストブロックが1つも
無いことがある。**⟹ 見ないと、拒否を「空の成功」として扱う。**

**実害は限定的だった**（マージ前に測り直した）:

| | 実運用の呼び出し元 | 拒否されたときの初版の振る舞い |
|---|---|---|
| `complete()` | **無い**（`extraction.ts` は使っていない） | `?? ""` で**空文字を成功として返す** |
| `completeStructured()` | `extraction.ts:163` が唯一 | `throw`（**黙っては通らない**） |

**⟹ 静かに壊れる形にはなっていなかった。**決定3 の「構造化出力が返らなかったら例外を投げる」が
効いていた。**しかし残る問題が在った——「拒否された」と「応答が空だった」が*同じ例外*になる。**

**⟹ これはこのリポジトリの固定点「『無い』の種類を潰さない」に正面から当たる**
（ADR 0008 / 0013 / 0026 / 0027 / 0044 が一貫して守ってきた線）。
`extraction.ts` の `extractCandidates` はこの例外を飲んで
`llm_failed_whole_observation` へ倒すので、**「モデルが拒否した」という情報はそこで消える。**

### 決定6: `content` を読む前に `stop_reason` を見る。失敗は種類として区別する

**出所: 私が `@anthropic-ai/sdk` 0.124.0 の `.d.ts` を読んで確認した。**
`StopReason` は
`'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use' | 'pause_turn' | 'refusal' | 'model_context_window_exceeded'`
であり、`'refusal'` は**実在する。**`Message.stop_details` は
`RefusalStopDetails | null`（`category`: `cyber` / `bio` / `frontier_llm` /
`reasoning_extraction` …**開いた集合**）で、「拒否についての構造化された情報」と型コメントに在る。

`AnthropicLLMProviderError` を足し、**`kind` で3種を区別する**:

| `kind` | 何が起きたか | `stop_reason` |
|---|---|---|
| `"refusal"` | 安全性の分類器が介入した。`refusalCategory` に分類が入る | `refusal` |
| `"truncated"` | 応答が途中で切れた | `max_tokens` / `model_context_window_exceeded` |
| `"no_content"` | 上記のどれでもないのに、テキストブロックが無かった | それ以外 |

**⚠ `instanceof` ではなく `kind` で分岐させる形にした**——bundler が同じクラスを
二重に読み込むと `instanceof` は落ちるが、`kind` は値なので影響を受けない。

**`no_content` のメッセージは初版のまま**にした（`"…structured completion returned no content"`）。
`provider-parity.test.ts` がこの文言に依存しており、**`@mnemora/openai` と揃えた契約を壊さない。
種類は足しただけである。**

**`stop_reason` が無い/null なら通す。**非 streaming では常に非 null だと型コメントが
述べているが、streaming の `message_start` では null になり、偽 client も設定しない。
**「分からない」を「拒否された」と読まない。**

**⚠ `truncated` は依頼された範囲の外である。**依頼は「拒否と空応答を区別する」だった。
同じ `stop_reason` を読む一手で分かり、**切り詰められた JSON は `SyntaxError` になって
「モデルが壊れた JSON を吐いた」と区別が付かなくなる**——同じ固定点に当たると判断して入れた。
**要らなければ落とせる**（歯ごと消せば済む）。

### `complete()` の `?? ""` は残した

**残した。**ただし**門を通した後**なので意味が変わっている——ここへ来る空文字は
「拒否された」でも「切り詰められた」でもなく、**モデルが本当に何も言わなかった**場合だけである。

**なぜ残したか**: `@mnemora/openai` も同じ形であり（負債2）、片方だけ throw にすると
差し替えられなくなる。**直すなら両 provider 同時＝公開 API の破壊的変更**なので、
`docs/autonomy.md` §3 に従って**提起までにした。**

**⟹ この形を歯で固定した。ただし歯自身に「望ましい姿ではない」と名乗らせてある**
（`refusal.test.ts` の当該 it のコメント）。**「安全である」という主張ではなく、
「いまはこうだ」を書き留めた歯である**——直すときは歯ごと書き換えること。

### ⚠ `@mnemora/openai` も同じ穴を持っている（この追記の範囲外）

**実測: `packages/openai/src/` に `refusal` は0件。**OpenAI の chat completions にも
`message.refusal` と `finish_reason` が在るはずだが、`@mnemora/openai` は
どちらも見ていない。**⟹ 同じ形の穴が在る可能性が高い。**

**この追記では直していない。**「揃える」ために Anthropic 側を弱くはしない
（種類を足すだけにした）。**OpenAI 側を直すかはオーナーの判断であり、別の PR である。**
**⚠ OpenAI 側の SDK 型は読んでいない**——「在るはず」は推測である。

---

## 引き受けた負債

1. **provider の適合テストは、今も存在しない。**`provider-parity.test.ts` は
   `@mnemora/anthropic` の中に在る歯であり、**3つ目の provider が来ても自動的には効かない。**
   Store 系が `packages/testkit` の適合テストで守られているのに対し、provider は
   **「2つの実装を並べて見比べる歯を1本」持っているだけ**である。
2. **`complete` は、テキストが取れなくても `{ content: "" }` を返す。**
   `@mnemora/openai` に揃えた結果であり、**両方とも「黙って空を返す」。**
   `completeStructured` は throw するので契約が非対称である。
   **直すなら両方同時に直す必要があり、それは公開 API の破壊的変更になる**
   （`docs/autonomy.md` §3 では ⛔ ＝提起までにする項目）。
3. **`packages/anthropic` は Phase 1 の完了条件に入っていない。**
   `docs/roadmap.md` 段階6 は4パッケージを名指ししており、**本 PR ではそこを直していない。**
   Phase 1 の定義を動かすかはオーナーの判断である。
4. **北極星の物差し（`examples/chat` の `retrieval` / `compare`）は、
   Anthropic では一度も走っていない。**カセットも無い。
   **⟹ この PR は「Anthropic で想起の質がどうなるか」について何も言っていない。**
   言えるのは「契約が揃っている」ことだけである。
5. **Anthropic 側では `enum` / `minimum` / `maximum` が JSON Schema の制約として送られない**
   （決定3b）。`req.schema.parse` が最後に弾くので黙って通ることは無いが、
   **生成段で防げていない分、抽出の失敗として記録される経路を通る頻度が
   `@mnemora/openai` より高い可能性が在る。測っていない。**
6. **`@mnemora/openai` は `refusal` / `finish_reason` を見ていない**（実測: 0件）。
   **同じ穴が在る可能性が高いが、この PR では直していない。**別の判断である。
   **⟹ [ADR 0075](./0075-openai-refusal-and-truncation.md) で返済した**（行き先の案内であり、上の決定の書き換えではない）。
7. **`complete()` の `?? ""` は残っている**（上の追記）。門を通した後なので
   拒否は握り潰さなくなったが、「本当に何も返らなかった」は依然として空文字になる。
8. **npm への publish は行っていない。**`PUBLISH_TARGETS` に足しただけであり、
   `@mnemora/anthropic` は npm 上にまだ存在しない。

---

## これが覆るとしたら

- **Anthropic がネイティブの構造化出力を変えたとき / 埋め込み API を出したとき。**
  前者は翻訳の作り直し、後者は決定1（`EmbeddingProvider` を実装しない）そのものが覆る。
- **`provider-parity.test.ts` が「同じ形」を主張できなくなったとき。**
  3つ目の provider が来て、2つ並べる形が破綻したら、
  そのときこそ `packages/testkit` の適合テストへ引き上げる（負債1）。
- **`complete` の空文字が実際に人を騙したとき。**負債2 を、両 provider 同時に直す判断へ。
- **オーナーが `@mnemora/anthropic` を publish 対象から外す判断をしたとき。**決定5 が覆る。

---

## 確かめていないこと

- **実 API を一度も叩いていない。**`ANTHROPIC_API_KEY` がこの実行環境に無い。
  **⟹ 「このコードが実際に Anthropic から構造化出力を引ける」ことは確かめていない。**
  確かめたのは、**リクエストが意図した形に組み立てられること**（偽 client が受け取った引数の検査）と、
  **翻訳結果が意図した JSON Schema になること**だけである。
- **`tool_choice` の `any`/`tool` が Claude Fable 5.1 系で 400 を返すことを、自分では観測していない。**
  SDK に同梱のドキュメント記述に基づく。**採用した経路（`output_config.format`）は
  この記述に依存していない**ので、仮にこれが誤りでも決定2 は揺らがない。
- **`DEFAULT_MAX_TOKENS = 16000` が抽出に十分かを測っていない。**
  `extraction.ts` の `ExtractionResultSchema` が要求する出力量から見て過小ではないと考えたが、
  **実際の応答が切り詰められるかは実 API でしか分からない。**
- **CI の `build` ジョブが新パッケージを自動的に対象に含めることを、
  ローカルの `pnpm -r` の挙動からのみ確認している。**CI 上での実測は PR の run で行う。
- **`enum` が制約として送られないことが、実際の抽出の質にどれだけ効くかを測っていない。**
  形（`description` へ降格すること）は実測して歯で固定したが、
  **モデルが実際に列挙から外れた値を返す頻度**は実 API でしか分からない。
- **root スキーマの `description` へ `$schema` が漏れることの害を測っていない。**
- **`packages/anthropic` を含めた状態での `pack:check` / publish の梱包が正しいか**は、
  門としては通したが、**実際に npm へ出して確かめてはいない**（出せない。⛔）。
