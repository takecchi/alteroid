# ADR 0089: `Runtime.consolidate()` の形を決める — 統合は3層のどれでもなく、`superseded` を使う

- **状態**: 採用 (2026-09)

- **文脈**:

  ## この ADR が決めていないこと

  🔴 **「`consolidate()` を実装するかどうか」は、この ADR の対象ではない。既に決まっている。**
  ADR 0087（`forget`）が確立した手続きを踏襲する——番号を割り当てる前に
  「その決定は既に在るか」を現物で問うた。**在った。**以下は現物からの逐語である。

  - `docs/vision.md` §「外から見える API: 5つの動詞」（`:53-65`）:
    「mnemora が外部に公開する操作は5つの動詞に限る。**6つ目は作らない。**」——
    その4つ目が **`consolidate(ctx, opts)   // -> ConsolidationResult`** であり、
    「`consolidate` — 複数の記憶を統合して、より上位の記憶を作る。」と説明されている。
  - `docs/README.md`（`:39`）: 「`observe()` / `recall()` / `reflect()` / `consolidate()` /
    `forget()` の5つ。**6つ目は作らない。**」
  - `docs/architecture.md` §3.2「背景系 — `reflect(ctx, opts)` / `consolidate(ctx, opts)`」（`:83-90`）:
    「`reflect / consolidate` → Scheduler が起動（または `runtime.tick()` が明示的に駆動）
    → `LLMProvider.completeStructured(...)` ── `provenance.kind = 'reflected' | 'consolidated'`
    → `MemoryStore.create(Memory)` → `EventStore.append`」
  - `docs/architecture.md`（`:244`）: 「統合（consolidate） | 複数 Memory → **1 Memory** +
    `provenance.sources`」——**N→1 である。**
  - 🔴 `docs/memory-model.md` §11 Memory lifecycle 表 **行5**（逐語）:
    「active → superseded | 抽出・**統合パイプライン**が置換を機械的に決定 |
    判定ロジック自体は非同期でよいが、書き込み（旧行の `status`/`superseded_by_id` 更新と
    新 Memory の作成）は1トランザクションで完結させる | `status='superseded'`、
    `superseded_by_id` | `superseded`」
  - 🔴 `docs/north-star.md`「この問いが、実際に案を落とすことの確認」表 **行4**（**正典**）:
    「問い4 | **「consolidate したら元の Memory を捨てる」** | **落とせた**
    （統合物は `basis` を解決できなければならない）」

  **⟹ 意味論（何が起きるか）は全部決まっている。**N→1 であること・統合先の
  `provenance.kind` が `'consolidated'` であること・統合元が `superseded` へ動くこと・
  **元を捨ててはならない**こと。

  ## Phase 1 の線を確認した結果

  ⚠ **Issue #103 の本文は「`CLAUDE.md` / `AGENTS.md` にも Phase 1 の範囲外と書かれているので、
  意図的な段階分けだと理解しています」と書いている。現物を読んで確かめたところ、
  この前提は事実ではなかった。**確認した先:

  - `docs/north-star.md`「やらないこと」（**正典**）— 10項目
    （独自 LLM の学習 / 独自 Embedding Model の学習 / GPU 基盤 / LangGraph の代替 /
    汎用 Workflow Engine / 完全な AGI シミュレーション / 人間の脳の忠実な再現 /
    複雑な感情シミュレーション / 3D Avatar / Voice Interface）。**統合は無い。**
  - `docs/vision.md`「やらないこと」— 同様に無い。むしろ `consolidate` は5動詞の1つ。
  - `docs/roadmap.md` §1.3「Phase 1 から明示的に外すもの」（`:44-50`）— 5項目
    （関係グラフ本体 / reranking / **`reflect()` の実運用** / `packages/bullmq` / HTTP server）。
    🔴 **`consolidate()` は無い。**同じ「背景系」の相方である `reflect()` は名指しで
    外れているのに、`consolidate()` は外れていない。
  - `docs/roadmap.md` §3 の Phase 2 / 3 / 4 の表——**`consolidate` はどの行にも現れない。**
  - `CLAUDE.md` / `AGENTS.md`（`CLAUDE.md` は `AGENTS.md` への symlink）— `:46-47` が
    「**Phase 1 に入っていないもの**は `docs/roadmap.md` §1.3 の通り（関係グラフ本体・reranking・
    `reflect()` の実運用・`packages/bullmq`・HTTP server）」と roadmap を**指すだけ**であり、
    独自の範囲の線を持たない。**`consolidate` という語は `CLAUDE.md` / `AGENTS.md` に1度も現れない。**

  ⚠ **唯一の反証は ADR 0035 §5「これが覆るとしたら」（`:156-158`）**である:
  「**Phase 2 で `consolidated` / `reflected` が実際に作られるようになったとき。**
  いまリポジトリが作る provenance は `stated` / `inferred` / `imported` の3種類だけであり、
  残る2値は型と CHECK 制約にしか存在しない。」
  **これは範囲の決定ではなく、その ADR が覆る条件の予想である**——
  「覆るとしたら」の節は、まさにこの瞬間に発火するために書かれている。
  そして**より新しい** ADR 0082（`:82`）は逆を書いている:
  「作業の途中で、**`consolidate` / `reflect` の本体は近いうちに実装される**という」。

  **⟹ 範囲内である。正典も `AGENTS.md` も1文字も書き換えていない。**書き換える必要が無かった。

  ## では何が無かったのか

  **公開 API としての口が無い。**現物（`036edc36` 時点、読んで確認した）:

  - `packages/core/src/runtime.ts` の `export interface Runtime` は
    `observe / tick / recall / reextract / reembed / forget` の**6つ**。`consolidate` は無い。
  - `ProvenanceKind` に `"consolidated"` は在り（`provenance.ts:9`）、
    `ConsolidatedProvenance { kind: "consolidated"; sources: string[] }` も在る（`:41-44`）が、
    **それを作る主体が1つも無い。**
  - `OutboxJobKind` に `"consolidate"` は在る（`interfaces/scheduler.ts:18`）が、
    `tick` に分岐は無い（ADR 0082 がこれを名指しで固定している）。
  - ADR 0074（`:260`）が既にこれを名指ししていた:
    「統合は `ProvenanceKind: "consolidated"` と `OutboxJobKind: "consolidate"` の**型だけ**が在り、
    ジョブハンドラが無い。」

  Issue #103（THE PHAGE の gurumi-chan-backend への導入検討中に見つかった外部フィードバック。
  #102 と同じ報告者）は、この穴が実運用で何を止めているかを書いている:
  既存エージェントが持つ「ローリング要約」を mnemora へ寄せられず、
  **「要約は呼び出し側、記憶は mnemora」と圧縮の主体が二重化する。**
  自前で書くこともできるが「`memories` の `status`（`superseded` 等）や `provenance` の
  意味づけは mnemora の設計に属する部分なので、外から触ると整合を崩しそうで手を出していない」。

  **⟹ 決めるべきものとして残っているのは、口の「形」だけである。**
  `target` の型・返り値の語彙・冪等性の作り方・**統合元をどの層で始末するか**。
  **これはどの ADR にも書かれていない。**だから新しい番号を起こす。

- **決定**:

  ## 決定1: 🔴 統合は3層（減衰 / `forget()` / `purge()`）のどれでもない。`superseded` を使う

  ADR 0087（#117）が確定した「落とす」の3層はこうである:

  | 層 | 何か | 誰が動かすか |
  |---|---|---|
  | **減衰** | 落とさず順位を下げる（オーナー確定、`docs/roadmap.md:219`） | 誰も明示的には動かさない。時間 |
  | **`forget()`** | 明示的な論理削除。`status='forgotten'`。**行も `content` も残る** | 利用者 |
  | **`purge()`** | 物理削除。**Phase 2** | 法的要求 |

  🔴 **`consolidate` はこの3つのどれも使わない。第4の位置＝`status='superseded'` を使う。**

  根拠は正典に既に在る:
  - `docs/memory-model.md` §11 行5 が「**統合**パイプラインが置換を機械的に決定」を
    `active → superseded` の遷移として名指ししている（上の逐語）。
  - `docs/recall.md`（`:69`）・`packages/core/src/recall.ts:33` が `superseded` を
    「**機構の都合**であり、`superseded_by_id` で置き換え先を辿れる」、
    `forgotten` を「**製品の振る舞い**であり、置き換え先を持たない」と区別している。
    **統合は機構の都合である**——利用者は「忘れてくれ」と言っていない。
  - 🔴 `docs/north-star.md` 行4 が「元の Memory を捨てる」を**落ちた案**として記録している。
    `superseded` は行も `content` も残し、`superseded_by_id` で統合先を辿れる
    ⟹ **統合物の `provenance.sources` から元を解決できる**（＝「`basis` を解決できなければ
    ならない」を満たす）。`forgotten` にすると「利用者が忘れさせた」と嘘になり、
    `purge` にすると解決できなくなる。**3層のどれを選んでも正典に反する。**

  ⚠ **`forgotten` な Memory は絶対に統合元にしない。**先例は歯として既に在る
  （`runtime.test.ts:905`「🔴 forgotten の Memory は supersede されない（利用者が意図して
  忘れさせたものを機構の都合で上書きしない）」）。`consolidate` も同じ線を引く
  ——`active` 以外はすべて `status_not_active` として弾き、**弾いたことを名前で返す。**

  ## 決定2: 「無い」は3種類ではなく、2階層で割る

  🔴 **この repo で最も繰り返し現れた欠陥の族は「『無い』の種類を潰すこと」である**
  （ADR 0008 / 0026 / 0027 / 0028 / 0029 / 0043 / 0044 / 0076 / 0082 / 0087）。
  判定基準も確立している——**「その区別があると、呼び出し側の次の一手が変わるか」**（`docs/recall.md` §4）。

  `consolidate` は `forget` と違って**2つの層で「無い」が起きる**:
  呼び出し全体として何が起きたか（統合したのか／束ねるものが無かったのか／見ていないのか）と、
  対象1件ごとに何が起きたか。**1つの配列に潰すと、どちらかが必ず消える。**

  ⚠ **新語を作る前に既存の語彙を数えた。**`Omission` は11値、`ProvenanceKind` は5値、
  `MemoryStatus` は5値、`MemoryEventKind` は7値、`ForgetOutcome` は6値、`ReextractSkip` は4値。
  **対象1件ごとの語彙は `ReextractSkip` と `ForgetOutcome` からそのまま借りている**
  （`not_found` / `status_not_active` / `status_changed_concurrently` / `failed` / `not_attempted`）
  ——⛔ **新しい綴りを発明していない。**

  ### 層1: `ConsolidateOutcome`（呼び出し全体）

  | 値 | 何が起きたか | 呼び出し側の次の一手 |
  |---|---|---|
  | `consolidated` | 統合先を1件作り、少なくとも1件を `superseded` へ動かした | 無し（成功） |
  | `nothing_to_consolidate` | **見た上で**、束ねるものが無かった | `nothingReason` を見る。**LLM は呼んでいない**（費用ゼロ） |
  | `not_examined` | **見ていない**（対象が空・`query` が0件） | 対象の選び方を疑う |
  | `llm_failed` | LLM が落ちた。**1件も書いていない** | provider を直して呼び直す |
  | `dry_run` | 下見だけ。**1件も書いていない** | `sources` の `eligible` を見て本番を判断する |

  🔴 **`nothing_to_consolidate` と `not_examined` を束ねない。**どちらも「何も起きなかった」だが、
  前者は「探して無かった」、後者は「そもそも探していない」であり、
  **`docs/north-star.md`「目指す姿」が名指しで区別を要求している**
  （「知らないことを、知らないと言える。——『見つからなかった』と『探していない』を、同じ顔で返さない。」）。

  `nothingReason` はさらに2値に割る:
  - `no_eligible_sources`: `active` な対象が0件（全部 `forgotten` / 既に `superseded` / 存在しない）
  - `single_eligible_source`: `active` が1件だけ。**1件を1件に「統合」しない**

  🔴 **この2つを束ねない。**前者は「対象の選び方が悪い」、後者は「もう1件見つければ統合できる」であり、
  次の一手が違う。

  ### 層2: `ConsolidateSourceOutcome`（対象1件ごと）

  `sources` は**入力と同じ順序・同じ長さ**である（`ForgetResult.outcomes` と同じ規律）。

  | kind | 何が起きたか | 次の一手 |
  |---|---|---|
  | `superseded` | 統合元になり `status` が動いた。`superseded` イベントが1件残った | 無し |
  | `not_found` | そのテナントにその id が無い | id の出所を疑う |
  | `status_not_active` | 見た上で弾いた（`forgotten` / 既に `superseded` / `archived` / `contested`） | `status` を見る。**`forgotten` はこれで守られる** |
  | `status_changed_concurrently` | CAS が破れた（読んでから書くまでに割り込まれた） | 読み直してもう一度呼ぶ |
  | `failed` | 予期しない例外。**ここで打ち切られている** | 例外の中身を見る |
  | `not_attempted` | **見ていない。**先行の `failed` で打ち切られた | そのまま再送してよい |
  | `eligible` | `dryRun` のとき「これが束ねられるはず」 | 本番を撃つ |

  ⛔ `consolidatedCount` のような派生値は足さない（`sources` から数えられる。ADR 0087 決定2 と同じ）。
  ただし **`llmCalls` は足す**——これは `sources` から導けない実測値であり、
  Issue #103 が名指しで要求している（「LLM を何回呼んだか（コストの見通しが立つ）」）。

  ## 決定3: 冪等性は「読んで status で弾く」で買う。専用の冪等キーを作らない

  同じ対象を2回 `consolidate` したら何が起きるか。**手順の順序がそのまま答えである:**

  1. `getMany(ctx, ids)` で一括読み
  2. `active` でないものを弾く（`status_not_active`）
  3. **eligible が 2 件未満なら、LLM を呼ばずに `nothing_to_consolidate` を返して終わる**
  4. LLM を1回呼ぶ
  5. 統合先を作る
  6. eligible を1件ずつ CAS で `superseded` へ

  🔴 **2回目の呼び出しでは、1回目で全部 `superseded` になっているので手順3で止まる。**
  ⟹ **LLM は呼ばれず（`llmCalls: 0`）、Memory は増えず、イベントも積まれない。**
  **これが冪等性の実装そのものである**——`(tenantId, sources のハッシュ)` のような
  専用の冪等キーを新しく発明していない。⛔ 新しい索引もマイグレーションも足していない。

  ⚠ **手順3を手順4より前に置くことが芯である。**逆にすると、2回目でも LLM を呼んでから
  「書くものが無い」と気づくことになり、**冪等な再送が毎回課金される。**
  北極星の問い5（「これは、LLM を呼ばずに済ませられないか」）の適用。

  並行については `reextract` / `forget` と同じ道具を使う——`expectedStatus: "active"` の
  compare-and-swap（ADR 0030）。破れたら `status_changed_concurrently` として**その1件だけを飛ばして続行**し、
  🔴 **再試行のループは回さない**（上限が書けない。ADR 0087 決定3 と同じ）。

  ## 決定4: `dryRun` は LLM を呼ばない

  Issue #103 は「`dryRun` があると、本番へ入れる前に**どれが束ねられるはずか**を
  確認できて安心です」と書いている。**「どれが」であって「どう束ねられるか」ではない。**

  ⟹ `dryRun: true` は手順4より前で打ち切る——**`llmCalls: 0`、書き込みゼロ。**
  北極星の問い5 の適用であり、「安心のための下見」が課金されないことは
  下見という機能の存在意義そのものである。

  ## 決定5: 複数対象の原子性は買わない。§11 行5 の1トランザクションは**満たしていない**

  🔴 **正直に書く。`docs/memory-model.md` §11 行5 は「旧行の `status`/`superseded_by_id` 更新と
  新 Memory の作成は1トランザクションで完結させる」と要求しているが、この実装は満たしていない。**

  満たせない理由は道具が無いことである。現物の `MemoryStore` を読んで確認した
  ——`updateStatusWithEvent` の doc コメント自身が**この欠落を名指ししている**（逐語）:

  > また、docs/memory-model.md §11 行5 が規定する「旧行の status 更新と*新 Memory の作成*も
  > 1トランザクション」は**このメソッドの範囲外**——新しい Memory の作成（`createMemory`/
  > `createMemoryWithOutbox`）は別の呼び出しのままであり、このメソッドは既存 Memory の
  > status 更新とイベント追記の対だけを扱う（ADR 0031「これが覆るとしたら」参照）。

  ⚠ **これは新しく開けた穴ではない。**`reextract` が**既に**同じ形で動いている
  （`runtime.ts`: `createMemoriesFromCandidates` で作ってから、`updateStatusWithEvent` の
  ループで supersede する）。**この PR は §11 行5 の未達に2人目の呼び手を足しただけであり、
  線を新しく踏み越えてはいない。**

  **書く順序で被害を最小にしている**——統合先を**先に**作る:
  - 途中で落ちた場合、統合先は在り、一部の元がまだ `active` のまま残る
    ⟹ **`recall` に重複が残る**（統合が解こうとした問題そのものが一部残る）が、
    **失われるものは無く、監査ログも矛盾しない。**
  - 逆順（先に supersede）にすると、統合先が作られる前に元が `superseded` になり、
    `superseded_by_id` の指す先が無い状態が永続化しうる。**そちらのほうが悪い。**

  予期しない例外が出たら**そこで打ち切り**、残りを `not_attempted` にして**返す**（投げない）
  ——ADR 0087 決定5 と同じ。🔴 **例外を投げないのは、部分的に起きたことを
  呼び出し側から見えなくしないためである。**

  ## 決定6: `MemoryEventKind` に値を足さない。`meta.reason` の2つ目の値を使う

  `MemoryEventKind` は7値（`created | updated | superseded | archived | forgotten | purged | events_purged`、
  `event.ts:8-9`）。**`consolidated` は無い。⛔ 足さない。**

  - 統合先の新 Memory ⟹ `created`（`createMemoryWithOutbox` が積む既存経路）
  - 統合元 ⟹ `superseded` ＋ **`meta.reason: "consolidated"`**

  `docs/memory-model.md` §9 が「『状態が実際に変わった大分類』だけを列挙し、
  **理由の粒度は `meta` に落とす**」と規定しており、ADR 0087 決定1 が
  `forget` で同じ判断を採っている。**同じ族の判断をここでも採る。**

  ### 🔴 ADR 0074 の予言が、この PR で発火した

  ADR 0074（`:255-266`）は逐語でこう書いていた:

  > 監査ログ側も同じで、`MemoryEvent.meta.reason` に実際に入る値は文字列リテラル
  > `"reextract_superseded"` の1種類だけである。
  > **⟹ いま `superseded` に流れているのは「訂正」1種類であり、`recall.ts:382` の
  > 「機構の都合」という doc は、現時点では正確である。**
  > **⟹ この項は「いま壊れている」ではなく、「2つ目の書き手（統合か矛盾解決）が
  > 入ったときに壊れる」という予言である。**

  **統合が2つ目の書き手である。**⟹ `superseded` イベントの `meta.reason` は2値になった（`"reextract_superseded"` と `"consolidated"`）。⚠ `created` イベントの `meta.reason` は別の系列であり（`"extracted"` 等）、そちらとは混ざらない。
  ⟹ `superseded` を「**より良い抽出に置き換えられた**」と説明している doc コメントは
  **不正確になった。**現物を検索して見つかった4箇所を、括弧の中身だけ直した:
  `packages/core/src/recall.ts:33` / `:490` / `packages/core/src/recall-runtime.ts:806` /
  `packages/postgres/src/memory-store.ts:645`。

  ⛔ **`supersededReason` を第一級の列として足していない。**ADR 0074 が検討したものだが、
  `docs/memory-model.md` §9 の規律（理由の粒度は `meta`）に反する。負債として下に記録する。

  ## 決定7: `tick` を触らない。ADR 0082 の時限式の歯は書き換えない

  ⚠ `docs/decisions/0082-...` は2箇所で、この PR に tick を触らせようとする:
  - `:216`「`consolidate` / `reflect` の本体を実装する人は、`TICK_SUPPORTED_JOB_KINDS` に kind を足し、」
  - 歯自身の doc（`runtime.test.ts:794-808`）「**本体が入ったら、この歯は赤くなる。それが正しい。**」

  ⛔ **それでもこの PR は tick を触らない。**理由は Issue #103 本文が名指しで分けているからである（逐語）:

  > `tick()` のジョブとして回せる形（`OutboxJobKind` の `"consolidate"` が実際に処理される）だと、
  > 常駐処理に載せやすいです。**これは別途 issue を立てます。**

  outbox ジョブの payload の形（誰が対象を選び、いつ積むのか）はそれ自体が独立した設計であり、
  `docs/autonomy.md` §2「1つの PR は『1つの ADR とその実装』」「**⚠「ついでに直す」をしない**」に従う。

  ⟹ **`TICK_SUPPORTED_JOB_KINDS` は `["extract","embed"]` のままであり、
  時限式の歯は緑のままで、その主張は依然として正しい**——tick に `consolidate` の分岐は無い。

  ⚠ **ただし「本体」という語が2つを指してしまう**——`Runtime.consolidate()` という
  **動詞の本体**（この PR で入った）と、**tick の分岐**（まだ無い）。
  ⟹ 歯の doc コメントに、その区別を1文だけ足した。⛔ **アサーションは1文字も変えていない。**
  次に読む人が「時限式が不発だった」と誤読するのを防ぐためだけの追記である。

  ## 決定8: `DeterministicLLMProvider` に統合用スキーマの分岐を足す

  現物を読んで見つかった穴: `packages/testkit/src/__fixtures__/deterministic-llm-provider.ts` は
  **`ExtractionResultSchema` の形しか知らず**、それ以外のスキーマには
  `"DeterministicLLMProvider: 未対応のスキーマが渡された"` を**投げる。**

  ⟹ **拡張しないと、`Runtime.consolidate()` を `deterministic` 層で呼んだ瞬間に必ず落ちる。**
  `AGENTS.md` はこの層を「配線・契約・適合テスト」用と位置づけている
  ——**配線を検査するための道具が、新しい配線で落ちるのでは役に立たない。**
  ⟹ 統合用スキーマの分岐を足した。⚠ **既存の `ExtractionResultSchema` 経路のふるまいは
  1ミリも変えていない**（分岐を足しただけ）。

  ## 変異試験で分かったこと（歯を「置いた」と「測っている」は違う）

  歯を20本置いたあと、実装を意図的に壊して**どの歯が赤くなるかを目で見た**。
  8つの変異のうち7つは「赤くならなければならない」もの、1つは
  **「赤くなってはいけない」もの**（ふるまいを変えない書き換え）である。
  ⛔ `grep` で数える歯は1本も置いていない（変数経由の埋め込み・折り返しで割れた文・
  行内の装飾の3つで静かに落ち、落ちる向きは常に「一致0件」＝緑になるため）。

  | 変異 | 壊した内容 | 結果 |
  |---|---|---|
  | M1 | `single_eligible_source` の分岐を消す | 🔴 2本が赤（1件だけの歯・`{query}` の歯） |
  | M2 | `expectedStatus: "active"` を外す（CAS を消す） | 🔴 1本が赤（並行の歯） |
  | M3 | `dryRun` の早期 return を消す | 🔴 1本が赤（`dryRun` が LLM を呼び書き込んでしまう） |
  | M4 | `not_found` を `status_not_active` に丸める | 🔴 1本が赤 |
  | M5 | 打ち切りの `break` を `continue` にする | 🔴 1本が赤（`not_attempted` の歯） |
  | M6 | `meta.reason` を `"reextract_superseded"` にする | 🔴 1本が赤（監査ログの歯） |
  | M7 | `buildConsolidatedMemory` の `subjectId` を常に `null` にする | 🔴 1本が赤（純関数の歯） |
  | M8 | `for (let i…)` → `for (const [i, id] of eligibleIds.entries())` | ✅ **緑のまま**（ふるまいを変えない書き換えで赤くならない＝歯が実装の*形*を固定していない） |

  ⚠ **M8 が緑であることは、M1〜M7 が赤であることと同じくらい重要である。**
  歯が実装の形（ループの書き方）ではなく**ふるまい**を測っていることの確認であり、
  これが赤くなる歯は、無害な整理のたびに赤くなって信用を失う。

  ⚠ **変異を戻すのに `git checkout` を使っていない**（`docs/autonomy.md` §4 が記録している
  「未コミットの編集も一緒に消える」穴）。`cp` で退避した写しから戻し、
  **戻した後に元ファイルと `diff` を取って byte 単位で一致することを確認した。**

- **検討して採らなかった案**:

  1. **統合元を `forgotten` にする。**
     却下。決定1。`forgotten` は「利用者が明示的に忘れさせた」という**製品の振る舞い**であり
     （`docs/recall.md:69`）、統合は利用者が頼んだ忘却ではない。**監査ログが静かに嘘をつく。**

  2. **統合元を消す（物理削除・行の削除）。**
     却下。🔴 **`docs/north-star.md` 行4 が「落ちた案」として名指しで記録している。**
     統合物は `basis` を解決できなければならない。加えて物理削除は `purge()`（Phase 2）の担当。

  3. **`MemoryStatus` に `consolidated` を足す。**
     却下。ADR 0087 決定1 と同じ3つの理由。特に、`superseded` を判定している箇所
     （recall の status ゲート・postgres の集約 SQL・`ScopeAggregate`）が
     **独立にずれる面が増える**——ADR 0082（issue #105）の根がまさにそれだった。

  4. **`MemoryEventKind` に `consolidated` を足す。**
     却下。決定6。`docs/memory-model.md` §9 が「理由の粒度は `meta` に落とす」と規定している。

  5. **`MemoryStore` に「統合先の作成と統合元の supersede を1トランザクションで行う」
     メソッドを足す（§11 行5 を実際に満たす）。**
     却下——**ただし「正しいが重い」ので落としたのではない。**
     `MemoryStore` は「差し替え可能」であることが `packages/testkit` の適合テストで
     保証されている公開 interface であり、**必須メソッドを足すことは
     第三者の adapter 実装を壊す**（`docs/autonomy.md` §3: 公開 API の破壊的変更は
     **やらずに提起する**）。加えて `reextract` が既に同じ未達で動いており、
     **この PR だけが線を越える理由が無い。**⟹ 負債として下に記録し、提起にとどめる。

  6. **`dryRun` でも LLM を呼び、統合後の本文を先に見せる。**
     却下。決定4。Issue が求めているのは「どれが束ねられるはずか」。
     北極星の問い5。⚠ **これは後から足せる**（`dryRun: 'preview'` のような値を増やせばよい）
     ——先回りして作らない（ADR 0024）。

  7. **`{ maxCandidates }` だけを渡して「統合すべき組を mnemora が自分で見つける」形。**
     却下。Issue #103 の提案にはこの形が在るが、**「どの記憶が同じ事実の言い換えか」を
     決める方針（クラスタリング）は正典のどこにも書かれていない。**
     `docs/architecture.md:244` が定義しているのは「複数 Memory → **1 Memory**」という
     N→1 の操作であって、「N を複数の組に割る」ではない。
     組の割り方を発明すると、それは**この ADR が決めていない設計を黙って決めること**になる。
     ⟹ `{ memoryIds }`（明示）と `{ query, maxCandidates }`（`recall` で引いた集合を N→1）の
     2つだけを実装した。**`maxCandidates` は「1回の統合に入れる上限」として残っている。**
     🔴 **これは Issue の提案の一部を満たしていない。**下の負債に記録し、PR 本文にも書いた。

  8. **`tick` の `consolidate` ジョブも同じ PR で実装する。**
     却下。決定7。Issue #103 自身が「別途 issue を立てます」と書いている。

  9. **`consolidate` の結果を1つの配列に潰す（`ForgetResult` と同じ形にする）。**
     却下。決定2。`consolidate` は `forget` と違って呼び出し全体としての結末を持つ
     （束ねたのか／束ねるものが無かったのか／LLM が落ちたのか）。
     対象ごとの配列だけにすると、**「LLM が落ちた」と「対象が全部 `forgotten` だった」が
     どちらも「1件も `superseded` になっていない配列」という同じ顔になる。**

- **引き受ける負債・覆えていない範囲**:

  1. 🔴 **`docs/memory-model.md` §11 行5 の「1トランザクション」を満たしていない**（決定5）。
     途中で落ちると、統合先が在るのに一部の元が `active` のまま残る
     ⟹ `recall` に重複が残る。**失われるものは無く、再度 `consolidate` を呼べば残りを束ねられるが、
     そのときは2つ目の統合先ができる**（1つ目の統合先は `active` のままなので、
     2回目の対象に含めれば3つ目に束ねられる——収束はするが、中間物が残る）。
     ⚠ **`reextract` も同じ未達であり、この PR が線を新しく越えたのではない。**
     塞ぐには `MemoryStore` に新しい口が要る（却下案5）。

  2. **`{ maxCandidates }` 単独（クラスタリング）を実装していない**（却下案7）。
     Issue #103 の提案の3分の1が未達である。

  3. **`supersededReason` を第一級の判別子にしていない**（決定6）。
     ADR 0074 が予言したとおり `meta.reason` は2値になったが、
     **`meta` は `Record<string, unknown>` であり型で守られていない。**
     3つ目の書き手（矛盾解決）が入るときに、この判断を見直す価値がある。

  4. **統合先の埋め込みは非同期である。**`createMemoryWithOutbox(..., ["embed"])` で
     `embed` ジョブを積むだけであり、`tick` が回るまで統合先は `embeddingStatus: 'pending'` で
     **ANN の候補に入らない。**⟹ **`consolidate` の直後に `recall` すると、
     元は `superseded` で落ち、統合先はまだ引けない、という窓が開く。**
     これは `observe` の抽出経路と同じ性質であり、新しい問題ではないが、
     **`consolidate` では「元が引けなくなる」ぶん、窓の影響が大きい。**塞いでいない。

  5. **本物の Postgres に対して `consolidate` を通していない。**
     この作業環境に `DATABASE_URL` が無く、DB テストは実行していない。
     ただし `consolidate` は `packages/core`（＋ `packages/testkit` の擬似 provider 1ファイル）
     だけの変更であり、`updateStatusWithEvent` / `createMemoryWithOutbox` の Postgres 実装は
     既存の適合テストで測られている。**CI が DB 付きで走るので、そこが実測の場である。**

  6. **`ConsolidateSourceOutcome` の7値が「多すぎる」か「足りない」かは、実利用のフィードバックが無い。**
     Issue #103 の報告者は返り値の中身について「何件が何件になったか」と「LLM を何回呼んだか」
     しか具体案を出していない。

- **これが覆るとしたら**:

  - **`tick` の `consolidate` ジョブ（別 issue）が入ったとき。**そのとき
    `TICK_SUPPORTED_JOB_KINDS` に kind が足され、ADR 0082 の時限式の歯が**実際に赤くなる**。
    足す人がその歯を書き換えるところまでがその作業である（ADR 0082 がそう書いている）。
    加えて、ジョブの payload が「どの memoryId を束ねるか」を運ぶのか
    「探せ」と言うだけなのかで、却下案7（クラスタリング）の判断が再燃する。
  - **矛盾解決（`contested` を作る主体）が Phase 2 で入ったとき。**
    `meta.reason` が3値になり、負債3（`supersededReason` を型で守る）が実際に痛む。
  - **`MemoryStore` に「作成と supersede を1トランザクション」の口が入ったとき**（却下案5）。
    そのとき `reextract` と `consolidate` の両方を新しい口へ寄せる判断が要る。
    **先回りして片方だけを寄せない。**
  - **負債4（埋め込みの窓）が実運用で痛んだら。**候補: `consolidate` が同期で埋め込みを取る
    （`observe` の `extract: 'sync'` と同じ形）／統合先が `pending` の間だけ元を
    `active` に残す（＝ supersede を遅らせる）。**今は決めない**——どちらも
    「背景系は無効にできる」（北極星の問い2）との兼ね合いを検討していない。
  - **`ConsolidationResult` という型名。**`docs/vision.md` が `ConsolidationResult` と書いており、
    Issue #103 は `ConsolidateResult` と書いている。**正典を採った。**
    オーナーが動詞に揃えたいと言えば変える（`0.x` なので破壊的変更は semver 上許される）。

- **確かめていないこと**:

  - **本物の Postgres で `consolidate` を走らせていない**（負債5）。この環境に DB が無い。
  - **`examples/chat` に `consolidate` を配線していない。**北極星の物差し
    （「使う側が、会話ログを全部プロンプトへ積むのをやめられたか」）に対して
    **統合が実際に効くかどうかを、この PR は1つも測っていない。**
    Issue #103 は「合計としては削減効果が出にくい」ことを動機に挙げているが、
    **その削減が実際に起きるかは測っていない。**⚠ これは「効かない」という意味ではなく、
    「測っていない」という意味である。
  - **LLM が実際に良い統合を作るかを測っていない。**歯はすべて決定的な擬似 provider に対して
    走っており、`deterministic` 層の応答は意味を持たない（`AGENTS.md`:
    「⚠ `deterministic` で測った想起の質は、性能について何も言っていない」）。
    **この PR が測っているのは配線と契約であって、統合の質ではない。**
  - **並行の歯は fake に対して測っており、実 DB の行ロックの振る舞いは測っていない**
    （ADR 0087 と同じ）。特に「ガードで弾かれる `UPDATE` が行ロックを取るかどうか」は
    この ADR の主張の根拠にしていない。
