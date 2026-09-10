# ADR 0091: `Runtime.reflect()` の形を決める — 内省は「足す」操作であり、`superseded` を使わない

- **状態**: 採用 (2026-09)

- **文脈**:

  ## この ADR が決めていないこと

  🔴 **「`reflect()` を実装するかどうか」は、この ADR の対象ではない。**
  オーナーの決定（2026-09-09、Issue #102 / #103 / #104 / #106 を「4件とも今やる」）を
  受け取っている。**そのうち3件は既に着地している**——#102（[ADR 0087](./0087-runtime-forget-shape.md)）/
  #106（[ADR 0084](./0084-lexical-recall-channel.md)）/ #103（[ADR 0089](./0089-runtime-consolidate-shape.md)）。
  ⚠ **この前提は人から受け取ったものであり、このリポジトリの現物では検証できない**
  （`docs/roadmap.md` §5 にも記録されていない）。**出所を明示しておく。**

  🔴 **`reflect()` の*実運用*（Background Cognition）も、この ADR の対象ではない。**
  決めたのは**口の形**だけである。決定1 を見よ。

  ## 🔴 Phase 1 の線を確認した結果 — ここが ADR 0089 と決定的に違う

  ⚠⚠ **ADR 0087 / 0089 の論法は、この ADR にはそのまま使えない。**
  ADR 0089 は `consolidate` を範囲内と判定した根拠をこう書いている（`0089-runtime-consolidate-shape.md:49-52`、逐語）:

  > `docs/roadmap.md` §1.3「Phase 1 から明示的に外すもの」（`:44-50`）— 5項目
  > （関係グラフ本体 / reranking / **`reflect()` の実運用** / `packages/bullmq` / HTTP server）。
  > 🔴 **`consolidate()` は無い。**同じ「背景系」の相方である `reflect()` は名指しで
  > 外れているのに、`consolidate()` は外れていない。

  **⟹ `forget` も `consolidate` も、除外一覧に載っていなかっただけである。**
  **`reflect` は名指しで載っている。**先例が示すのは「*形*を決める ADR という器が正しい」
  ことまでであり、「除外がこの作業を縛らない」ことではない。**別の根拠が要る。**

  現物を読んで確かめた結果、根拠は3本立った。

  1. 🔴 **除外の文言は、3箇所すべてで `実運用` を修飾している。**素の `reflect()` を
     外した文は**1本も無い**（逐語）:
     - `docs/roadmap.md:26`: 「**Background Cognition（`reflect()` の実運用・Scheduler）は必須にしない**」
     - `docs/roadmap.md:49`（§1.3）: 「`reflect()` の**実運用**（Background Cognition）」
     - `docs/roadmap.md:148`（Phase 3 の表）: 「`packages/bullmq`（Scheduler の実装）と
       Background Cognition（`reflect()`）の**実運用**」
     - `AGENTS.md:47-48`（`CLAUDE.md` は symlink）: 「**Phase 1 に入っていないもの**は
       `docs/roadmap.md` §1.3 の通り（関係グラフ本体・reranking・`reflect()` の**実運用**・
       `packages/bullmq`・HTTP server）」——**roadmap を指すだけであり、独自の線を持たない。**
  2. **§1.3 自身の締めが、土台を Phase 1 の内側に置いている**（`docs/roadmap.md:53`、逐語）:
     「これらは Phase 1 の範囲外だが、**土台となる列・テーブルは 1.2 の通り Phase 1 に含める**。」
  3. 🔴 **より新しい ADR 0082 が、`reflect` の本体を実装する人を名指しで想定している**（逐語）:
     - `0082-tick-names-unsupported-job-kinds.md:216`: 「`consolidate` / `reflect` の**本体**を
       実装する人は、`TICK_SUPPORTED_JOB_KINDS` に kind を足し、」
     - 同 `:82`: 「作業の途中で、**`consolidate` / `reflect` の本体は近いうちに実装される**という」

  **⟹ 範囲内である。ただし「動詞の口」に限る。**
  ⛔ **`docs/north-star.md`・`docs/roadmap.md`・`AGENTS.md` を1文字も書き換えていない。**
  書き換える必要が無かった——**除外されているのは実運用であり、この PR は実運用を足していない。**

  ⚠ **もし「形を決めることが実運用を決めることを含んでしまう」なら、ここで止めるべきだった。**
  含まなかった。含ませない唯一の分かれ目は「**誰が土台を選ぶか**」であり、決定3 がそれを閉じている。

  ## では何が無かったのか

  **公開 API としての口が無い。**現物（`f5f28aee` 時点、読んで確認した）:

  - `packages/core/src/runtime.ts` の `export interface Runtime` は
    `observe / tick / recall / reextract / reembed / forget / consolidate` の**7つ**。
    `reflect` は無い。
  - `ProvenanceKind` に `"reflected"` は在り（`packages/core/src/provenance.ts:9`）、
    `ReflectedProvenance { kind: "reflected"; sources?: string[] }` も在る（`:46-49`）が、
    **それを作る主体が1つも無い。**
  - `OutboxJobKind` に `"reflect"` は在るが、`tick` に分岐は無い
    （ADR 0082 がこれを名指しで固定している）。
  - [ADR 0035](./0035-recalled-memory-provenance-kind.md)`:156-158` の「これが覆るとしたら」が
    「**Phase 2 で `consolidated` / `reflected` が実際に作られるようになったとき**」と
    予想していた。**その半分は ADR 0089 で発火し、残りの半分がここで発火する。**

  Issue #104（THE PHAGE の gurumi-chan-backend への導入検討で見つかった外部フィードバック。
  #102 / #103 と同じ報告者）は、この穴が何を止めているかを書いている——導入先の
  エージェントが持つ「ルール」（ユーザーが与えた運用方針＝観測から一般化された知識）が、
  **「明示的に登録したときだけ増える」状態に留まる。**報告者は回避していないと書いており、
  「一般化された知識は従来どおり別テーブルで人間が管理する」という切り分けを取っている。

  **⟹ 決めるべきものとして残っているのは、口の「形」だけである。**
  ⚠ そして **`consolidate` の形をそのまま写すことはできない。**
  `docs/vision.md:64` は `consolidate` を「**複数の記憶を統合して、より上位の記憶を作る**」と
  定義し、`:63` は `reflect` を「**入力が無い状態で、既存の記憶から新しい記憶を作る**
  （内省・背景思考）」と定義している。**`reflect` の定義に「統合」も「複数」も無い。**
  ⟹ ADR 0089 の芯（「統合元をどの層で始末するか」）に対応する問いが、ここには存在しない。

- **決定**:

  ## 決定1: 動詞の口だけを足す。`tick` / Scheduler には触らない

  `TICK_SUPPORTED_JOB_KINDS` は `["extract","embed"]` のままである。
  `packages/bullmq` を作らない。ADR 0089 決定7 と**同じ立場**をとる。

  ⟹ `packages/core/src/__tests__/runtime.test.ts` の時限式の歯
  （`it.each(["consolidate","reflect"])`）は**緑のままであり、その主張は依然として正しい**
  ——tick に `reflect` の分岐は無い。⛔ **アサーションは1文字も変えていない。**
  「本体」という語が*動詞の本体*と*tick の分岐*の2つを指してしまうため、
  ADR 0089 が `consolidate` について足したのと同じ趣旨の1文を doc コメントに足しただけである。

  ⚠ [ADR 0012](./0012-ingest-pipeline-design.md)`:44` は
  「ジョブの中身（`payload`）は `{ observationId }` / `{ memoryId }` に固定されており、
  それ以外のペイロード形を持つジョブ（**将来の `consolidate`/`reflect`**）は、
  このメソッドの外——つまり別の transactional な書き込み経路——を必要とする」と書いている。
  **決定1 はこの問題に触れていない。**触れないことで回避している（`consolidate` と同じ回避）。

  ## 決定2: 返り値の型名は正典を採る（`ReflectionResult`）

  `docs/vision.md:53-65` が `reflect(ctx, opts) // -> ReflectionResult` と書いている。
  ⛔ **Issue #104 本文の `ReflectResult` を採らない。**ADR 0089 が
  `ConsolidationResult`（正典）と `ConsolidateResult`（Issue #103）の間で正典を採ったのと
  同じ判断である。**2件で同じ選択をしたので、これは以後の既定として読める。**

  ## 決定3: 🔴 `target` は必須。呼び出し側が土台を渡す

  ```ts
  export type ReflectTarget =
    | { memoryIds: MemoryId[] }
    | { query: RecallQuery; maxCandidates?: number };
  ```

  ⛔ **Issue #104 の提案シグネチャ `reflect(ctx, { maxCandidates?, dryRun? })` を採らない。**

  🔴 **これがこの ADR で最も重い決定である。**理由は範囲そのものに関わる——
  **`target` を持たない `reflect` は、reflect 自身が「何を見るか」を決めることになり、
  それは Background Cognition の*実運用*の決定である。**
  「いつ・何を対象に内省を起動するか」は Scheduler の役目であり、
  `docs/roadmap.md:148` が Phase 3 に置いているものそのものだ。
  ⟹ **土台の選び方を呼び出し側に残すことが、形の決定を実運用の決定から切り離す唯一の分かれ目である。**

  ⚠ **「入力が無い状態で」（`docs/vision.md:63`）と矛盾しないか。**しない。
  ここでの「入力」は**外から来た新しい出来事（Observation）**であり、引数一般ではない
  ——`docs/vision.md:99` の用語表も「入力が無い状態で、既存の Memory から新しい Memory を
  作ること」と書いており、`docs/vision.md:53-65` の署名自身が `reflect(ctx, opts)` と
  `opts` を取っている。`consolidate(ctx, opts)` も同じ形で `target` を `opts` に持つ。

  ⭐ **`ConsolidateTarget` と同じ形を使い、同じ規律を敷く**——`{ memoryIds }` は
  **正規化せず、重複も入力順もそのまま保つ**。`{ query, maxCandidates }` は
  `recall(ctx, query)` を1回呼んで得た `memories` の id を順に採る。
  **新しい綴りを作っていない。**

  ## 決定4: 🔴 内省は「足す」操作である。既存の行の `status` を1つも動かさない

  **`reflect` は `updateStatus` / `updateStatusWithEvent` を1度も呼ばない。**
  書き込みは**新しい Memory 1件と `created` イベント1件だけ**である。

  ADR 0089 が統合元を `superseded` へ動かしたのは、`consolidate` が
  **N→1 の置換**だからである（`docs/architecture.md:244`「複数 Memory → **1 Memory**」、
  `docs/memory-model.md` §11 行5 が「**統合パイプライン**」を名指しでこの遷移に置く）。
  🔴 **`reflect` にその根拠は1つも無い。**`docs/memory-model.md:921`（§11 行5、逐語）:

  > | 5 | active → superseded | **抽出・統合パイプライン**が置換を機械的に決定 | … |

  ⟹ この行がトリガーとして名指しするのは「抽出」と「統合」の2つだけであり、**内省は入っていない。**
  🔴 **さらに確かめた: §11 の lifecycle 表 11 行のどこにも、内省が Memory を作る行は無い**
  （表の入口は行1〜2 の `observed → extracted → active` だけである）。
  そして `docs/vision.md:63` の定義に「置き換える」も「上位の」も無い。
  ⚠ **この欠落は `reflect` で始まったのではない**——`consolidate` の産物も
  Observation を持たずに `active` から始まるので、**表は ADR 0089 の PR の時点で既に不完全だった。**
  ⛔ **この PR では直さない**（`docs/autonomy.md` §2「⚠「ついでに直す」をしない」）。**負債に記録した。**
  一般化された記憶は、それが一般化した観測を**古くしない**——
  「タスクには必ず期限を付けて」というルールが在っても、それを言った個々の発話は
  依然として事実であり、`recall` から消える理由が無い。

  ⟹ **`MemoryStatus` の5値にも `superseded_by_id` にも触れない。**
  `reflect` を無効にしても既存の記憶は1件も変わらない
  ——**北極星の問い2**（`docs/north-star.md:62`、オーナー設計原則 §42-6 逐語:
  *Background Cognition を無効にしても Memory Framework として成立する*）が、
  ここで実際に案を落としている。⚠ **もし `reflect` が既存の行を書き換える設計なら、
  「無効にしても成立する」は成り立たなくなっていた。**

  ## 決定5: 1回の呼び出しで作る Memory は最大1件

  N 件を作る形は却下した（却下案4）。呼び出し側は繰り返し呼べる。

  ## 決定6: 🔴 LLM が「一般化するものは無い」と言える形にする

  ```ts
  export const ReflectionLLMResultSchema = z.discriminatedUnion("outcome", [
    z.object({
      outcome: z.literal("reflected"),
      content: z.string().min(1),
      digest: z.string().min(1).optional(),
      tags: z.array(z.string().min(1)).optional(),
    }),
    z.object({ outcome: z.literal("nothing") }),
  ]);
  ```

  🔴 **`ConsolidationLLMResultSchema`（`{ content, digest?, tags? }`）には「断る」側が無い。**
  `consolidate` ではそれで正しい——束ねる対象を2件以上見つけてから呼ぶので、
  「束ねようがない」は LLM を呼ぶ**前に**判定できる（ADR 0089 決定3）。
  ⚠ **`reflect` では判定できない。**「この記憶群から一般化できる方針が在るか」は
  中身を読まないと決まらない。⟹ **断れないスキーマを渡すと、モデルは毎回何かを捏造する。**
  推測から作った記憶が観測と並んで想起される事故を、Issue #104 自身が
  「事故になりやすい」と書いている。**スキーマの側で断らせる。**

  ⭐ 副産物として、この判別子は**スキーマの取り違えも塞ぐ**——決定10 を見よ。

  ## 決定7: `provenance.sources` は必ず埋める。ただし型は緩いままにする

  `packages/core/src/provenance.ts:46-49` / `:86-89` の現物は非対称である:
  `ConsolidatedProvenance.sources` は `z.array(...).min(1)`（**必須**）だが、
  `ReflectedProvenance.sources` は `.optional()`（**省略可**）。
  ⚠ **この非対称の理由は正典のどこにも書かれていない**（探した。`docs/memory-model.md` §2 も
  ADR 0035 も、`sources?` の脇のコメント `// memoryIds, 省略可` 以上のことを言っていない）。
  むしろ `docs/memory-model.md:627-628` は逐語で
  「stated/inferred は必須、**consolidated/reflected/imported は provenance.sources 側で
  複数ソースを表すため** NULL を許す」と書いており、**sources が在る前提の文言**になっている。

  ⟹ 決定は2つに割る。
  - **実装は常に埋める。**`reflect` が作る Memory の `provenance.sources` は、
    実際に土台にした Memory の id である。**北極星の問い3**
    （`docs/north-star.md:66`「この記憶が選ばれた理由を、後から説明できるか」）と
    **問い4**（`:70`）が、根拠を持たない `reflected` を落としている。
  - ⛔ **型は `.optional()` のまま変えない。**`.min(1)` へ締めるのは
    **公開 API の破壊的変更**であり、`docs/autonomy.md` §3 は
    「やらずに提起する」と定めている。⟹ 提起にとどめ、負債に記録した。

  ## 決定8: 🔴 `strength` を下げない。区別は `provenance.kind` が1本で担う

  ⛔ **Issue #104 の「生成物の強度を観測より低く始める、といった扱い」を採らない。**

  根拠は `packages/core/src/provenance.ts:6-7` の JSDoc そのものである（逐語）:

  > オーナーの原則7「AI の推論とユーザーが言った事実を区別する」は、**追加のフラグではなく
  > `kind` の値そのものとして実装される**。

  ⟹ **強度を下げることは、同じ区別を2本目の信号で複製することである。**
  複製した信号は独立にずれる（`AGENTS.md`「複製した瞬間から、正文と要約はずれ始める」の、
  値への適用）——`kind` を見て弾く経路と `strength` を見て沈める経路が並ぶと、
  片方だけ直したときに黙ってずれる。**それは ADR 0082（issue #105）の根と同じ形である。**

  加えて [ADR 0078](./0078-strength-value-range.md)`:251-253` は逐語で
  「🔴 **`Runtime` から初期値の `strength` を設定する口は開けない。**…**蓋だけを、先に付けた。**」
  と書いており、同 `:326-331` の「これが覆るとしたら」は
  「**利用側が『重要度を申告して並べ替えたい』と決めたとき**」——
  **その写像の設計は本 ADR の対象外であり、決めていない**——を条件に挙げている。
  ⟹ **この PR がその口を開ける理由が無い。**`consolidate` と同じ値を同じ書き方で書く。

  🔴 **そして ADR 0078 自身が、下げることの副作用を名指ししている**（`:329-331`、逐語）:

  > ⚠ そして `strength` を下げると `total` が**絶対値の閾値**（`DEFAULT_SCORE_THRESHOLD = 0.1`）に
  > 近づくため、**下げ幅によっては `below_threshold` で落ちるようになる。**

  ⟹ **「弱く始める」は「想起されにくくする」ではなく「下げ幅次第で消える」である。**
  どの下げ幅なら消えないかは、この器では測れない（確かめていないことを見よ）。

  ⭐ **Issue #104 が実際に求めていた安全弁は、既に在る。**報告者自身が
  「`RecallQuery.excludeProvenanceKinds` が既にあるのは良い設計だと思いました」と書いている。
  **弾く道具は在り、沈める道具を足していない。**

  ## 決定9: 土台に `provenance.kind === "reflected"` の Memory を採らない

  `reflect` の産物を土台にまた `reflect` する経路を、**形の側で閉じる。**
  該当した土台は `basis_is_reflected` として名指しで返る。

  🔴 **理由は北極星の問い1**（`docs/north-star.md:58`、最も強い問い）:
  「これは、毎回渡す量を減らす方向に働くか。増やすなら、その分だけ想起が良くなると言えるか。」
  **`reflect` は記憶を増やす操作である。**自分の産物を土台にできると、
  「増える」が「増えたものからさらに増える」に変わり、**問い1 に対する説明が
  原理的に立たなくなる**（何回目の一般化まで想起が良くなるかを、誰も言えない）。
  加えて問い4（推論とユーザーが言った事実の区別）——推論を土台にした推論の `sources` は、
  辿っても観測に届かない。

  ⚠ **これは呼び出し側の選択を1つ閉じている**（意図的に `reflected` を土台にしたい場合の口が無い）。
  負債に記録した。

  ## 決定10: `MemoryEventKind` に値を足さない

  `created` イベントの `meta.reason` に `"reflected"` を積む
  （ADR 0089 決定6 と同じ道具。`docs/memory-model.md` §9「理由の粒度は `meta` に落とす」）。
  ⟹ **`meta.reason` はこれで3値目になった**（`"reextract_superseded"` / `"consolidated"` /
  `"reflected"`）。ADR 0089 が負債3 に記録した「`meta` は `Record<string, unknown>` であり
  型で守られていない」は、**この PR で1段重くなった。**負債に引き継ぐ。

  そして 🔴 **`DeterministicLLMProvider` のスキーマ分岐が、決定6 に救われている。**
  `packages/testkit/src/__fixtures__/deterministic-llm-provider.ts` は
  **スキーマを知らない**——候補オブジェクトを順に `safeParse` して通った方を返す。
  ⚠ **もし `ReflectionLLMResultSchema` を `{ content, digest?, tags? }` にしていたら、
  `ConsolidationLLMResultSchema` と形が同一になり、この fixture は2つを区別できなかった**
  （consolidation 候補が reflection スキーマを素通りする）。
  ⟹ 必須の判別子 `outcome` が、**実害のある向きの衝突を閉じている。**

  ⚠⚠ **ただし「3つのスキーマが互いに素」とは書けない。歯で測った結果、片方向だけである**
  （`packages/core/src/__tests__/reflect.test.ts` の
  「[既知の非対称] reflected 候補は outcome を剥がされて consolidation のスキーマにも一致する」）:

  - ✅ **閉じている向き**: consolidation 候補（`{ content, digest, tags }`）は
    `ReflectionLLMResultSchema` を**通らない**（必須の `outcome` が無い）。
    ⟹ **要求スキーマが reflection のとき、fixture が consolidation 候補を返すことはできない。**
    **これが塞ぎたかった経路である。**
  - ⚠ **開いている向き**: reflected 候補（`{ outcome, content, digest, tags }`）は
    `ConsolidationLLMResultSchema` を**通ってしまう**——`z.object` は既定で未知キーを
    黙って剥がす（`.strict()` を付けていない）ため、`outcome` が剥がされる。

  ⟹ この向きが実害にならないのは、**fixture の試行順（extraction → consolidation → reflection）が
  支えているからである**——要求が consolidation のときは reflection 候補を試す前に確定する。
  🔴 **つまり安全は「スキーマの形」と「試行順」の2つで買っており、形だけでは買えていない。**
  ⛔ `.strict()` を足して形だけで買う案は採らなかった（却下案10）。
  **この非対称を歯に測って残してある**——試行順に手を入れた人が、そこで気づけるようにするため。

  ## 決定11: 🔴 冪等性は買わない。買えないことを名指しで固定する

  **同じ `target` で2回呼ぶと、内容が同じ `reflected` Memory が2件できる。**

  ⚠ **これは見落としではなく、道具が無いという事実である。**確かめた:
  - `packages/postgres/src/memory-store.ts` の `ON CONFLICT` は
    `(tenant_id, source_observation_id, extractor_version, content_hash)` の
    **部分一意索引**であり、条件は `WHERE source_observation_id IS NOT NULL`
    （`packages/postgres/migrations/0001_init.sql:106-108`）。
    `reflect` の産物は `source_observation_id: null` なので、**この索引の外に落ちる。**
  - ADR 0089 決定3 の「読んで status で弾く」は、**決定4 により使えない**
    ——`reflect` は土台の `status` を動かさないので、2回目も同じ土台が eligible のまま在る。
  - `MemoryStore` に `content_hash` で引く口は**無い**（interface のメソッド一覧を読んで確認した）。
    足せば公開 interface の必須メソッドが増え、**第三者の adapter を壊す**
    （`docs/autonomy.md` §3、ADR 0089 却下案5 と同じ線）。索引を足すのは
    マイグレーションであり、この ADR の範囲外である。

  ⟹ ⛔ **塞がない。**代わりに**歯で挙動を固定した**（2回呼ぶと2件になることを測る歯が在る）。
  **これは「後で気づく」ではなく「決めて残した」である。**
  ⚠ **`tick` の `reflect` ジョブ（Phase 3）が入るとき、これは実際に痛む**
  ——常駐処理が同じ土台を繰り返し内省して重複を積む。**その作業の一部として塞ぐこと。**

  ## 決定12: 「無い」は2階層で割る（ADR 0008 の適用）

  ### 層1: `ReflectOutcome`（呼び出し全体）

  - `"reflected"` — 新しい Memory を1件作った。
  - `"nothing_to_reflect"` — 土台を見た上で、作るものが無かった（層1.5 で細分）。
  - `"not_examined"` — `target` そのものが空、または `query` が0件——**store の Memory を1件も見ていない。**
  - `"llm_failed"` — LLM 呼び出しが失敗した。**1件も書いていない。**
  - `"dry_run"` — 下見だけ。**1件も書いていない。**

  ### 層1.5: `ReflectNothingReason`

  - `"no_eligible_basis"` — 採れる土台が0件（`llmCalls: 0`。**LLM を呼んでいない**）。
  - `"llm_declined"` — LLM を呼び、モデルが「一般化するものは無い」と答えた（`llmCalls: 1`）。

  🔴 **この2つを潰さない。**「そもそも土台が無かった」と「土台は在ったがモデルが断った」は、
  呼び出し側の次の一手が違う——前者は `target` を広げる、後者は広げても同じである。

  ⚠ **`consolidate` の `single_eligible_source` に相当する値は無い。**
  1件から一般化することは意味を持つ（ADR 0089 で「1件を1件に統合しない」が成り立ったのは
  N→1 の定義からであり、`reflect` にその定義は無い）。⟹ **eligible 1件でも LLM を呼ぶ。**
  断るかどうかはモデルが決める（決定6）。

  ### 層2: `ReflectBasisOutcome`（土台1件ごと）

  `"used"` / `"not_found"` / `"status_not_active"` / `"basis_is_reflected"` / `"eligible"`。

  ⚠ **`"eligible"` は「`dryRun` のときだけ」ではない。**
  **土台として採れる状態だったが、この呼び出しでは結局使われなかった**という意味であり、
  **書き込みが起きなかった3経路すべてで出る**——`"dry_run"` / `"llm_failed"` / `"llm_declined"`。
  ⟹ ⭐ **これで不変条件が1本立つ: `"used"` が出るのは `outcome === "reflected"` のときに限る。**
  🔴 新しい綴り（`consolidate` の `not_attempted` に相当するもの）を作らずに済ませた。
  ⭐ **語彙は `ConsolidateSourceOutcome` から借り、新しい綴りは `basis_is_reflected` の1つだけである。**
  ⚠ `consolidate` の7値のうち `status_changed_concurrently` / `failed` / `not_attempted` は
  **無い**——決定4 により既存の行を書き換えないので、**TOCTOU も部分失敗も起きない。**
  🔴 **「起きないものに札を用意しない」**（ADR 0024「先回りして作らない」）。

  ## 決定13: `dryRun` は LLM を呼ばない

  ADR 0089 決定4 と同じ。北極星の問い5（`docs/north-star.md:74`
  「これは、LLM を呼ばずに済ませられないか」）。返るのは「何を土台にするはずか」
  （`"eligible"`）だけであり、**生成される本文は見せない。**
  ⚠ 後から足せる（`dryRun: 'preview'` のような値を増やせばよい）——先回りして作らない。

  ## 決定14: `opts.actor` は `created` イベントに使う（⚠ `consolidate` と非対称である）

  ⚠ **これは実装中に見つかった空白であり、上のどの決定にも書かれていなかった。**
  現物（読んで確認した）: `consolidate` は `created` イベントの `actor` を
  **常に `{ type: "system" }` に固定し**（`runtime.ts:1528`）、`opts.actor` は
  `superseded` イベントにだけ使っている（`:1538`/`:1553`）。
  🔴 **`reflect` には `superseded` イベントが無い**（決定4）。
  ⟹ **同じ扱いにすると `ReflectOptions.actor` は宣言されているのに一度も使われない**
  ——「渡せるのに黙って何もしない選択肢」であり、このリポジトリが繰り返し名指ししている
  失敗の形そのものである。

  ⟹ **`reflect` の唯一の書き込みイベントである `created` の `actor` に使う**
  （`opts.actor ?? { type: "system" }`）。`EventActor.type` は
  `"human" | "system" | "clone"`（`packages/core/src/event.ts:21-24`）であり、
  **「人が内省を起動した」ことは監査ログに残す価値がある。**
  `ForgetOptions.actor` / `ConsolidateOptions.actor` が在るのに `reflect` だけ無い、
  という非対称も作らない。

  ⚠ **これは `consolidate` の `created` との意図的な非対称である。**
  ⛔ `consolidate` 側を揃えに行かない（「ついでに直す」をしない）。**負債に記録した。**

  ## 変異試験で分かったこと（歯を「置いた」と「測っている」は違う）

  ⚠ **順序を守った**——歯を書く → ベースライン緑を確かめる（24/24）→ 撃つ。
  歯が0本の状態で撃つと全部「生存」と返り、「まだ歯が足りない」と誤読して回し続けることになる。
  復元は退避コピー（`cp`）からの `diff` によるバイト比較で行った（⛔ `git checkout` は使っていない
  ——`docs/autonomy.md` §4「未コミットの編集も一緒に消える。実際に3ファイル失われた」）。

  | # | 変異 | 撃った場所 | 期待 | 実際 | 噛んだ歯 |
  |---|---|---|---|---|---|
  | M1 | `no_eligible_basis` と `llm_declined` を入れ替え | `runtime.ts` | 赤 | 🔴 赤（2本） | `no_eligible_basis: …` / `llm_declined: …` |
  | M2 | `no_eligible_basis` 経路の `llmCalls` を `0`→`1` | `runtime.ts` | 赤 | 🔴 赤（1本） | `no_eligible_basis: …`（`llmCalls` の期待値） |
  | M3 | `mapBasis` の走査元を `ids`→`uniqueIds`（正規化する） | `runtime.ts` | 赤 | 🔴 赤（1本） | `重複を含む入力でも basis は同じ順序・同じ長さで返る` |
  | M4 | `basis_is_reflected` 判定を `false` に潰す（自己増幅を許す） | `runtime.ts` | 赤 | 🔴 赤（2本） | `…それぞれ別の kind で出る` / `no_eligible_basis: …` |
  | M5 | `sources` を常に `[]` にする | `strategies/reflect.ts` | 赤 | 🔴 赤（2本） | `反映先の provenance は { … sources: [元の id …] }` |
  | M6 | `dryRun` の早期 return を `false` 固定（LLM を呼ぶ） | `runtime.ts` | 赤 | 🔴 赤（2本） | `dryRun: LLM を呼ばず1件も書かず…` ほか |
  | M7 | 分類の優先順を入替え（`basis_is_reflected` を `status_not_active` より先に） | `runtime.ts` | 赤 | 🔴 赤（1本） | `判定の優先順: status を先に見る…` |
  | M8 | `strength` を `1`→`0.5` | `strategies/reflect.ts` | 赤 | 🔴 赤（1本） | `反映先の strength は 1（逐語のリテラル…）` |
  | **E1** | **プロンプトの system 文言を言い換える（等価変異）** | `strategies/reflect.ts` | **緑のまま** | ✅ **緑のまま（24/24）** | — |

  🔴 **M7 は、最初に書いた歯では噛まなかった。**
  理由は「歯が無かった」からではなく、**`status !== 'active'` かつ
  `provenance.kind === 'reflected'` が同時に成り立つ入力が1つも無かった**からである
  ——優先順を入れ替えても、どちらの分岐でも同じ答えが出る入力しか測っていなかった。
  ⟹ **その入力を持つ歯を1本足して、初めて赤くなった。**
  ⭐ **これが「歯を置いた」と「測っている」の差である。**判定の**順序**を主張するなら、
  **順序が結果を変える入力**を持っていなければ、その主張は測られていない。

  ⚠ **E1（赤くなってはいけない変異）を混ぜてある。**これが緑のままだったことで、
  上の8本の赤が「何をしても赤くなる歯」の産物ではないと言える。

- **検討して採らなかった案**:

  1. 🔴 **`target` を持たせず、`{ maxCandidates }` だけで mnemora 側が土台を選ぶ（Issue #104 の提案どおりの形）。**
     却下。決定3。**これは形の決定ではなく実運用の決定である**——
     「いつ・何を対象に内省を起動するか」が Scheduler の役目であり、
     `docs/roadmap.md:148` が Phase 3 に置いているものそのもの。
     ⚠ ADR 0089 却下案7 が `consolidate` について同じ形を落としているが、
     **理由は違う**——あちらは「組の割り方（クラスタリング）が正典に無い」から、
     こちらは「**選び方そのものが除外されている実運用に当たる**」から。
     🔴 **これは Issue #104 の提案の一部を満たしていない。**負債に記録し、PR 本文にも書いた。
     ⭐⭐ **却下の理由は設計の好みではない。「Phase 3 の決定（Background Cognition / Scheduler）に
     踏み込まないため」である。**⟹ 🔑 **`target` が必須であることが、この動詞と Phase 3 の
     接続点そのものである。**Phase 3 をやる人は、ここに「誰がいつ土台を選ぶか」を差し込む
     ——`ReflectTarget` を作る主体を Scheduler 側に置けば、**この ADR の決定を1つも覆さずに
     実運用へ繋がる。**逆に、いま自動選定を入れてしまうと、その接続点が消える。

  2. **`reflect` の産物で土台を `superseded` にする（`consolidate` と同じ形にする）。**
     却下。決定4。一般化された記憶は、それが一般化した観測を古くしない。
     `docs/memory-model.md` §11 の lifecycle 表に内省を置く行は**無い**。
     ⚠ そして**北極星の問い2 がこの案を落とす**——既存の行を書き換える `reflect` は、
     「無効にしても Memory Framework として成立する」を満たさなくなる。

  3. **`MemoryStatus` / `MemoryEventKind` に `reflected` を足す。**
     却下。決定10。ADR 0087 決定1 / ADR 0089 決定3・決定6 と同じ3つの理由。
     特に status を割ると status ゲート3か所が独立にずれる（ADR 0082 の根）。

  4. **1回の呼び出しで N 件の記憶を作る。**
     却下。決定5。N 件にすると (a) 部分失敗の原子性が要る（決定4 で消したはずの
     `not_attempted` / `failed` が戻ってくる）、(b) 冪等性の欠落（決定11）が N 倍で痛む、
     (c) 「何件作るべきか」を決める方針が正典に無い。
     ⟹ 呼び出し側が繰り返し呼べる形で足りる。**後から足せる。**

  5. **`strength` を観測より低くする（Issue #104 の提案）。**
     却下。決定8。区別は `provenance.kind` が1本で担う（`provenance.ts:6-7` 逐語）。
     ADR 0078 が意図的に閉じた口を、この PR が開ける理由が無い。
     🔴 **これも Issue #104 の提案の一部の未達である。**負債に記録した。

  6. **`content_hash` で既存の `reflected` を引いて重複を弾く（冪等性を買う）。**
     却下。決定11。`MemoryStore` に必須メソッドを足すと**第三者の adapter を壊す**
     （`docs/autonomy.md` §3、ADR 0089 却下案5 と同じ線）。索引を足すのはマイグレーション。
     ⟹ **買わずに、歯で固定して負債に書いた。**

  7. **`ReflectedProvenanceSchema` の `sources` を `.min(1)` へ締める。**
     却下。決定7。**公開型の破壊的変更**は提起までにする（`docs/autonomy.md` §3）。

  8. **`tick` の `reflect` ジョブも同じ PR で実装する。**
     却下。決定1。`docs/autonomy.md` §2「1つの PR は『1つの ADR とその実装』」
     「**⚠「ついでに直す」をしない**」。加えて outbox の payload の形は
     ADR 0012`:44` が名指しした独立の設計である。

  9. **`examples/chat` に `reflect` を配線して、北極星の物差しで効果を測る。**
     却下——**ただし「不要だから」ではない。**⚠ `examples/chat` の `retrieval` は
     **カセット再生であり、入力が固定されている**（ADR 0051 / 0088。probe を1件足すと
     鍵が変わり、記録に無い入力は例外になる）。⟹ **`reflect` の産物を含む想起の質は、
     いまの器では測れない。**測る器を作るのが先である（`docs/autonomy.md` §1.2 の問い2）。
     **確かめていないことに記録した。**

  10. **`ReflectionLLMResultSchema` に `.strict()` を付けて、スキーマの形だけで衝突を閉じる。**
      却下——**ただし「不要だから」ではない。**決定10 のとおり、いまの安全は
      「形」と「`DeterministicLLMProvider` の試行順」の2つで買っている。`.strict()` は
      形だけで買えるようにするが、**それは LLM provider の契約を変える**
      ——実 provider（`packages/openai` / `packages/anthropic`）が返す JSON に
      余分なキーが1つでも混ざると、いままで通っていた応答が**落ちるようになる。**
      🔴 **既存2スキーマは `.strict()` を使っていない。**`reflect` だけを締めると
      「どのスキーマが厳格か」が綴りの中に散る。⟹ **3つまとめて決めるべき判断であり、
      この ADR の範囲ではない。**測って残す（歯）ところまでにした。

  11. **`reflect` の `created` イベントも `actor` を `{ type: "system" }` に固定する
      （`consolidate` に完全に揃える）。**
      却下。決定14。`reflect` には `superseded` イベントが無いので、揃えると
      `ReflectOptions.actor` が**死んだフィールド**になる。
      ⟹ 代案は「`actor` を `ReflectOptions` から消す」だったが、それは
      `forget` / `consolidate` に在る監査の口を `reflect` だけ落とすことになる。

- **引き受ける負債・覆えていない範囲**:

  1. 🔴 **`reflect` は冪等でない**（決定11）。同じ `target` で2回呼ぶと重複が2件できる。
     **歯で固定してあるので黙って壊れることはないが、塞いでいない。**
     `tick` の `reflect` ジョブ（Phase 3）が入るときに実際に痛む。
  2. **Issue #104 の提案の2つが未達である**——`target` 無しの自動選定（却下案1）と
     `strength` を低く始めること（却下案5）。**どちらも意図的に採らなかった。**
  3. **`ReflectedProvenance.sources` の型は緩いまま**（決定7）。
     実装は常に埋めるが、**型は空や欠落を許す。**第三者が `reflected` を作れば、
     根拠の無い推論が入りうる。締めるのは破壊的変更なので提起にとどめた。
  4. **`meta.reason` が3値になった**（決定10）。ADR 0089 負債3 が
     「`meta` は `Record<string, unknown>` であり型で守られていない」と書いた穴は、
     **書き手が3人になったぶん重くなった。**4人目（矛盾解決）が入る前に見直す価値がある。
  5. **産物の埋め込みは非同期である。**`createMemoryWithOutbox(..., ["embed"])` で
     `embed` ジョブを積むだけであり、`tick` が回るまで `embeddingStatus: 'pending'` で
     **ANN の候補に入らない。**⚠ ただし `consolidate` の負債4 と違い、
     **元が引けなくなる副作用は無い**（決定4）——窓の影響は小さい。
  6. **決定9 は呼び出し側の選択を1つ閉じている。**意図的に `reflected` を土台にしたい
     利用者の口が無い。
  7. **本物の Postgres に対して `reflect` を通していない。**この作業環境に `DATABASE_URL` が無い。
     ただし `reflect` は `packages/core`（＋ `packages/testkit` の擬似 provider 1ファイル）
     だけの変更であり、`createMemoryWithOutbox` の Postgres 実装は既存の適合テストで測られている。
     **CI が DB 付きで走るので、そこが実測の場である。**
  8. **`ReflectBasisOutcome` の5値・`ReflectOutcome` の5値が「多すぎる」か「足りない」かは、
     実利用のフィードバックが無い。**Issue #104 は返り値の中身について
     「根拠にした記憶の id を残す」以上の具体案を出していない。
  9. 🔴 **`docs/memory-model.md` §11（Memory lifecycle）が、内省の書き込みを1行も持っていない**
     （決定4）。表の入口は行1〜2 の `observed → extracted → active` だけであり、
     **Observation を持たずに `active` から始まる Memory の経路が表に無い。**
     ⚠ **この欠落は `reflect` が作ったのではない**——`consolidate` の産物も同じ形であり、
     **ADR 0089 の PR の時点で既に不完全だった**（あちらは §11 行5 の `superseded` 側だけを
     引いており、産物の作成は表に無い）。⛔ この PR では直していない
     （`docs/autonomy.md` §2「ついでに直す」をしない）。**次に §11 を触る人の仕事である。**
  10. **`.strict()` を使っていないため、LLM 結果スキーマの安全は「形」と
      「`DeterministicLLMProvider` の試行順」の2つに分かれて乗っている**（決定10 / 却下案10）。
      試行順を入れ替えた人が壊す面が在る。**歯で測ってはあるが、型では守られていない。**
  11. **`reflect` の `created` イベントの `actor` は `consolidate` の `created` と非対称である**
      （決定14）。`consolidate` 側を揃えに行っていない。

- **これが覆るとしたら**:

  - 🔴 **`tick` の `reflect` ジョブ（Phase 3 / 別 issue）が入ったとき。**
    そのとき `TICK_SUPPORTED_JOB_KINDS` に kind が足され、ADR 0082 の時限式の歯が
    **実際に赤くなる**（足す人がその歯を書き換えるところまでがその作業である）。
    そして **負債1（冪等性）が同時に痛む**——常駐処理は同じ土台を繰り返し内省する。
    ⚠ **加えて決定3 が再燃する**: ジョブの payload が「どの memoryId を土台にするか」を
    運ぶのか「探せ」と言うだけなのかで、却下案1（自動選定）の判断が戻ってくる。
    **そのときは実運用の決定が解かれているので、判断の前提が変わっている。**
  - **オーナーが「reflected は観測より弱く出るべきだ」と決めたとき**（却下案5）。
    そのとき ADR 0078 の「これが覆るとしたら」（`:326-331`）が発火し、
    `strength` の初期値を `Runtime` から設定する口の設計が要る。
    ⚠ **`reflect` だけに口を開けない**——`observe` の抽出経路（いまも常に `1` を書く）と
    合わせて決めること。
  - **矛盾解決（`contested` を作る主体）が Phase 2 で入ったとき。**
    `meta.reason` が4値になり、負債4 が実際に痛む。
  - **`reflect` の産物が `recall` を悪くしたと実測されたとき。**
    そのとき候補は「決定8 を覆して弱く出す」／「既定で `excludeProvenanceKinds` に
    `reflected` を入れる」／「決定5 を覆して N 件作れるようにし、より良い1件を選ばせる」。
    ⚠ **いまは測れない**（却下案9）。**測る器を作るのが先である。**
  - **`ReflectionResult` という型名。**`docs/vision.md` が `ReflectionResult` と書いており、
    Issue #104 は `ReflectResult` と書いている。**正典を採った**（決定2）。
    オーナーが動詞に揃えたいと言えば変える（`0.x` なので semver 上は許される）。

- **確かめていないこと**:

  - **本物の Postgres で `reflect` を走らせていない**（負債7）。この環境に DB が無く、
    ルートの `pnpm run test` は「⚠ DB テストは実行していません（DATABASE_URL が未設定）」と
    告知して緑になった（ADR 0015）。**その緑を「全部通った」と読んではいけない。**
  - 🔴 **`reflect` が想起を良くするかを1つも測っていない。**北極星の問い1
    （`docs/north-star.md:58`、最も強い問い）に対して、この PR が言えるのは
    **「既定の経路を1バイトも変えていないので、測った数字は動かない」**までである
    ——`observe` / `recall` に呼び出しを1つも足しておらず、
    `examples/chat/retrieval-baseline.json` も1バイト変えていない。
    ⚠ **これは「増やした分だけ想起が良くなる」ことの証明ではない。**
    その測定は却下案9 のとおり**いまの器では構造的にできない**（カセットは入力が固定される）。
    **⟹ この PR は問い1 に「既定を変えないので悪化させない」と答えたが、
    「良くする」とは答えていない。**
  - **LLM が実際に良い一般化を作るかを測っていない。**歯はすべて決定的な擬似 provider に対して
    走っており、`deterministic` 層の応答は意味を持たない（`AGENTS.md`:
    「⚠ `deterministic` で測った想起の質は、性能について何も言っていない」——arm A の MRR は 0.018）。
    **この PR が測っているのは配線と契約であって、内省の質ではない。**
  - **決定9（自己増幅を止める）が実運用で十分かを測っていない。**
    1段の自己参照は止まるが、`consolidate` を挟んだ迂回（`reflected` を `consolidate` して
    `consolidated` にし、それを土台にする）は止まらない。**塞いでいない。**
  - **`reflect` を実際の利用者（Issue #104 の報告者）が使えるかを確かめていない。**
    `target` を必須にしたことで、報告者の「ルールが自動で育つ」という期待に対しては
    **呼び出し側がまだ「いつ・何を」決める必要が残っている。**
