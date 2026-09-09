# ADR 0076: 抽出は例外を飲み続ける。ただし**中身は捨てない** — `kind` を `ObserveResult` まで運ぶ

- **状態**: 採用 (2026-09)
- **日付**: 2026-09-09

**⚠ 各主張の出所を分ける。**「実測」と書いたものは、断りの無い限り**この作業でこの器から実行して取った**ものである。

---

## 問い

`packages/core/src/extraction.ts` の `extractCandidates` は、`LLMProvider.completeStructured` が
投げた例外を `catch {}` で受けている。**エラー変数を束縛すらしていない。**

⟹ **`@mnemora/anthropic`（ADR 0072 決定6）と `@mnemora/openai`（ADR 0075）が `kind` で区別して投げた
失敗の種類は、ここで完全に消える。**
（[ADR 0075](./0075-openai-refusal-and-truncation.md) は別 PR（#93）で先に入った。）

**飲むのをやめるべきか。それとも、飲んだまま中身だけ運ぶべきか。**

---

## 文脈

### 「飲む」こと自体は、既に決まっている

**[ADR 0013](./0013-extraction-outcome-taxonomy.md) が「検討した選択肢」で明示的に却下している:**

> **失敗時に例外を投げて `observe()` 全体を失敗させる**: 安全弁の目的（記憶を失うくらいなら
> 受け取る）と正面から衝突する。却下。

⟹ **これは維持する。この ADR は ADR 0013 を覆さない。**

### 「中身まで捨てる」ことを決めた記述は、どこにも無い

**実測**: 以下を読んで探したが、「例外の種類を上へ伝えない」と決めた記述は**1件も無かった**。

- `docs/roadmap.md` §5「設計上まだ判断が必要な点」——**6項目に限ると明記されており**、
  この論点は含まれていない。⟹ `AGENTS.md` の規約
  （「そこに無いものは設計側で決めて理由を残す」）に従えば、**設計側で決めるべき技術判断**である。
- ADR 0072 の「引き受けた負債」8項目・「これが覆るとしたら」4項目——**この点は載っていない。**
- `packages/core/src/extraction.ts` / `runtime.ts` のコメント、`__tests__` のテスト名——該当無し。

**逆に、repo 自身が2箇所でこの損失を「固定点への抵触」として名指ししている:**

- `packages/anthropic/src/errors.ts`:
  「種類を潰したまま投げると、「モデルが拒否した」という情報はそこで完全に消える。」
- ADR 0072 の追記:
  「`extraction.ts` の `extractCandidates` はこの例外を飲んで `llm_failed_whole_observation` へ
  倒すので、**「モデルが拒否した」という情報はそこで消える。**」

⟹ **これは「やらないと決めた」ではなく、「問題だと認識したまま処分を書いていない」状態である。**

### 何が畳まれているか

**この1つの値 `llm_failed_whole_observation` に、少なくとも6種の原因が畳まれている**
（`completeStructured` の実装から経路を追って列挙した）:

| 原因 | 例外 |
|---|---|
| モデルが拒否した | provider のエラー（`kind: "refusal"`） |
| 出力が途中で切れた | provider のエラー（`kind: "truncated"`） |
| テキストが1つも無かった | provider のエラー（`kind: "no_content"`） |
| **スキーマ検証に落ちた** | `ZodError` |
| JSON が壊れていた | `SyntaxError` |
| 通信・タイムアウト・認証 | SDK の `APIError` 系 |

**⚠ しかもこの畳み込みは provider によって偏る。** ADR 0072 決定3b の通り、
Anthropic 側は `z.enum(...)` を JSON Schema の制約として送らず `description` へ降格させるため、
**同じ列挙違反が OpenAI では生成段で防がれ、Anthropic では `ZodError` になって
`llm_failed_whole_observation` へ倒れる。**⟹ **飲まれると、その差が呼び出し側から見えなくなる。**
（**この偏りの構造は実測で確認した**が、**実運用での頻度は測っていない**——ADR 0072 自身も同じ限界を認めている。）

---

## 決定

**飲むのは維持する。中身だけを運ぶ。**

1. `ExtractionFailure { kind: string \| null; message: string }` を新設する。
2. `describeExtractionFailure(error: unknown): ExtractionFailure` を新設する。
   - ⚠ **`instanceof` は使えない。**`packages/core` の実行時依存は zod だけであり
     （`dependency-boundary.test.ts` が機械的に検査している）、core は provider のクラスを知らない。
     ⟹ **値として `error.kind` を読む**（duck typing）。
   - **`kind` は `typeof === "string"` かつ空文字でないときだけ採る。それ以外は `null`。**
     ——**「分からない」を勝手な種類に読み替えない**（ADR 0075 / 0072 決定6 と同じ固定点）。
   - **非 `Error`（文字列・`undefined`・プレーンオブジェクト）が投げられても落ちない。**
3. `catch {}` を `catch (error) {}` にする。
4. `ExtractCandidatesResult` / `ObserveResult` / `ReextractResult` に
   **`failure` / `extractionFailure` を必須の欄として**足す。
5. `memory_events.meta` に、失敗経路のときだけ `failureKind` を足す。

### ⭐ `ExtractionOutcome` の3値は変えない

**値を足したくなるが、足さない。**

**実測**: `ExtractionOutcome` を分岐している2箇所——`runtime.ts` の三項演算子と
`examples/chat/src/retrieval-quality.ts` の `switch`——には**網羅性チェックが無い**
（`default: { const exhaustive: never = input; ... }` のパターンは同じ repo の他所では
使われているが、`ExtractionOutcome` の分岐には1つも無い）。

⟹ **第4の値を足すと、コンパイルは通ったまま `retrieval-quality.ts` の集計が黙って無視し、
`runtime.ts` の三項が既定の `"extracted"` 側へ倒れる。**

⟹ **「無い」の種類を割るときに既存の列挙を広げるのは、既定値を出していた読み手を黙って壊す。**
種類は**別の欄**で運ぶ。

### ⭐ 欄を「省略可能」にしない

**`failure?:` ではなく `failure:` にした。**

**理由**: これは「『無い』を『有る』にする改修」であり、**埋め忘れた経路は
「間違った *有る*」になる**——`failure` が付いていないから成功した、と読まれる。

⟹ **必須にすると TypeScript が全構築箇所を突きつけてくる。**それを使って数えた結果、
**書き込む経路は7本**あった（`catch` の1本ではない）:

| # | 経路 | 値 |
|---|---|---|
| 1 | `extractCandidates` 成功（0件を含む） | `null` |
| 2 | `extractCandidates` catch | `describeExtractionFailure(error)` |
| 3 | `handleMemoryUsage`（`extraction: "skipped"`） | `null` |
| 4 | `handleExtractableObservation` 冪等な再送の早期 return | `null` |
| 5 | `handleExtractableObservation` `deferred` の早期 return | `null` |
| 6 | `handleExtractableObservation` sync 経路の最終 return | `runExtraction` の結果 |
| 7 | `reextract` の3つの return（fallback / 候補0件 / 本経路） | `failure` / `null` / `null` |

### `ReextractResult` にも足す

`reextract` も `extractCandidates` を呼び、`llm_failed_whole_observation` を返す早期 return を持つ。
**片方にだけ運ぶと「片方は種類が分かるのにもう片方は分からない」という非対称ができる。**

---

## 検討した選択肢

- **`ExtractionOutcome` に `llm_refused_whole_observation` を足す**: 却下。上記の通り、
  網羅性チェックの無い分岐が黙って既定側へ落ちる。**区別を足すために既存の列挙を広げない。**
- **飲むのをやめて例外を伝播させる**: 却下。**ADR 0013 が明示的に却下した案そのものである。**
  安全弁（記憶を失うくらいなら受け取る）と正面から衝突する。
- **ログにだけ出す**: 却下。ADR 0008 / 0013 が同じ形の案を却下したのと同じ理由——
  **呼び出し側が実行時に次の一手を変えられない。**
- **`kind` を core 側の列挙型（`"refusal" | "truncated" | ...`）にする**: 却下。
  **core が provider の失敗の集合を知ることになる。**3つ目の provider が別の種類を持ったとき、
  core を直さないと運べなくなる。**`string \| null` の開いた集合のまま持つ**——
  `@mnemora/anthropic` の `refusalCategory` が「開いた集合だから文字列で持つ」としたのと同じ判断。
- **例外オブジェクトそのものを `ObserveResult` に載せる**: 却下。`Error` は構造化ログにも
  DB にもそのまま乗らず、公開 API に SDK 由来の形が漏れる恐れがある。**`kind` と `message` に絞る。**

---

## 結果（この決定が招くもの）

**良い面**: **provider が `kind` を付けて投げた失敗が、飲まれても呼び出し側から読める。**
拒否（同じ入力での再試行は無意味）と通信エラー（再試行すべき）が、実行時に区別できる。
`memory_events.meta.failureKind` により、**後追いでも監査ログから引ける。**

**引き受けた負債**:

1. **`kind` の値そのものは検証していない。**core は `"refusal"` という文字列が何を意味するかを
   知らない。**provider が名前を変えたら、呼び出し側の分岐が黙って外れる。**
   （両 provider の `kind` を1箇所で突き合わせる歯は無い——ADR 0072 負債1「provider の
   適合テストが存在しない」の一部である。）
2. **`ExtractionOutcome` は今も3値であり、`llm_failed_whole_observation` に6種が畳まれたままである。**
   **区別できるようになったのは `extractionFailure` を読んだ場合だけ**であり、
   `extraction` だけを見る既存の読み手（`examples/chat/src/retrieval-quality.ts`）は今も畳んだままである。
3. **失敗した抽出をやり直す運用の経路は、依然として無い**（ADR 0013 / 0028 の負債の継承）。
4. **本物の provider から core までを1本で通す歯は無い。**`packages/core` の実行時依存は
   zod だけなので、core のテストから provider パッケージを参照できない。
   ⟹ 通しの歯は**`kind` を名乗るエラーを throw する偽 provider** を `createRuntime` に注入する形になる
   （`extractCandidates` → `runExtraction` → `ObserveResult` の実経路は通る）。
   **本物の provider を使う版は `packages/openai` 側に置ける。この PR では置いていない。**

---

## これが覆るとしたら

- **`ExtractionOutcome` を分岐する箇所すべてに網羅性チェックが入ったとき。**
  そのときは「別の欄で運ぶ」ではなく「列挙を割る」が安全に選べるようになり、この決定を問い直せる。
- **呼び出し側が `kind` で実際に分岐し始めたとき。**そのとき負債1（値そのものが検証されていない）が
  効いてくる——両 provider の `kind` を突き合わせる適合テストが要る。
- **3つ目の provider が `kind` を名乗らない形で来たとき。**`null` が常態になるなら、
  `kind` を運ぶ設計の前提（provider が名乗る）が崩れる。

---

## 確かめていないこと

- **実 API を一度も叩いていない。**`OPENAI_API_KEY` は意図的に `env -u` で外して走らせた。
  ⟹ **実運用でどの `kind` がどの頻度で来るかは測っていない。**
- **6種が畳まれているという列挙は、コードの経路を追って作ったものであり、
  6種すべてを実際に発生させて確かめたわけではない。**
- **`examples/chat/src/retrieval-quality.ts` を `extractionFailure` を読む形へ更新していない。**
  読み手を増やすのはこの決定の範囲外とした（負債2）。
