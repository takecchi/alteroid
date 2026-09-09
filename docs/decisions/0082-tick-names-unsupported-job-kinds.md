# ADR 0082: `tick` が処理できない kind を、`failed` の中に埋めない — 「無い」の種類を潰さないを、outbox の側でも守る

- **状態**: 採用 (2026-09)
- **日付**: 2026-09-10

**⚠ 各主張の出所を分ける。**「私が実行して確かめた」と「読んだだけ」と「人から受け取った前提」を
混ぜない（[AGENTS.md](../../AGENTS.md)）。

---

## 文脈

### 出発点は、外部の採用検討者からの報告（issue #105）

mnemora にとって**初めての外部からの実利用フィードバック**である。報告の芯は2つあった。

1. **`OutboxJobKind` に `"consolidate"` / `"reflect"` が名指しで在るのに、`tick` に分岐が無い。**
   報告者は「型に釣られて実装済みだと判断しかけた」と書いている。
2. **推測として**（報告者自身が「誤読なら申し訳ありません」と添えている）:
   `tick(ctx, { leaseMs, kinds: ["consolidate"] })` と明示すると `claimBatch` は claim
   **できてしまう**一方、処理する分岐が無いので**何も起こらないまま lease が切れる**のでは。
   もしそうなら「claim され続けるがいつまでも進まない」「呼び出し側から区別が付かない」。

### 🔴 2 は現物では起きていなかった（走らせて確かめた）

**推測のまま扱わず、`main`（`d2ec8cf`）で実際に走らせた。**
`FakeOutboxStore`（`packages/core/src/__tests__/runtime-fakes.ts`）を実体に、
`consolidate` の outbox 行を1件積んでから `tick` を呼び、`TickResult` と outbox 行の
全列を出力させた。**測った値そのまま**:

| 呼び方 | `TickResult` | outbox 行 |
|---|---|---|
| `tick(ctx, { kinds: ["consolidate"], leaseMs })` 1回目 | `{ processed: 0, failed: 1 }` | `claimedAt` あり / `attempts: 1` / **`failedAt` あり** / `lastError: "runtime.tick: unknown outbox job kind: consolidate"` |
| 同 2回目 | `{ processed: 0, failed: 0 }` | 変化なし（**再 claim されない**） |
| `tick(ctx, { leaseMs })`（既定の `kinds`） | `{ processed: 0, failed: 0 }` | **無傷**（`claimedAt: null` / `attempts: 0`） |

⟹ **「何も起こらないまま lease が切れる」は起きない。**`main` の `tick` は既に
`else { throw new Error("runtime.tick: unknown outbox job kind: ...") }` を持ち、
それが `catch` されて `outboxStore.fail()` に落ち、`failed` に数えられていた。
`fail` は終端なので（ADR 0032）再 claim もされない。
**このコードとその歯は Phase 1 最初期（`ab693b1`, PR #4）から在る。**

⟹ **報告の3案のうち「案1（未対応の kind を明示的に失敗させる）」は、既に実装済みだった。**

### では何が欠けているのか — **`failed` という1つの数が、2種類の失敗を同じ顔にしている**

残った欠陥はこれである。呼び出し側が `TickResult` から読み取れるものを並べる:

| 起きたこと | `TickResult`（`main`） |
|---|---|
| そもそも該当する kind のジョブが無かった | `{ processed: 0, failed: 0 }` |
| **embed の provider が落ちて失敗した** | `{ processed: 0, failed: 1 }` |
| **`tick` がその kind を処理できなかった** | `{ processed: 0, failed: 1 }` |

**下の2つが同じである。**しかし呼び出し側が次に取る手は違う——前者は provider を直して
`reembed()`（ADR 0079）、後者は**そもそも `tick` に頼む相手が違う**（本体がまだ無い、
あるいは自分の worker で処理すべき kind を `tick` に渡してしまった）。

これは [ADR 0008](./0008-absence-taxonomy.md)（「無い」を分類して返す）が `recall` の側で
決めたことの、outbox 側での破れである。同じ族の欠落を、この repo は
[ADR 0011](./0011-no-window-count-in-ann-stage.md) /
[ADR 0025](./0025-ann-underfill-is-not-reported-in-omitted.md) /
[ADR 0027](./0027-split-superseded-forgotten-omission.md) /
[ADR 0028](./0028-reextract-superseded-cleanup.md) で4回破っており
（[ADR 0032](./0032-outbox-claim-lease.md) の数え方に従う）、
[ADR 0029](./0029-reextract-skip-visibility.md) は `reextract` で**まったく同じ形**
（3つの理由が `supersededMemoryIds: []` という同じ顔になっていた）を塞いでいる。

### もう1つの根 — **「tick が何を処理するか」が3か所に写されていた**

`main` では次の3つが**別々に**「extract と embed」を主張していた。

1. `OutboxJobKind` の名指しの列挙（`consolidate` / `reflect` も並ぶ）
2. `tick` の claim 既定値 `opts.kinds ?? ["extract", "embed"]`
3. `if (job.kind === "extract") … else if (job.kind === "embed") …` の分岐

**3つは独立に動く。**だから 1 だけが先に `consolidate` を持ち、2 と 3 が持たない状態が
生まれ、報告者はそれを読んで誤読した。**issue #105 の根はこの複製である。**

### ⚠ 前提の変化（受け取った前提。私は確かめていない）

作業の途中で、**`consolidate` / `reflect` の本体は近いうちに実装される**という
オーナーの決定（2026-09-09）を受け取った。**この ADR は「Phase 1 のあいだだけの暫定」を
決める場ではなくなった**——置くものは、**kind が増えたあとも効き続ける機構**でなければならない。

---

## 決定

### 1. `TickResult` に `unsupported` を足す（`failed` の意味は変えない）

```ts
export interface UnsupportedOutboxJob {
  jobId: string;
  kind: OutboxJobKind;
}

export interface TickResult {
  processed: number;
  failed: number;
  unsupported: UnsupportedOutboxJob[];
}
```

- **`unsupported` に入ったジョブは `failed` にも数える。**`failed`（この tick で終端の
  失敗になった件数）の意味は動かさない。`unsupported` はその**内訳**である。
- **空配列が既定で、`undefined` にはならない。**「出なかった」と「見ていない」を
  同じ顔にしないため（ADR 0008 の `countKind` と同じ理由）。
- **件数の欄は持たない**（配列そのものが件数を持つ。ADR 0029 の `ReextractSkip` に倣う）。
- `jobId` を載せるのは、**どの outbox 行が終端で焼かれたかを呼び出し側が名指しできる**ため。

### 2. `fail()` で終端に落とすことは変えない

claim したまま何もしないと lease が切れて再び claim される——**それこそが報告者の恐れた
「claim され続けるがいつまでも進まない」**である。`fail` の終端性（ADR 0032）は覆さない。
`last_error` には `UNSUPPORTED_KIND_ERROR_PREFIX + kind` を書く——`TickResult` を
捨ててしまった後から **DB の行だけを見た運用者**にも同じ結論が届く二の路として。

### 3. 🔴 `TICK_SUPPORTED_JOB_KINDS` を唯一の出所にし、**型検査で結ぶ**

```ts
export const TICK_SUPPORTED_JOB_KINDS = ["extract", "embed"] as const;
export type TickSupportedJobKind = (typeof TICK_SUPPORTED_JOB_KINDS)[number];

const jobHandlers: Record<TickSupportedJobKind, JobHandler> = {
  extract: processExtractJob,
  embed: processEmbedJob,
};
```

- claim の既定値は `opts.kinds ?? [...TICK_SUPPORTED_JOB_KINDS]`。
- 分岐は `if/else if` の連鎖をやめ、`jobHandlers` を引く形にした。
- ⟹ **上記「3か所の複製」が1か所になり、ずれが型検査で止まる。**
  **これを実測した**（下の「測ったこと」§2）: 一覧に kind を足してハンドラを足し忘れても、
  逆にハンドラだけ足しても、`tsc` が落ちる。

### 4. `OutboxJobKind` の JSDoc に「名前が在ること ≠ `tick` が処理すること」を書く

**⚠ そこで一覧を数え直さない。**「Phase 1 では extract / embed のみ」と書くと、
`consolidate` の本体が入った瞬間に**黙って嘘になる**。**コメントは検査されない。**
だから JSDoc は `TICK_SUPPORTED_JOB_KINDS` を**指すだけ**にした。

### 5. 歯を「恒久」と「時限式」に分けて置く

- **恒久の歯（4本）**は、利用者が独自に足した kind（`"gurumi-chan:notify-slack"`）で測る。
  この kind が `TICK_SUPPORTED_JOB_KINDS` に入ることは無い ⟹ **kind がいくつ増えても効き続ける。**
- **時限式の歯（2本）**は `"consolidate"` / `"reflect"` を名指しで測る。
  **本体が入ったら赤くなる。それが正しい。**赤くなったら「壊れた」のではなく
  「この歯が役目を終えた」合図であり、**本体を足す側がこの歯を書き換えるところまでがその作業**である。
  ⟹ 散文の代わりに**検査される仕掛け**で、時限的な主張を保持している。

---

## 採らなかった案

### 案A: `OutboxJobKind` から `"consolidate"` / `"reflect"` を外す（報告者の案2）

**採らない。**理由は2つ。

1. 型を狭めるので、既に `"consolidate"` を書いた利用者のコードを壊す。
2. **外したものを、すぐ戻すことになる**（本体の実装が決まっている。上の「前提の変化」）。
   ⟹ 型が2回動き、そのたびに利用者が追随する。

### 案B: JSDoc に「Phase 1 では `tick` が処理するのは `extract` / `embed` のみ」と一行入れるだけ（報告者の案3、単独で）

**採らない。**報告者の読み違え（芯1）は確かにこれで防げるが、
**`failed` が2種類の失敗を同じ顔にしている**（芯の残り）が残る。
そして**その一行は本体が入った瞬間に嘘になり、誰も落ちない。**
⟹ 決定4 として「一覧を数え直さず出所を指す」形に変えて取り込んだ。

### 案C: `opts.kinds` を `tick` の入口で検査し、対応していない kind が在れば**claim する前に throw する**

**魅力はある**——ジョブを1件も焼かずに、呼び出し側の手元で同期的に落ちる。
`consolidate` の行を終端で焼かないので、本体が入るまで積んでおける。

**それでも採らない。**理由は2つ。

1. **公開 API の破壊的変更である。**いま `{ processed: 0, failed: 1 }` を受け取っている
   呼び出し側が例外を受けるようになる。[docs/autonomy.md](../autonomy.md) §3 は
   「公開 API の破壊的変更は**提起までにする**。ADR を書き、実装は別 PR にして、承認を待つ」
   と定めている。**この PR では提起にとどめる。**
2. `(string & {})` の開いたユニオンで「利用者が独自に足した kind」を受ける設計と、
   相性を確かめていない。**`tick` に渡した以上「処理してほしい」の意思表示だ**という
   読みは成り立つが、**私はそれを利用者に当てて確かめていない。**

⟹ **オーナーへ差し戻す問い**: 「対応していない kind を渡された `tick` は、
ジョブを焼く前に落ちるべきか」。採るなら別 PR。

### 案D: `unsupported` を `failed` から除く（`failed` を「試して失敗した数」に狭める）

**採らない。**`failed` の意味が変わるので、`failed > 0` を見ている呼び出し側の判断が
黙って変わる。`unsupported` を**内訳**にしておけば、既存の読み方は壊れない。

### 案E: `unsupported` を「空なら省略」の任意欄（`unsupported?:`）にする

**採らない。**既存の `toEqual({ processed, failed })` を書き換えずに済むという利点は在るが、
**「出なかった」と「見ていない」が `undefined` という同じ顔になる**——
いま塞いでいる穴を、別の場所に開け直すことになる。

---

## 引き受けた負債

### 1. 🔴 `TickResult` に必須の欄が増えたのは、**adapter/利用者にとって破壊的でありうる**

- **読む側は壊れない**（構造的部分型。`.processed` / `.failed` を読むコードはそのまま動く）。
- **壊れうるのは2種類**: (a) `TickResult` を**自分で構築**する側（`Runtime` を自前実装する等。
  **このリポジトリ内には0件**——`implements Runtime` / `: Runtime =` を全 package と
  `examples/` に当てて確認した）、(b) `expect(result).toEqual({ processed, failed })` と
  **完全一致で書いた利用者のテスト**。(b) は避けられない。
- ADR 0029（`ReextractResult.skipped` の追加）・ADR 0076（`extractionFailure` の追加）と
  **同じ族の変更**であり、この repo はそれを採ってきた。

### 2. 時限式の歯は、**本体を足す側の手を1つ増やす**

`consolidate` / `reflect` の本体を実装する人は、`TICK_SUPPORTED_JOB_KINDS` に kind を足し、
ハンドラを足し（ここまでは型検査が強制する）、**さらに時限式の歯を書き換える**必要がある。
**これは意図した負担である**——コメントで同じことを書くと、誰も落ちずに嘘が残る。
歯の本文に「赤くなったら役目を終えた合図である」と明記した。

### 3. 実測は `packages/core` の fake に対してのみ行った

`FakeOutboxStore` に対して測った。**本物の `PostgresOutboxStore` では走らせていない**
（この環境に `DATABASE_URL` が無い）。ただし `fail` の終端性と `kinds` の絞り込みは
`packages/testkit/src/outbox-store-conformance.ts` の適合テストが
**本物の Postgres に対して**測っている契約であり（CI の DB ジョブ）、
そこに依存する形で書いてある。**「本物でも同じ」は契約からの推論であり、私の実測ではない。**

### 4. `last_error` の文言を変えた

`"runtime.tick: unknown outbox job kind: "` → `"runtime.tick: unsupported outbox job kind: "`。
文字列そのものを契約として名乗ったことは無いが、**この文字列で grep している運用者が居れば壊れる。**
定数（`UNSUPPORTED_KIND_ERROR_PREFIX`）として公開し、歯がそれを名指しで測る形にした。

---

## これが覆るとしたら

- **案C（claim 前に throw）をオーナーが採ったとき。**`unsupported` は残るが、
  「明示的に渡した未対応 kind」はそこへ到達する前に落ちるようになり、
  `unsupported` が拾うのは「adapter が要求していない kind を返してきた」場合だけになる。
- **`fail` に自動リトライが入ったとき**（ADR 0079 の案B。「永久に採らない、ではない」）。
  終端でなくなるなら、決定2 の前提（焼かないと再 claim される）が変わる。
- **`OutboxJobKind` を閉じたユニオンにしたくなったとき。**そのときは
  `TICK_SUPPORTED_JOB_KINDS` と型の関係を作り直す必要がある。

---

## 測ったこと

### 1. `main` での `tick(ctx, { kinds: ["consolidate"] })` の実測

上の「文脈」の表がそれである。**報告者の推測（何も起こらないまま lease が切れる）は
現物では起きていなかった。**

### 2. 型検査が「一覧とハンドラのずれ」を止めることの実測

| 変異 | `tsc` |
|---|---|
| `TICK_SUPPORTED_JOB_KINDS` に `"consolidate"` を足し、ハンドラを足さない | ❌ `TS2741: Property 'consolidate' is missing … but required in type 'Record<"extract" \| "embed" \| "consolidate", JobHandler>'` |
| ハンドラに `consolidate:` を足し、一覧に足さない | ❌ `TS2353: Object literal may only specify known properties, and 'consolidate' does not exist in type 'Record<"extract" \| "embed", JobHandler>'` |

⟹ **どちらの向きのずれも、コンパイル時に止まる。**

### 3. 変異試験 — 撃った6つのうち5つが噛み、1つは**等価変異**（緑のまま）だった

| # | 壊した箇所 | 結果 | 赤くなった歯 |
|---|---|---|---|
| M1 | `unsupported.push(...)` を消す | ❌ **9 failed** / 46 passed | 恒久7本 + 時限式2本 |
| M2 | 未対応 kind に対する `fail()` を消す | ❌ **1 failed** / 54 passed | 「黙って lease 切れを待たない」 |
| M3 | claim の既定を `opts.kinds`（＝全 kind）にする | ❌ **1 failed** / 54 passed | 「頼まれていない kind は claim すらしない」 |
| M4 | 未対応 kind の `failed += 1` を消す | ❌ **8 failed** / 47 passed | 恒久6本 + 時限式2本 |
| M5 | **ハンドラ表を引くのをやめ、元の `if/else if` の連鎖に書き戻す** | ✅ **55 passed（緑のまま）** | — |
| M6 | ハンドラの索引を `Map` からプレーンなオブジェクトに戻す | ❌ **4 failed** / 51 passed | 「`constructor` / `toString` でも取り違えない」4本 |

**M5 が「赤くなってはいけない変異」である。**ふるまいを変えずに実装の形だけを
`main` の書き方へ戻した。**緑のままだった**⟹ この節の歯は**実装の形を固定していない**。
（形のほうを固定しているのは型検査であり、それは §2 で別に測ってある。）

### 4. 🔴 報告に無い穴を、実装を読み返して1つ見つけた（`kind: "constructor"`）

ハンドラの索引を**プレーンなオブジェクト**で書いていたとき、`job.kind` が
`"constructor"` / `"toString"` / `"__proto__"` / `"hasOwnProperty"` だと
`Object.prototype` 側の関数が返る。⟹ **「対応している」と誤判定して呼ぶ。**
`kind` は DB の `text` 列から来る任意の文字列であり（`outbox.kind` に CHECK 制約は無い。
`packages/postgres/migrations/0001_init.sql`）、`OutboxJobKind` は開いたユニオンなので
**型でも止まらない**。

```
o["constructor"] = function
o["toString"]    = function
```

⟹ 索引を `Map`（prototype を持たない）に変え、4語を名指しで測る歯を置いた。
**M6 がその歯を撃って、赤くなることを見た**（他の51本は緑のまま＝狙った経路だけを測っている）。
**6つの変異はすべて最終形のコードに対して撃ち直した数字である**（歯を足す前の数字と混ぜていない）。

⚠ **これは報告者が挙げた穴ではない。**この PR で書いたコードを読み返して見つけたものであり、
`main` にこの穴は無かった（`main` は `if/else if` の連鎖だった）。
**自分が開けかけた穴を、出す前に塞いだ記録として残す。**

---

## 確かめていないこと

- **本物の Postgres に対して走らせていない**（負債3）。手元に `DATABASE_URL` が無い。
  **CI の DB ジョブが見届ける。**
- **`consolidate` / `reflect` の本体が実装されたときに、時限式の歯が実際に赤くなるところを
  見ていない**（本体がまだ無いので当然だが、**見ていないことは見ていない**）。
  型検査が落ちること（§2）は測ったが、それは歯とは別の機構である。
- **報告者（the-phage-dev）が `unsupported` を実際に使って読み違えなくなるか**は確かめていない。
  読み違えの解消は issue へ返す形で確かめる必要がある。
- **案C（claim 前に throw）が利用者にとって過剰かどうか**を、利用者に当てて確かめていない。
