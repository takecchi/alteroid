# ADR 0073: digest 帯を実装する — taxonomy は要らなかった。上限は3つ持つ

- **状態**: 採用 (2026-09)
- **日付**: 2026-09-09

**⚠ 各主張の出所を分ける。**「私が実行して確かめた」と「人から受け取った前提」と「推測」を混ぜない。
本 ADR で「実測」と書いたものは、断りの無い限り**この作業者がこの器で実行して取った**ものである。

---

## 問い

### オーナーの指示（出所: 人から受け取った。逐語）

> **1件1行の要旨を出す機能は「次の段階」として未実装なのであれば実装するべきです。実装してください。**

指しているのは `IndexBand.digestBand` である。**リポジトリを横断して確かめた**（`grep -rn "Phase 2" packages/ examples/`）——
「Phase 1 では常に undefined」と注記された「1件1行の要旨」は `digestBand` だけであり、
他の Phase 2 マーカーは関係グラフ・`contested` の生成主体・`valid_from`/`purged_at` 列・
`decay_floor_at` の読み取り開始で、いずれも要旨ではない。

### ⚠ そして、送り先が Phase 2 だった理由が書かれていた

[docs/recall.md](../recall.md) §5「Phase 1 の範囲」（逐語）:

> **Phase 1 では第3階(群カウント)のみを実装する。digest 帯(第2階)は Phase 2 に送る。**
> 理由は、**digest 帯が taxonomy(分類語彙)を要する**のに対し、群カウントは `subject` 単位だけでも
> 成立するからである。

同旨が [docs/roadmap.md](../roadmap.md) §1.2 の表にも在る:

> digest 帯は taxonomy（ラベルの語彙管理）を要求するが、群カウントは subject 単位の集計だけで成立する。

**taxonomy の実体（`labels` / `memory_labels`）は Phase 2 であり、Phase 1 に存在しない**
（[docs/memory-model.md](../memory-model.md) §8）。**したがって、この理由が正しいなら
digest 帯は taxonomy を待たねばならず、オーナーの指示は実行できない。**

**本 ADR が最初に割ったのは、この点である。**

---

## 決定

### 1. **「digest 帯は taxonomy を要する」は理由の記述の誤りだった。訂正する**

**要さない。**根拠は4つあり、いずれも現物で確かめた。

1. **`docs/recall.md` §5 の同じ文の後半が、taxonomy が要る対象を限定している**（逐語）:

   > **`taxonomy` 軸によるグルーピングは**、taxonomy の `registered` / `proposed` 状態を扱う
   > 必要があり、digest 帯と合わせて Phase 2 に含める。

   要るのは**グルーピング**のほうである。

2. **`DigestEntry` は `axis` を持たない。**`{ memoryId, digest }` だけであり、
   `axis: 'subject' | 'taxonomy' | 'time_window'` を持つのは `GroupCount` のほうである
   （`packages/core/src/recall.ts`）。**型に taxonomy への依存が1つも無い。**

3. **`digest` は Phase 1 の `memories` 列であり、`NOT NULL` である**
   （`packages/postgres/migrations/0001_init.sql`）。`labels` / `memory_labels` とは
   別テーブル・別軸であり、`packages/postgres/src/mapping.ts` は `digest: row.digest` と
   素通しで返している。**schema も migration も変更せずに帯を作れる。**

4. **`docs/roadmap.md` §3 の Phase 2 の表自身が、追加の安全性を述べている**（逐語）:

   > 第3階のカウントと `omitted.kind = 'filtered'` の仕組みがあるため、
   > **digest 帯を追加しても「0件でも何が在るかは言える」保証は壊れない。**

**⚠ 訂正の形**: `docs/recall.md` §5 と `docs/roadmap.md` に訂正の注記を足す。
先例は `docs/memory-model.md` §8 の「**⚠ 2026-09 訂正（roadmap.md 段階4/5 の実装 PR）:
「フィルタ・加点に参加しない」という記述は誤りだった。**」であり、同じ形式を採る。

### 2. ⛔ **Phase 1 / Phase 2 の線そのものは動かさない**

**オーナーが名指ししたのは「1件1行の要旨を出す機能」1つである。**
したがって:

- **`digest 帯は Phase 2` という区分そのものは消さない。**「オーナーの指示によりこの1つだけ
  前倒しで実装した」と書く。
- **他の Phase 2 の項目は前倒しされていない**ことを、文書に明記する。
  `taxonomy` 軸によるグルーピング・`labels` / `memory_labels`・関係グラフ本体は Phase 2 のままである。

**1つの機能が前に出ただけで、線は動いていない。**

### 3. 帯が並べるのは「**返さなかったもの**」である

**これがこの機能の芯であり、他のすべての判断がここから出る。**

`docs/recall.md` §5 の三階建て（逐語）:

> recall のスコープ内にある全ての Memory は、返り値の中に **(1) 全文 / (2) digest 1行 /
> (3) それが属する群の件数** のいずれかで必ず現れる。

**⚠ Phase 1 は (1) 全文を実装していない。**現物で確かめた——`RecalledMemory` に `content` 欄が
無く（`packages/core/src/recall.ts`）、`RecallUsage.byTier.full` はリテラルの `0` である
（`packages/core/src/recall-runtime.ts`）。

**したがって `RecalledMemory.digest` は第1階ではなく、第2階の「返したもの側の半分」である。**
**`digestBand` は同じ第2階の「返さなかったもの側の半分」であり、欠けていたのは階ではなく半分である。**

**この整理から、実装の制約が自動的に出る**——帯に `memories` として返した Memory を並べては
ならない。それは既に `RecalledMemory.digest` が持っており、帯に入れると
**「在るが返していない」を名乗るという唯一の役割が消える。**

### 4. 上限は**3つ**持つ。件数・文字数・1件あたりの長さ

```
DEFAULT_DIGEST_BAND_LIMIT      = 50     （件数。呼び出し側が上書きできる）
DIGEST_BAND_MAX_CHARS          = 4000   （帯全体の文字数。呼び出し側からは変えられない）
DIGEST_BAND_MAX_ENTRY_CHARS    = 120    （1件の digest の長さ。呼び出し側からは変えられない）
```

**なぜ3つ要るか。それぞれが違う壊れ方を止めているからである。**

#### (a) 上限が無い帯は正典違反である

`docs/recall.md` §5（逐語）:

> 1テナントが100万件の Memory を持ちうる設計で、**digest 1行ずつでもプロンプトに載せれば
> 数十万文字になる。**（…）そこで第3階(群カウント)を導入する。

> alteroid の目次には**エントリ数の上限(300件)がある。規模で壊れる経路が既にコード上に見えている。**

**「どう抑えるか」は設計の余地ではなく、正典が要求している制約である。**
**そして上限で切っても被覆不変条件は壊れない**——切られたものは第3階の群カウントに乗り続ける。
**三階建てはそのために在る。**

#### (b) 🔴 件数だけでは閉じない —— `digest` には長さの上限が無い

**これは実装に入る前に現物で見つけた穴である。**

- **`memories.digest` 列に長さ制約が無い**（`CHECK` も `varchar(n)` も無く、`NOT NULL` のみ。
  `packages/postgres/migrations/0001_init.sql` および 0002〜0005 を確認）。
- **`resolveDigest`（`packages/core/src/extraction.ts`）が切るのはフォールバック経路だけである。**
  LLM が digest を返した場合（`digestSource: 'llm'`）、**長さの上限は1つも掛かっていない。**

⟹ **件数を N に固定しても、1件が10,000字なら帯は10万字になる。**
⟹ **そして目次帯は `budget` の対象外なので、呼び出し側にはこれを防ぐ手段が無い**（決定5を見よ）。
⟹ **機能が入った瞬間に、予算の外側が無制限になる。**後から気づく類のものではない。

**だから `DIGEST_BAND_MAX_CHARS`（帯全体）と `DIGEST_BAND_MAX_ENTRY_CHARS`（1件）を持つ。**

#### (c) 文字数だけでも足りない

1件が病的に短い場合（極端には1字）、文字数予算は件数を止めない。
`DEFAULT_DIGEST_BAND_LIMIT` はそこの裏止めである。**実際に効くのはその場合だけである**（下の「測ったこと」）。

#### (d) 値の根拠

- **4000**: 現行の目次帯（群カウントのみ）の `JSON.stringify` 長は **126字**（実測）。
  4000字はその約32倍であり、`heuristic` counter（`Math.ceil(chars/4)`、逐語確認）で約1,000トークン。
  **これは予算の外側に常時載る量である。**この水準を上限として選んだのはオーナー代理の判断であり、
  **強い根拠のある値ではない。**
- **50**: 実測の典型（後述 L≈18.7）では文字数予算が先に効き、**約48件で止まる。**
  50 はそのすぐ上に置いた裏止めであり、**「病的に短い digest ばかりのとき」にだけ発火する。**
- **120**: **⚠ 根拠が無い。**下の「引き受けた負債」を見よ。

### 5. 呼び出し側が渡せるのは件数だけ。そして `0` は渡せない

`RecallQuery.digestBandLimit?: number` を `z.number().int().positive()` で受ける。
**`DIGEST_BAND_MAX_CHARS` と `DIGEST_BAND_MAX_ENTRY_CHARS` は `RecallQuery` に置かない。**

理由は `docs/recall.md` §6 の一文にある（逐語）:

> 目次帯の唯一の存在理由は**「recall が0件でも、何が在るかは言える」**ことである。
> これを予算の対象にすると、**呼び出し側が渡した数字ひとつでその保証が消える。
> 予算次第で消える保証は、保証ではない。**

**`positive()` はこの一文を型で満たす。**上げ下げはできるが、**消せない。**
先例は2つあり、どちらもこのリポジトリの既存の作法である——
`RecallQuery.limit`（`positive()` であり 0 を受け付けない）と、
`scoreThreshold`（doc コメントが「本 PR の裁量として、既定値を置く（…）呼び出し側が上書きできる」と述べる）。

**そして文字数の上限を呼び出し側から外せないことにより、`digestBandLimit` にどれだけ
大きい値を渡されても帯は約4,000字を超えない。**

### 6. 「どの上限で切れたか」を名乗る。ただし**2階建てにする**

```ts
type DigestBandLimitedBy = "entry_limit" | "char_budget" | "both";

interface DigestBandCoverage {
  shown: number;
  eligible: number;
  countKind: CountKind;
  limitedBy?: DigestBandLimitedBy;
}
```

- **`IndexBand.digestBandCoverage` 自体が無い** ＝ 帯を作っていない
- **`digestBandCoverage` は在るが `limitedBy` が無い** ＝ 作ったが、どの上限にも当たらなかった

**この2つを1つの値に潰さないのは、`docs/recall.md` §4 / [ADR 0008](./0008-absence-taxonomy.md) の
「『無い』の種類を潰さない」の適用である。**`'none'` というリテラルを足さずに、型の入れ子で区別している。

**`"both"` を持つ理由**: 次の1件を足すと件数も文字数も同時に超える、という状態が実在する。
**上限が3つ在って「切られた」としか言えないのは、`omitted` を1つの `kind` に潰すのと同じ誤りである**
（ADR 0008 の判定基準——その区別があると呼び出し側の次の一手が変わるか——に照らすと**変わる**。
`entry_limit` なら `digestBandLimit` を上げれば増える。`char_budget` なら上げても増えない）。

**⚠ 正直に書く: 2階建ての片方は、いまは到達不能である。**
Phase 1 の段5は必ず実行される（`stages.push({ stage: "index_band", executed: true })` が
無条件である）ため、**`digestBandCoverage` が省略される状態を作る経路は現在の実装に無い。**
型としてこの区別を残しているのは、(a) `StageSkippedOmission.stage` に既に `'index_band'` が
在り「目次帯が出せなかった」という状態が型としては想定されていること、
(b) 帯を組まない別実装（将来の adapter）がありうること、による。
**「区別が在る」ことと「その区別が今どちらの側にも出る」ことは別であり、後者はまだ無い。**

### 7. 帯は `aggregateScope` の**同じ集約1本**から取る

`ScopeAggregate` に `digests` と `digestEligible` を足し、`MemoryStore.aggregateScope` に
任意の第3引数 `AggregateScopeOptions` を足す。**別メソッド・別クエリにしない。**

理由は `ScopeAggregate` の既存の doc が述べているとおりである（逐語）:

> **件数はすべてこの集約1本から取る**（…）別々のクエリではなく同一の集約クエリから得ることで、
> 書き込みが並行して起きていても「群カウントと totalInScope の総和が一致する」という
> 被覆不変条件が構造的に崩れない。

**帯を別クエリにすると、群カウントと帯が別スナップショットになる。**
また `aggregateScope` は既にテナントの行を `GROUP BY subject_id` で全走査しており
（`LIMIT` 無し）、**同じ走査に相乗りさせれば費用の桁は増えない。**

### 8. `explain.stages` の `detail` には件数を足さない

段5は既に `detail: { totalInScope }` を出しているが、**そこに帯の件数を重ねない。**
`detail` は `Record<string, unknown>` で型が無く、**`digestBandCoverage` と同じ意味の件数を
2箇所に置くと、[ADR 0011](./0011-no-window-count-in-ann-stage.md) が避けた
「複数の経路から同じ意味の件数を出すと食い違う」形になる。**

---

## 測ったこと

**⚠ すべてこの器で実行して取った。実 API（課金の出る LLM / 埋め込み）は1回も叩いていない。**

### 実 digest の長さは測れなかった

**リポジトリ全体を横断して、実 LLM が生成した digest の現物は2件しか無い**——
`docs/decisions/0051-recorded-provider-cassette.md` の
「来月京都へ出張する予定がある。」（15字）と「来月、京都へ出張する。」（11字）。

**`examples/chat/cassettes/*.json` に `digest` フィールドは0件である。**
`ExtractedMemoryCandidateSchema.digest` が `optional()` であり、記録セッションの実 LLM が
返していない（か、記録側が拾っていない）。

**代わりに、cassette の実 `content` に `resolveDigest` のフォールバック規則を適用した導出値**
（n=84。⚠ 実 digest の実測ではない）:

| n | min | p50 | mean | p75 | p90 | p95 | p99 | max |
|---|---|---|---|---|---|---|---|---|
| 84 | 6 | 18 | 18.70 | 22 | 26.7 | 28 | 31.51 | **34** |

**200字超は0件**であり、フォールバックの切り詰めは一度も発火していない。

### 帯の費用の式（実測）

`JSON.stringify` の差分を実際に取って確かめた:

```
1エントリ  = 63 + L 字   （{"memoryId":"<36字uuid>","digest":"..."} の実測。L は digest の長さ）
帯の追加分 = 15 + N × (64 + L) 字   （配列の区切りカンマと "digestBand": キーを含む）
トークン概算 = ceil(chars / 4)   （heuristicTokenCounter の実装そのまま）
```

**現行の目次帯（群カウントのみ）の `JSON.stringify` 長は 126字**（群が空なら 50字）。

### 上限3つが実際にどう効くか

| 場合 | L | 1件あたり | 載る件数 | 帯の文字数 | `limitedBy` |
|---|---|---|---|---|---|
| 実測の典型 | 18.7 | 82.7 | 約48件 | 約4,000字 | `char_budget` |
| 1件上限まで長い | 120 | 184 | 約21件 | 約4,000字 | `char_budget` |
| 病的に短い | 1 | 65 | 50件 | 約3,250字 | `entry_limit` |

⭐ **`L` は実測していない。しかし `DIGEST_BAND_MAX_CHARS = 4000` と
`DIGEST_BAND_MAX_ENTRY_CHARS = 120` により、`L` がどうであれ帯は約4,000字を超えない。**
**測れなかった量が帯の大きさを決めない形にしてある。**

### 段1の候補集合の大きさ

`DEFAULT_RECALL_LIMIT = 10` / `DEFAULT_OVER_FETCH_FACTOR = 4` であり、
`recall-runtime.ts` の `kPrime = Math.max(1, Math.round(limit * overFetchFactor))` は
既定で **40件**である。**「採らなかった案1」の上限がこれで決まる。**

---

## 採らなかった案

### 案1: パイプラインの落ちこぼれだけを並べる（＝ いま在るもので済む案）

段1の `getMany` で**既に手元に在る**候補のうち、段2〜4 で落ちたもの（`below_threshold` /
`over_limit` / `budget_dropped`）の digest を並べる。
**port 変更ゼロ・SQL ゼロ・schema ゼロ。`packages/core` だけで完結し、
Postgres が無い環境でも全部を歯で固定できる。**

**⛔ 採らなかった理由は費用ではない。機能の目的に照らして落ちた。**

**ANN が届かなかったもの・索引未整備のものを名乗れない。**
そして**「まだ開いていない」が最も疑わしいのは、まさに ANN が空振りした場合である。**
209件がスコープに在って ANN が空振りしたとき、この案の帯は**空になる。**
⟹ **この機能が最も要る場面で、役に立たない。**

**⚠ この案のほうが圧倒的に書きやすく、この器で完全に検証できた。
「書きやすいから」推していないかを自問したうえで、書きにくいほうを採った。**

### 案2-B: 別メソッド `listScopeDigests` を足す（走査2回）

SQL は素直になるが、**群カウントと帯が別スナップショットになる。**決定7の理由により採らない。

### 案β: `digest` そのものに発生源で上限を掛ける

`resolveDigest` / `memories.digest` 列に長さ上限を入れる。**帯の側で切る必要が無くなり、
費用が読み切れるようになる**という点で、**設計としてはこちらが正しい。**

**⛔ 採らなかった理由**: **既存データと既存の歯に影響する。破壊的寄りであり、
オーナーの判断を要する。**本 ADR の範囲（「1件1行の要旨を出す機能」1つ）を超える。

⚠ **参考（出所: 別の委譲から受け取った報告を、この作業者が現物で裏取りした）**:
`virchamate/virchamate-backend` の同種の機能は**まさにこの案を採っている**——
`MEMORY_SUMMARY_MAX_LENGTH = 200`、DB 列が `summary String? @db.VarChar(200)`、
そして要旨を解決する関数が **LLM 由来の要旨でも200字を超えたら強制的に切る。**
**つまり mnemora の状況はそちらより悪い**（発生源が塞がっていない）。
**これは将来やるべきことであり、そのときは本 ADR の `DIGEST_BAND_MAX_ENTRY_CHARS` が要らなくなる。**

### 案ii: `Omission` に `kind: 'digest_band_truncated'` を足す

**「切られたことは `omitted` に乗るべきだ」という読みには先例がある**——
`StageSkippedOmission.stage` には既に `'index_band'` が在り、
「目次帯が出せなかった」は現に `omitted` に乗る設計である。

**⛔ それでも採らなかった理由は2つある。**

1. **`Omission` は discriminated union であり、`kind` を足すと呼び出し側の網羅 `switch` が壊れうる。**
   **既存の列挙を広げるのは、区別を足すときに最も危ない形である。**追加のみの新しい欄なら壊れない。
2. **件数を `omitted` と `digestBandCoverage` の両方に置くと、ADR 0011 が避けた形になる**
   （同じ意味の件数が複数の経路から出て食い違う）。**置き場所は1つに決める必要がある。**

**そして `digestBandCoverage.eligible` は `aggregateScope` の同じ集約から出るので、
件数の出所は1本のままである。**

### 案II: 監査（`recalls.index_band`）には帯を載せない

`NewRecallRecord.indexBand` はそのまま `recalls.index_band jsonb` に入るため、
**recall 1回ごとに帯が永続化される**（schema 変更は不要）。膨張を嫌って `memoryId` だけを
残す案を検討したが、**「返り値と監査が一致しない」という新しい嘘の余地を作る。**
**膨張を抑えることより、嘘の余地を作らないことを上に置いた。**

---

## 引き受けた負債

### 🔴 `DIGEST_BAND_MAX_ENTRY_CHARS = 120` には根拠が無い

**実 digest の長さを実測できていない**（リポジトリに現物が2件、cassette に0件）。
導出値の分布は **max 34字**であり、**この母集団に対して 120 は一度も発火しない。**
**つまり 120 は「典型的な要旨を整える値」ではなく、「測れていない裾に対する安全弁」である。**

**⚠ どうなったら見直すか**: **実運用の digest 長の分布が取れたとき。**
具体的には、`digestSource: 'llm'` の digest について p95 と max が測れたとき。
そのとき 120 は「p95 を切らず、max の暴走だけを止める」値に置き直すべきである。

**⚠ この負債は `DigestEntry.truncated` によって観測可能になっている**——
帯の中で切り詰めが起きているかどうかは、返り値を見れば分かる。
**測れる形にしてから測っていない、という状態である。**

### `DIGEST_BAND_MAX_CHARS = 4000` も裁量値である

現行の目次帯126字に対する約32倍という以上の根拠は無い。
**これは予算の外側に常時載る量であり、規模の想定（`docs/roadmap.md` §5.6）が変われば動く。**

### `packages/postgres` の変更を、この器では緑にできなかった

**この器には Postgres も docker も無い**（`psql` / `docker` ともに存在しない。実測）。
**`packages/postgres` の適合は CI（`pgvector/pgvector:pg17`）でしか確かめていない。**

### `recalls` テーブルが太る

recall 1回ごとに最大約4,000字が `index_band` に載る。
**保持期間の判断（`docs/roadmap.md` §5.4）と噛み合う論点であり、本 ADR では動かしていない。**

---

## これが覆るとしたら

- **実運用の digest が長いことが分かったとき。**`truncated` が常時立つようになれば、
  `DIGEST_BAND_MAX_ENTRY_CHARS` は安全弁ではなく常用の切り詰めになる。
  そのときは案β（発生源で切る）へ移すべきであり、本 ADR の (b) の理由は消える。
- **taxonomy（`labels` / `memory_labels`）が入ったとき。**
  帯を taxonomy 軸で群ごとに配分する設計が可能になる。**本 ADR は帯を1本の平らな列として
  実装しており、群ごとの配分をしていない。**`groups` と帯の形が揃っていないのは、
  taxonomy が無い今の状態に合わせた結果である。
- **想定規模が大きく動いたとき**（`docs/roadmap.md` §5.6）。
  4000字という水準は、1テナントあたりの記憶数の桁を前提にしている。
- **`budget` の設計が変わったとき。**帯が予算の対象外であるという前提が動けば、
  上限を実装が持つ理由（決定5）が消える。

---

## 確かめていないこと

- **実 digest の長さの分布。**上記のとおり測れていない。
  **実 API を叩けば測れるが、叩いていない**（オーナー代理の指示による）。
- **`docs/recall.md` §5 が「digest 帯は taxonomy を要する」と書いたときの意図。**
  **推測**としては「帯を taxonomy でグルーピングして見せる絵を描いていた」だと読んでいるが、
  **これは推測であり、書いた人に確かめていない。**本 ADR が確かめたのは
  「機構としては要らない」ことだけである。
- **大規模テナントでの `aggregateScope` の実費。**帯の取得を同じ走査に相乗りさせたが、
  100万件規模で `ORDER BY ... LIMIT` の top-N がどれだけ効くかは測っていない。
