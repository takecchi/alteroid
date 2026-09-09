# ADR 0077: インメモリのストアを `@mnemora/testkit/fixtures` から出す — **`index` からは出さない**

- **状態**: 採用 (2026-09)
- **日付**: 2026-09-09

**⚠ 各主張の出所を分ける。**「実測」と書いたものは、断りの無い限り**この作業でこの器から実行して取った**ものである。

---

## 問い

**本物の `OpenAILLMProvider` が拒否を `kind` 付きで投げたとき、それが `ObserveResult.extractionFailure.kind`
まで届くことを、通しで測りたい。**

[ADR 0076](./0076-extraction-carries-failure-kind.md) の負債4 がこう書いている——

> **本物の provider から core までを1本で通す歯は無い。**`packages/core` の実行時依存は
> zod だけなので、core のテストから provider パッケージを参照できない。

⟹ **その歯は `packages/openai` 側になら置ける。**しかし `runtime.observe()` を呼ぶには
`RuntimeDeps` の5つのストアが要る。**それをどこから調達するか。**

---

## 文脈

### 実測: 拒否の経路は「動くストア」を要求する

**読みでの推定ではなく、全プロパティを記録する `Proxy` を5つのストアに渡して実際に走らせて数えた。**

| 呼ばれたメソッド | 戻り値を使うか |
|---|---|
| `memoryStore.createObservationWithOutbox` | **使う**（分解代入している） |
| `tenantSettingsStore.getDefaultHalfLifeHours` | **使う** |
| `memoryStore.createMemoryWithOutbox` | **使う** |
| `eventStore.append` | 使わない |
| `outboxStore.complete` | 使わない |

**`vectorStore` と `embeddingProvider` は1度も呼ばれない。**

⟹ **全メソッドが `throw` する「振る舞いを持たない偽物」では通らない**——最初の
`createObservationWithOutbox` の戻り値の分解代入で落ちる（実測: `Cannot destructure property
'observation' of '(intermediate value)' as it is undefined.`）。

### ⚠ しかし、インメモリのストアは**意図的に**閉じられている

`packages/testkit/src/index.ts` の冒頭に、こう書いてある【逐語】:

> プレースホルダ実装（`__fixtures__`）は意図的にここから export しない。
> adapter 作者は自分の実装を `createStore` に渡して conformance suite を走らせる。

**同じ `__fixtures__` の中でも、*provider*（`Deterministic*` / `Recorded*`）は
「adapter パッケージから再利用されることを意図しており、意図的に export する」と明記して出ている。**

⟹ **ストアだけが、理由を持って閉じられている。**`package.json` の `exports` も
`"."` と `"./package.json"` だけであり、deep import も塞がれている（実測）。

### ⭐ 何が危ないのか

**この線を引いた理由は、閉じておかないと次が起こるからである:**

> **adapter 作者が、自分の実装ではなく `InMemoryMemoryStore` を `createStore` に渡して
> 適合スイートを走らせられる。**⟹ **自分の実装を1文字も測らないまま、緑を得られる。**

**⟹ これはこのリポジトリが繰り返し警戒してきた形そのものである**——
「歯が緑であること」と「測ったこと」を取り違える形（AGENTS.md の
「⚠ `deterministic` で測った想起の質は、性能について何も言っていない」、
ADR 0015 の「緑をそのまま『全部通った』と読まないこと」と同じ系列）。

---

## 決定

**`@mnemora/testkit/fixtures` という別の入口を足す。`index` からは出さない。**

1. `packages/testkit/src/fixtures.ts` を新設し、インメモリのストア5種だけを re-export する。
2. `packages/testkit/package.json` の `exports` に `"./fixtures"` を足す。
3. ⛔ **`src/index.ts` は1文字も変えない。**——「adapter 作者は自分の実装を渡せ」という宣言を弱めない。

**⟹ 適合スイートの正面玄関（`@mnemora/testkit`）からは、今までどおりストアは出てこない。**
`createStore` に渡すものを探して import 文を書く人が、**プレースホルダに行き当たらない**という性質は保たれる。

### ⚠ この決定が引き受ける危険を、隠さずに書く

**別の入口を足した以上、`@mnemora/testkit/fixtures` と書けば取れる。**
⟹ **「取れないから安全」ではなくなった。**危険は消えていない——**隔離されただけである。**

**⟹ だから `src/fixtures.ts` の冒頭に、その危険を名指しで書いた**
（「これを `createStore` に渡すと、自分の実装を1文字も測らないまま緑になる。
この入口はリポジトリ内のテストが `Runtime` を組み立てるためのものであり、
適合スイートの入力にしてはいけない」）。

**⚠ ただし、コメントは検査されない。**
⟹ **「そう書いたから安全である」とは主張しない。**この ADR が主張するのは
**「危険を承知のうえで、正面玄関を塞いだまま別口に隔離することで受け入れた」**ことだけである。

### 公開範囲について（実測）

`packages/testkit/package.json` の `files` は `["dist"]` であり、
**`dist/__fixtures__/in-memory-*.js` は既に tarball に入っている**（`tsc` が `src` を丸ごと出力するため）。

⟹ **この決定で増える tarball のバイトは 0 である。**変わるのは `exports` による**到達可能性**だけである。

---

## 検討した選択肢

- **`packages/openai` のテストの中に、最小の偽ストアを自分で書く**: 却下。
  **実測により、3つのメソッドの戻り値が実際に使われることが分かった**——「全部 `throw` する、振る舞いを
  1つも持たない偽物」では通らない。⟹ 振る舞いを持つ偽物を書くことになり、
  **適合スイートで検証済みの実装を、検証されない形で再実装することになる。**
  （**もし呼ばれるメソッドが0件、または戻り値を使わないだけだったなら、この案を採っていた**
  ——そのときは偽物が間違えようがなく、「拒否の経路はストアに1文字も書かない」という主張まで
  同じ歯で固定できたからである。実測がその条件を満たさなかった。）
- **`index.ts` からストアも export する**: 却下。**上の危険に正面から当たる。**
  正面玄関を開けると、`createStore` に渡すものを探している人の目に入る。
- **`examples/chat` に置く（本物の Postgres で通す）**: 却下。
  追加の依存は0で、ストアも本物になるが、**`DATABASE_URL` が要るため毎回の
  `pnpm run test` では走らない**（ADR 0015）。**拒否の伝播は DB と無関係であり、
  DB 門に括り付けると、DB を持たない手元でこの主張が測られなくなる。**
- **`packages/testkit` の側にこの歯を置く（testkit が `@mnemora/openai` に依存する）**: 却下。
  **依存の向きが逆になる。**testkit は adapter を検査する側であり、特定の adapter に依存させない。

---

## 結果（この決定が招くもの）

**良い面**: **本物の provider から `ObserveResult` までを1本で通す歯が、`DATABASE_URL` 無しで、
毎回の `pnpm run test` で走る。**ADR 0076 の負債4 が返済される。

**引き受けた負債**:

1. **危険は消えていない。隔離されただけである**（上記）。
   **`@mnemora/testkit/fixtures` を `createStore` に渡すことを、機械的に禁じる歯は無い。**
2. **プレースホルダが公開 API になった。**`InMemoryMemoryStore` 等の振る舞いを変えると、
   **リポジトリ外の利用者を壊しうる。**これまでは内部実装だった。
3. **`packages/openai` が `@mnemora/testkit` に devDependency を持った。**
   循環はしない（testkit の依存は `@mnemora/core` だけ）が、**パッケージ間の線が1本増えた。**
4. **この歯が使うストアは、本物の DB ではない。**`packages/postgres` に対して同じ通しを測ってはいない。

---

## これが覆るとしたら

- **`@mnemora/testkit/fixtures` を `createStore` に渡した適合スイートが、実際に現れたとき。**
  そのときは「コメントで注意する」では足りない——**適合スイート側でプレースホルダを検出して拒む**
  形が要る（負債1）。
- **provider の適合テストが `packages/testkit` に入ったとき**（ADR 0072 負債1）。
  そのときこの歯は適合スイートへ引き上げられ、`packages/openai` の中に置く理由が消える。
- **`packages/core` の依存境界の規律が変わったとき。**core から provider を参照できるなら、
  この歯は core 側に置けて、testkit の入口を増やす必要が無かったことになる。

---

## 確かめていないこと

- **実 API を一度も叩いていない。**偽の HTTP client に拒否応答を返させているだけである。
  ⟹ **「実 API が本当にこの形を返す」ことは、この歯も確かめていない**（ADR 0075 と同じ限界）。
- **`@mnemora/testkit/fixtures` を publish 後に実際に import できることを確かめていない。**
  確かめたのは、この monorepo の中で `exports` を通して解決できることだけである。
- **プレースホルダのストアが、`packages/postgres` の実装とどこまで同じ振る舞いをするかは、
  適合スイートが測る範囲までしか分かっていない。**
