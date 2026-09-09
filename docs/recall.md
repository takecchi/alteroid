| `not_indexed` | 記憶は存在するが埋め込みがまだ無いと分かる（`embeddingStatus`、`./memory-model.md` 参照）。記憶が失われたと誤認しない。**`reason` によって次の一手が分かれる**——`pending` は待つ・再試行する、`failed` は埋め込みパイプラインそのものを疑う、`skipped` は意図した除外なので何もしなくてよい。この3つを1つに潰すと、恒久的な失敗と一時的な遅延が同じ顔になる（2026-09 追記。当初案は `reason` を持たなかった）。 |# recall — 想起パイプラインと説明可能性

`recall(ctx, query) -> RecallResult` は mnemora の中で最も説明責任が重い操作である。ここが返すものが、上位のアプリケーションが LLM に渡す文脈そのものになる。

`docs/vision.md` で述べた一本の原則「文脈を剥がして提示しない」には三つの現れがあるとした。

1. 争われている主張は、それを争う相手と必ず同時に提示する
2. 推論は、その根拠と必ず同時に提示する
3. 結果は、そこから漏れたものと必ず同時に提示する

この文書はほぼ全体が3番目の現れの実装である。`recall()` は「何を返したか」と同じ重さで「何を返さなかったか、なぜか」を返す。それが本文書の主題であり、`RecallResult` の型そのものに刻まれている。

---

## 1. Recall が返すもの

まず全体像を型で示す。

```ts
type RecallResult = {
  | { kind: 'not_indexed'
      reason: 'pending' | 'failed' | 'skipped'
      count: number; countKind: CountKind }recallId: string              // 記録された recall の識別子。observe() の usage 報告で使う
  memories: RecalledMemory[]    // 返ったもの。score 内訳 + 取得理由つき
  omitted: Omission[]           // 返らなかったものの分類（§4）
  index: IndexBand              // 目次帯。被覆不変条件を担う（§5）
  usage: RecallUsage            // 焼かれた量の計測（§6）
  explain: { stages: StageTrace[] } // どの段が走り、どの段が走らなかったか（§2）
}
```

`memories` と `omitted` は対になる二つのフィールドであって、片方が主でもう片方が付録ではない。型定義上も並び順上も対等に置く。呼び出し側のコードが `omitted` を無視して `memories` だけを使うことは自由だが、mnemora の側が「無視してよい」という前提で設計してはならない——`omitted` を計算しない・空配列で済ませる、という手を抜く経路を作らない。

`index` と `usage` も同じ理由でトップレベルに置く。「何が在るか」（index、§5）と「どれだけの量を返したか」（usage、§6）は、`memories` の中身をどう解釈するかに直接影響する周辺情報であり、後から復元できない。`explain.stages` はパイプラインの実行そのものの記録であり、次節で扱う。

以降の節はこの型の各フィールドを埋めていく作業である。

---

## 2. パイプラインの段

recall は次の7段からなる。各段は「入力」「出力」「落ちるものの理由」「索引が効くか」を持つ。

| 段 | 名称 | 索引 | 概要 |
|---|---|---|---|
| 0 | スコープ確定 | — | tenant / subject / 時間窓 / taxonomy を確定する |
| 1 | 候補生成 | **効く** | ベクトル ANN / タグ一致 / 直近。over-fetch する |
| 2 | 再スコア | 不要（O(k')） | 減衰 × 類似度 × タグ × 鮮度 × 強度 |
| 3 | 矛盾の解決 | — | `contested` の同伴を必須取得する |
| 4 | 予算による切り詰め | — | 文字数 / トークン予算で k をさらに絞る |
| 5 | 目次帯の構築 | 集約クエリ | 群カウントを取る |
| 6 | 記録 | — | `recalls` へ書き込み、`recallId` を発行する |

パイプラインの契約として次を明示する。**各段は「なぜ落としたか」を Omission の形にして次の段へ渡す。落とした理由をパイプラインの外で後から復元しようとしない。** 段2で閾値未満として落ちた記憶の識別子とスコアは、段2の中で `Omission { kind: 'below_threshold', ... }` として確定させ、それ以降の段はこれを積み上げるだけにする。パイプラインの最後に「結局何が何件落ちたか」を集計し直す構造にはしない——集計し直す設計は、集計ロジックが実装と乖離した瞬間に `omitted` が嘘をつき始める。

### 段0: スコープ確定

入力: `ctx`（`tenantId`, `subjectId?`）と `query`（自然文またはベクトル、taxonomy フィルタ、時間窓）。
出力: 段1に渡す確定済みの `WHERE` 条件一式。
このスコープの外にある Memory は recall の対象になりようがないので、`omitted` にも `index` にも現れない。これは「無い」の分類の対象外であることに注意する——スコープ外は「無い」ではなく「そもそも問うていない」であり、`index` が示す「スコープ内に何が在るか」の母集団を確定する段である。

#### スコープの外延（2026-09 追記。マネージャー決定。欠けていた定義の補完であり、既存記述の訂正ではない）

上の段落は「スコープ」を tenant / subject / 時間窓 / taxonomy と書いているが、これだけでは外延が確定しない。§4 の `FilteredOmission.condition` には `'status'` / `'archived'` が別途存在し、§5 の被覆不変条件（「スコープ内の全 Memory は、返るか群カウントに乗るかのどちらか」）を検査しようにも、「スコープ」に `status` が入るのか入らないのかが決まらなければ、この不変条件は機械的に検査できない。ここでその外延を確定する。

**決定: スコープ = tenant + subject + 時間窓(period) + taxonomy + status ゲート。** status ゲートは段1の候補生成と同じ `status IN ('active', 'contested')` である。

- **tenant と subject はスコープの外側の境界である。** 呼び出し側が明示した境界の外は「失われた」のではなく「そもそも問うていない」——ちょうどこの段落が「スコープ外は『無い』ではなく『そもそも問うていない』」と述べているのと同じ扱いであり、`Omission`（§4）としては報告しない（`FilteredOmission.condition` に `'tenant'`/`'subject'` の値が無いことと対応する。`'tenant'` という値自体は型として残っているが、Phase 1 の recall はテナント境界の外を問うことが構造的に無いため、実際には発生しない）。
- **period・status（archived / superseded / forgotten）が実際に `filtered` として報告される次元である。** status ゲートで落ちる Memory はさらに三分する——`status = 'archived'`（`condition: 'archived'`）、`status = 'superseded'`（`condition: 'superseded'`）、`status = 'forgotten'`（`condition: 'forgotten'`）。分ける理由: `archived` は「使われなくなって静かに遠ざかった」ものであり、強化すれば戻ってくる可能性がある（次の一手が違う）。`superseded` はより新しい Memory が既に別の形で返るはずのもの（**機構の都合**であり、`superseded_by_id` で置き換え先を辿れる）、`forgotten` は利用者が明示的に忘れさせたもの（**製品の振る舞い**であり、置き換え先を持たない）で、互いに次の一手が異なる（[ADR 0027](./decisions/0027-split-superseded-forgotten-omission.md)）。以前はこの2つを単純に `'status'` という1つの condition へ丸めていたが、それでは「利用者が忘れてほしいと言ったのか、こちらが作り直しただけなのか」を呼び出し側が判定できなくなる。
- **taxonomy は Phase 1 に実体が無い**（labels/memory_labels は Phase 2、[./memory-model.md](./memory-model.md) §8）。したがって Phase 1 のスコープの taxonomy 次元は常に無条件であり、`Omission { kind: 'filtered', condition: 'taxonomy' }` は Phase 1 では発生しない（型としては残す）。

**件数はすべて単一の集約から取る。** `IndexBand.totalInScope` と `groups`、および `filtered` 系 Omission の件数・`not_indexed` の件数は、すべて同じ1回の集約クエリ（`MemoryStore.aggregateScope`）から得る。ADR 0011 が段1の `count(*) OVER ()` を締め出したのと同じ理由——**別々のクエリから出すと、その間の書き込みで総和が一致しなくなる**——がここでも成り立つ。

**帰結**: スコープ内で落ちたもの(`not_indexed` / `below_threshold` / `over_limit` / `budget_dropped` / `ann_truncated`)はすべて群カウントに乗っている。スコープを定義するフィルタ(period / taxonomy / status)で落ちたものは群カウントには乗らない。これが被覆不変条件の実質的な中身である——「在るなら出せるはず」と読める形で `forgotten`/`superseded` まで群カウントに数えることはしない。

### 段1: 候補生成（索引が効く）

入力: 段0のスコープ、埋め込みベクトル（あれば）、タグ集合。
出力: 上位 k' 件の候補（k' = 最終的に欲しい件数 k × over-fetch 係数）。
索引が効く段。ANN・タグ一致・直近取得を並行して行い、候補プールに合流させる。ここで over-fetch する理由と設計は §3 で詳述する。

埋め込み provider が使えない、あるいはクエリに埋め込む内容が無い場合、ベクトル候補生成という**経路そのものが走らない**。これは 0 件ではなく `Omission { kind: 'stage_skipped', stage: 'candidate_generation', reason: 'embedding_provider_unavailable' }` として記録する。タグ一致や直近取得が別途走っていれば `memories` が空にならないこともある——「ベクトル検索だけが止まった」という情報は、それ単体で呼び出し側の次の一手（フォールバックするか、埋め込み待ちの再試行をするか）を変える。

**Phase 1 の範囲(2026-09 追記、本 PR の決定)**: 上記は3チャンネル(ANN・タグ一致・直近取得)が並行して走る一般形を述べているが、roadmap.md 段階4の完了条件は「二段検索(段1: 索引が効く形のフィルタ + ANN、段2: over-fetch した候補への再スコア)」とのみ明記しており、タグ一致・直近取得を独立した候補生成チャンネルとして要求していない。**Phase 1 は ANN の1チャンネルのみを実装する。** タグは段2の再スコア(§7)における加点要素としてのみ参加し、それ自体で候補を拾い上げる経路にはしない。したがって、embeddable なクエリが無い場合(`text`/`vector` のいずれも無い場合)、Phase 1 の `memories` は実際に空になる——「タグ一致や直近取得が別途走っていれば空にならないこともある」という上記の記述は Phase 2 以降でチャンネルを追加した場合に成立する記述であり、Phase 1 の実装はこの緩和を持たない。この限定は、embeddable な内容が無いクエリでは `omitted` に `stage_skipped` が付き、`memories` が空でも `index`(§5)が「スコープ内に何が在るか」を独立に示し続けることで、原則3の要求(「無い」を分類して見せる)は満たされたままである。

### 段2: 再スコア（索引が要らない。O(k')）

入力: 段1の候補 k' 件。
出力: 減衰・類似度・タグ一致・鮮度・強度を掛け合わせてスコアリングし直した上位 k 件（と、それ未満の残り）。
テーブル全体ではなく k' 件だけを触るので索引を必要としない。ここで閾値未満に落ちたものは `below_threshold`、閾値は超えたが k に入らなかったものは `over_limit` として記録する（§4）。

**⚠ 段2の閾値比較は網羅的な三分割である**（[ADR 0044](./decisions/0044-score-not-comparable-omission.md)）。`total >= threshold`（残す）・`total < threshold`（`below_threshold`）・**どちらでもない**（`score_not_comparable`）の3つで、`scored = passed + below_threshold + score_not_comparable` が常に成り立つ。「どちらでもない」が在りうるのは、`total` が `NaN` のとき **`>=` と `<` の両方が false になる**からである——以前この2つを独立した `filter` で書いていたため、その候補は返らないのに `omitted` にも現れず、**`omitted` が空配列になって「取りこぼしは無い」と誤答していた。**

### 段3: 矛盾の解決と必須の同伴取得

入力: 段2で残った候補。
出力: `contested` 状態の Memory について、対向する Memory（`contradicts` の相手）をスコアに関係なく候補に追加した集合。
既定の recall は `status = 'active'` のみを返し `superseded` を返さない。`contested` は単独で返してはならない——相手を必ず一緒に取得する（mandatory companion retrieval）。詳細な状態遷移とデータモデルは `./memory-model.md` の矛盾の扱いの節に譲る。ここでは recall パイプライン上の位置づけだけを扱う（予算と衝突したときの優先順位は §8 で述べる）。

### 段4: 予算による切り詰め

入力: 段3までの集合、`budget?`。
出力: 予算内に収まる部分集合。
文字数・トークン予算を超える分は `budget_dropped` として記録する。順序は「スコアの低いものから落とす」が既定だが、段3で確定した同伴ペアは分割しない（§8）。

### 段5: 目次帯の構築

入力: 段0のスコープ全体（段1〜4を通過したかどうかに関係ない）。
出力: `IndexBand`（§5）。
群カウントは段1〜4の絞り込みの影響を受けない——「スコープ内に何が在るか」を独立に数える段である。これが被覆不変条件の完全性を支える。

### 段6: 記録

入力: 最終的な `memories` と `omitted`。
出力: `recalls` テーブルへの1行と `recallId` の発行。
この段が走らないと `recallId` が発行できず、後段の `observe({ kind: 'memory_usage' })` が recall を参照できなくなる。したがって段6は**必須**であり、スキップ可能な段ではない（§4 の5つ目のケースと直結する）。

---

## 3. 二段検索と pgvector

pgvector の HNSW / IVFFlat 索引が効く条件は一つしかない。**`ORDER BY` が距離演算子（`<=>` 等）の結果そのもので、昇順であること。** これは確認済みの事実である。`ORDER BY (embedding <=> $1) * decay_factor` のように式にした瞬間、索引は使われずシーケンシャルスキャンに落ちる。

### ⚠ 二つの別問題を潰さない

recall のクエリ設計を考えるとき、次の二つは似て見えるが**別の問題であり、対処も別**である。この区別を本文書のどこであっても潰さない。

| | フィルタ問題 | スコア問題 |
|---|---|---|
| 何が起きるか | `tenant_id` / `status` / `decay_floor_at > now()` を伴う ANN で、フィルタ後の候補が薄いテナントだと ANN の再帰が浅すぎて候補を取りこぼす | 減衰・タグ・鮮度を「掛けて」並べたい。式にすると索引が死ぬ |
| 対処 | pgvector 0.8.0 で入った iterative index scan（`hnsw.iterative_scan = strict_order \| relaxed_order`）と `hnsw.ef_search` の調整 | over-fetch + 段2の再スコア（本節） |

**iterative scan はスコア問題の解決策ではない。** iterative scan はあくまで「`WHERE` フィルタの下で十分な候補数を確保する」ための機能であり、`ORDER BY` に式を書けるようにする機能ではない。フィルタ問題とスコア問題を同じ機構で解こうとすると、二つとも中途半端になる。mnemora は両方を別々に持つ:フィルタ問題は iterative scan で緩和し、スコア問題は over-fetch + 段2の再スコアという構造そのもので解く。

また、**partial index は離散値・低カーディナリティのフィルタに向く**というのが pgvector 公式の推奨であり、`status = 'active'` のような値には有効だが、`decay_floor_at > now()` のような**連続値の範囲比較**には向かない。この二つを取り違えると「索引を張ったのに効かない」という事故になる。連続値のフィルタで索引を効かせたい場合は、離散化したバケット（例:「直近30日」）を別列に持つ、という迂回はあり得るが、Phase 1 の scope には含めない。

### 段1のクエリ骨格

```sql
SELECT
  m.id,
  m.digest,
  e.embedding <=> $1              AS distance
FROM memory_embeddings_default e
JOIN memories m ON m.id = e.memory_id
WHERE m.tenant_id = $2
  AND m.status IN ('active', 'contested')  -- 誤り1の修正。後述
  -- AND m.decay_floor_at > now()          -- Phase 2 から有効（roadmap.md）。Phase 1 はこの行を含めない
ORDER BY e.embedding <=> $1
LIMIT $3;  -- k' = k × over-fetch 係数
```

`ORDER BY` には距離演算子の結果をそのまま置き、昇順のまま渡す。減衰・タグ一致はここでは掛けない——段2の仕事である。

**⚠ 2026-09 訂正が二つ入っている（PR #2、docs/decisions/0011-no-window-count-in-ann-stage.md に実測記録がある）:**

1. **`status` の条件を `'active'` 単独から `IN ('active', 'contested')` に広げた。** 当初案は `m.status = 'active'` のみだった。しかしこれでは `contested` な Memory が段1の候補集合にそもそも入らず、「争われている主張を、争われていない顔で出さない」（mandatory companion retrieval、`./memory-model.md` §5・本書 §8）が実装として成立しない。対応する索引（`idx_memories_recall_gate`、`./memory-model.md` §10）の述語も同じ形に修正済みである。
2. **`m.decay_floor_at > now()` の行を Phase 1 のクエリから外した。** roadmap.md の Phase 1 範囲の記述（「`decay_floor_at` 列は Phase 1 では書き込むだけ」「Phase 2 で `WHERE decay_floor_at > now()` を使い始めるだけ」）が一次資料であり、本書の当初案がこの行を最初から含めていたのは Phase 分けと矛盾していた。Phase 1 はこの行を持たない。索引の3列目としては最初から `decay_floor_at` を持つため、Phase 2 で読み取りに使い始める際に索引の作り直しは不要。
3. **`count(*) OVER ()` を段1のクエリから外した。** 当初案は「追加のクエリ無しに候補件数を正確に取得でき、`omitted.countKind = 'exact'` を安く出すための実務上の要である」としていたが、これは HNSW 索引の上では成立しないことが実測で分かった（PostgreSQL 18.6 + pgvector 0.8.6、50万行）。索引スキャンを使うプランでは `count(*) OVER ()` の値は真の候補件数ではなく `hnsw.ef_search` に依存する値になり（データと無関係な定数）、正しい件数を出すプランでは索引が捨てられ Seq Scan に落ちる（本書冒頭が禁じる「索引が効かない形」そのもの）。**代わりに §5（目次帯）が既にスコープ全体の群カウント集約を走らせており、その総和が「フィルタ条件下に何件あったか」そのものである。** 追加コスト無しに exact な件数を得られる経路は、段1のクエリではなく段5の集約から得る。詳細は ADR 0011（`docs/decisions/0011-no-window-count-in-ann-stage.md`）を参照。

### over-fetch 係数の決め方

既定案は **k' = k × 4**（k=10 なら k'=40 を取得し、段2で10件に絞る）。この数字に強い根拠はなく、次の裁量として書く。

- 係数を大きくするほど、段2が「本来なら上位に来るはずだった記憶」を取りこぼす確率は下がるが、段2の計算量（O(k')）と DB からの転送量が線形に増える。
- 係数を小さくするほど、段1の ANN 索引の再帰が浅くなり、`hnsw.ef_search` を上げない限り取りこぼしが増える。
- テナントのデータ規模が小さいうちは k' が候補総数を超えることがあり、その場合は事実上フルスキャンと同じ精度になる（取りこぼしは発生しない）。

**正直に書くべき限界**: over-fetch は近似である。「段1で k' 位以下に落ちたが、段2の再スコアなら k 位以内に入れたはずの記憶」は、原理的に recall に現れない。これは実装のバグではなく、この構成そのものが持つ性質である。したがって mnemora は取りこぼしを隠さず、`Omission { kind: 'ann_truncated', countKind: 'unknown' }` として結果に出す。`countKind` が `'unknown'` である理由は、ANN が「返さなかった候補」の総数は原理的に数えられないためである(§4)。

---

## 4. 「無い」の分類

### 渡された問題設定

「検索して0件だった」「そもそも検索していない」「候補には出たがスコアで落ちた」「フィルタで落ちた」「候補に出たが LLM が使わなかった」は、呼び出し側から見るとどれも「結果に現れなかった」という一点で同じに見える。しかし mnemora はこれらを型で区別する。区別する基準はただ一つ、**「その区別があると、呼び出し側の次の一手が変わるか」**である。区別のための区別はしない。

例えば「そもそも検索していない」は、呼び出し側に「別の経路（埋め込み待ちの再試行、フォールバック検索）を試す」という一手を与える。「候補には出たがスコアで落ちた」は、「閾値を緩めて聞き直す」という一手を与える。この二つを 0 件という同じ顔で返すと、後者しかできない呼び出し側は前者に対しても無力なままになる。

### ⚠ alteroid から確認できたこと・できなかったこと

この節を正直に書く。**alteroid の現物を読んだ結果、「候補に出たがスコアで落ちた」「候補に出たが LLM が使わなかった」に相当する処理はそもそも alteroid に存在しない。** alteroid の記憶へのアクセスは `memory_list`（一覧）と `memory_read`（slug 指定で開く）のみであり、スコア付き候補・閾値・LLM 選別を伴う検索は無い。埋め込み・ベクトル検索・rerank はリポジトリ全体で1件もヒットしなかった。

alteroid で確認できたのは1箇所だけである——journal（日誌）の部分一致検索(`ILIKE`)が0件を返したとき、「探索対象に入っていない欄がある」ことまで自然文で応答に含めている実装がある。これは「検索して0件」と「そもそも検索していない」の区別に当たり、この節が採用する原則の核そのものである。ただし決定的な違いがある。**alteroid のそれは型に落ちた構造ではなく、自然文1メッセージである。** mnemora がやるのは、その態度を型に持ち上げることである。これは alteroid の延長線上の作業ではなく、mnemora で新しく行うことだと明記しておく。「候補に出たがスコアで落ちた」以下の区別に alteroid からの経験的裏付けは無い——設計判断として独自に採用する。

### `Omission.kind` の一覧

```ts
type CountKind = 'exact' | 'lower_bound' | 'unknown'

type Omission =
  | { kind: 'stage_skipped'
      stage: 'candidate_generation' | 'rescore' | 'index_band'
      reason: 'embedding_provider_unavailable' | 'empty_query_content' | 'budget_exhausted' }
  | { kind: 'filtered'
      condition: 'tenant' | 'superseded' | 'forgotten' | 'archived' | 'taxonomy' | 'period'
      count: number; countKind: CountKind }
  | { kind: 'below_threshold'
      count: number; countKind: CountKind
      nearMisses?: { memoryId: string; score: number }[] }
  | { kind: 'over_limit'
      count: number; countKind: CountKind }
  | { kind: 'budget_dropped'
      count: number; countKind: CountKind }
  | { kind: 'not_indexed'
      reason: 'pending' | 'failed' | 'skipped'
      count: number; countKind: CountKind }
  | { kind: 'ann_truncated'
      countKind: 'unknown' }
  | { kind: 'ann_unreached'
      countKind: 'unknown' }
  | { kind: 'score_not_comparable'
      count: number; countKind: CountKind }
  | { kind: 'unit_assembly_dropped'
      count: number; countKind: CountKind }
```

**`ann_truncated` と `ann_unreached` の違い（2026-09 追記、[ADR 0025](./decisions/0025-ann-underfill-is-not-reported-in-omitted.md)・[ADR 0026](./decisions/0026-ann-unreached-omission.md)）**:
`ann_truncated` は「k' に達した＝もっと在るはずだが LIMIT で打ち切った」という**打ち切り**であり、
`ann_unreached` は「k' に届く前に、近似索引がこの scope の候補へ**そもそも辿り着かなかった**」
という**取りこぼし**である。前者は「LIMIT を打った」という確定した事実、後者は
「scope にまだ見られていない候補が残っているのに、返った件数が k' 未満で止まった」という
不確実な事実であり、原因も違えば呼び出し側の次の一手も違う（前者は k' を上げる、
後者は厳密検索へのフォールバックを検討する）。**2つは同時には立たない**
——`ann_truncated` の条件（hits ≥ k'）と `ann_unreached` の条件（hits < k'）は排反である。

| kind | 次の一手がどう変わるか |
|---|---|
| `stage_skipped` | その段の経路自体を疑う（埋め込み provider の復旧、クエリの中身の見直し、予算そのものの見直し）。スコアやフィルタの調整では直らない。 |
| `filtered` | 条件を緩める判断ができる（例: `taxonomy` フィルタを外す、`period` を広げる）。どの条件かが分かって初めて緩め方が決まる。`condition: 'superseded'` なら `superseded_by_id` を辿って置き換え先を探す一手があるが、`condition: 'forgotten'` にはその一手が無い（利用者が意図して忘れさせたものであり、指す先を持たない）。この2つを束ねると一手が選べなくなる（ADR 0027）。 |
| `below_threshold` | 閾値を緩めて聞き直す判断ができる。`nearMisses` があれば「惜しかったものがどれくらい惜しかったか」まで見える。 |
| `over_limit` | 閾値は超えている集合が k より大きいと分かる。k を増やす、あるいはページングする一手につながる。 |
| `budget_dropped` | スコアの問題ではなく量の問題だと分かる。予算を緩めるか、`memories` を要約させる判断につながる。 |
| `not_indexed` | 記憶は存在するが埋め込みがまだ無いと分かる（`embeddingStatus`、`./memory-model.md` 参照）。埋め込みジョブの遅延を疑う一手につながり、記憶が失われたと誤認しない。 |
| `ann_truncated` | 「見えていない領域があるかもしれない」という不確実性そのものが一手になる——例えば厳密検索へのフォールバックを選べる。 |
| `ann_unreached` | 近似索引がこの scope に届かなかった可能性がある、と分かる（ADR 0025・0026）。`ann_truncated`（打ち切り）とは別の出来事——こちらは k' に届く前に候補を取りこぼした疑いであり、厳密検索へのフォールバックや subject を絞り直す一手につながる。件数は原理的に分からない（`countKind` は常に `'unknown'`）。 |
| `score_not_comparable` | **スコアが閾値と比較できなかった**と分かる（[ADR 0044](./decisions/0044-score-not-comparable-omission.md)）。閾値を緩めても直らない——`below_threshold` とは別の出来事である。実際に起きるのは埋め込みがゼロベクトルのとき（コサインが未定義になり距離が `NaN` になる。[ADR 0040](./decisions/0040-zero-vector-never-returned.md)）で、次の一手は「その記憶の埋め込みを作り直す」であって「閾値を下げる」ではない。**件数は数え上げられる**（段2が触った候補の三分割なので）——ただし `countKind` は三分割が網羅であることを確かめた結果から決まる。 |
| `unit_assembly_dropped` | **段3で単位を組むときに候補が漏れた**と分かる（[ADR 0043](./decisions/0043-unit-assembly-dropped-omission.md)）。原因は `contested_with_id` の一対一が破れていることであり、次の一手は「その対向関係を直す」——閾値にも予算にも索引にも関係がない。**⚠ Phase 1 では発生しない**（`Runtime` は `contested` を作らない）。`countKind` は `'lower_bound'`——二重計上が同時に起きていると消失が隠れるため、下限しか言えない。 |

### 件数にも「無いの種類」を適用する

`Omission.countKind: 'exact' | 'lower_bound' | 'unknown'` は、omitted の「件数」自体に対して原則3を適用したものである。`filtered` の件数は SQL の `WHERE` 条件で正確に数えられるので `'exact'` になり得る。一方、**ANN が候補として返さなかったものの件数は原理的に数えられない**——ANN 索引はテーブル全体を走査しないので「返さなかった件数」という概念自体が索引の外にある。この場合は `'unknown'` を置く。中間として、下限だけは分かる（例えば段1の LIMIT に達したことは分かるが、その先に何件あるかは分からない）場合に `'lower_bound'` を使う。**推定値を実測値の顔で出さない**——これが `countKind` を持つ理由のすべてである。

### 5つ目のケースは recall の外側にある

「候補に出て返したが、LLM がそれを使わなかった」は、recall の実行時点では原理的に判定できない。何を使ったかは呼び出し側の LLM 呼び出しの後にしか確定しない。この情報は `recallId` を持ち帰った呼び出し側が `observe(ctx, { kind: 'memory_usage', recallId, usedMemoryIds })` を呼んで初めて mnemora に届く。

このことから二つの帰結が導かれる。

1. **recall は必ず記録されなければならない。** `recallId` が発行されない recall は、後から「何を使ったか」を紐付ける先を持たない。段6（記録）が省略可能な段ではない理由はここにある。
2. **これは「実際に使われたものだけを強化する」（[./memory-model.md](./memory-model.md) の強化の節）が必要とする機構と同一である。** `recall_usages(recall_id, memory_id)` という同じテーブル・同じ経路が、「LLM が候補の何を選んだか」という説明可能性の要求と、「何を強化するか」という reinforcement の要求の両方を満たす。一つの機構が二つの要求を満たしており、これは偶然の一致ではなく、両者が「実際に使われた」という同じ事実を必要としているからである。

---

## 5. 目次帯 / 被覆不変条件

### 渡された定式

> 目次は、検索を不要にする仕組みではなく、検索が外れたことを可視化する仕組みである。埋め込みを「必ず当たらなければならないもの」から「当たったら得なもの」へ降格する。

この定式を mnemora でも採る。ただし可視化の担い手が alteroid とは異なる。

### ⚠ alteroid の限定

alteroid の「全文か目次1行かのどちらかに必ず現れる」という二階建ての不変条件は、現物のコード(`packages/core/src/memory.ts` の `renderMemoryDocuments` / `buildMemoryDocumentSections`)で確認できた。分岐が2値しかなく、frontmatter が無い・壊れている・未知の値はすべて `premise`（全文・安全側)に倒れる安全弁も確認できた。ここは mnemora が真似すべき点である——**分類に失敗したとき、記憶を「目次だけ」の薄い側に落とさない。曖昧なら厚い側に倒す。**

一方で、重要な限定が三つある。

1. **不変条件が厳密に成立するのはセッション構築時の1回(システムプロンプト全体)についてだけ**である。セッション途中の差分通知(「変わった文書だけ」を渡す経路)では成立しない——これはコードの doc コメント自身が明記している穴である。したがって mnemora は「どの単位で保証されるか」を最初に定義する。**被覆不変条件は `recall()` 1回の返り値について成立する**、と定義し、これを曖昧にしない。セッションという単位を mnemora は持たない(§6 で述べる理由と同根)。
2. **alteroid には埋め込みが存在しない。** したがって「埋め込みを安全に外せるようにする」という alteroid の教訓は、「埋め込みが最初から無い」状態の記述であって、「埋め込みを持つ系に目次を足した」経験ではない。この違いは決定的である。mnemora は埋め込みを持つ系で目次帯を設計する初めてのケースであり、alteroid からの実績としては引用できない。
3. alteroid の目次には**エントリ数の上限(300件)がある。** 規模で壊れる経路が既にコード上に見えている。

### mnemora の決定: 三階建ての被覆不変条件

**recall のスコープ内にある全ての Memory は、返り値の中に (1) 全文 / (2) digest 1行 / (3) それが属する群の件数 のいずれかで必ず現れる。かつ (3) の件数の総和は、スコープ内の総数と一致する。**

**「スコープ」の外延は §2 段0「スコープの外延」で確定した(tenant + subject + 時間窓 + taxonomy + status ゲート)。この不変条件が指す「スコープ内の総数」はその定義そのものであり、status ゲートで落ちた Memory(`archived`/`superseded`/`forgotten`)は「スコープ内」に含まれない——したがって群カウントにも乗らない。乗るのは、スコープには入ったが段1〜4のどこかで(索引未整備・閾値・件数超過・予算のいずれかで)落ちたものだけである。**この区別を曖昧にすると、この不変条件は「在るなら出せるはず」という誤読を生む——忘れられた Memory まで「在る」と数えて見せることは、原則3(結果は、そこから漏れたものと必ず同時に提示する)の逆効果になる。**

二階建てが mnemora で成り立たない理由は単純である。1テナントが100万件の Memory を持ちうる設計で、digest 1行ずつでもプロンプトに載せれば数十万文字になる。alteroid の二階建てが成立していたのは、想定するのが単一所有者・文書数が少ないという前提の上だからである(§1 参照)。mnemora はこの前提を持たない。

そこで第3階(群カウント)を導入する。**第3階が「完全」(総和が一致)であることが、この設計の要である。** これによって「recall が0件でも、何が在るかは知っている」が成立する。0件の recall がどう見えるか、`index` フィールドだけを示す。

```json
{
  "recallId": "rcl_01HXYZ...",
  "memories": [],
  "omitted": [
    { "kind": "filtered", "condition": "period", "count": 3, "countKind": "exact" }
  ],
  "index": {
    "groups": [
      { "axis": "subject", "key": "project/mnemora", "count": 412, "countKind": "exact" },
      { "axis": "subject", "key": "person/alice/preference", "count": 30, "countKind": "exact" },
      { "axis": "subject", "key": "person/bob/preference", "count": 12, "countKind": "exact" }
    ],
    "totalInScope": 454,
    "countKind": "exact"
  }
}
```

該当0件という結果だけを見ると「このテナントには何も無い」ように読めるが、`index` を見れば「このスコープには454件あり、`project/mnemora` に412件、`person/alice/preference` に30件、`person/bob/preference` に12件ある」ことが分かる。0件は「記憶が無い」ではなく「その問い方には引っかからなかった」だと機械的に判別できる。これが「検索を不要にする仕組みではなく、検索が外れたことを可視化する仕組み」の mnemora での実装である。

### 型

```ts
type IndexBand = {
  groups: GroupCount[]
  totalInScope: number
  countKind: CountKind         // groups の総和が totalInScope と一致するかの信頼度
  digestBand?: DigestEntry[]   // Phase 2。Phase 1 では常に undefined
}

type GroupCount = {
  axis: 'subject' | 'taxonomy' | 'time_window'
  key: string | null   // D12（2026-09 追記）: subject_id IS NULL の群は null で表す。
                        // '(none)' のような番兵文字列は実在する subject 名と衝突しうるため採らない。
  count: number
  countKind: CountKind
}
```

### 正直に書くべき限界

第3階の完全性は `count(*)` を要求する。大規模テナントで、recall のたびに毎回厳密な `count(*)` を取るのはコストが高い(pgvector の類似検索とは別に、group by の集約クエリが走る)。したがって**群カウントは近似を許すが、近似であることを型で示す**——`GroupCount.countKind` が `'lower_bound'` や `'unknown'` になり得る。近似カウントを許すかどうかは recall のオプションにし、**既定は近似許可**とする(厳密性より低レイテンシを優先する)。厳密カウントを要求する呼び出し側は、明示的にオプションで指定する。

> **⚠ 2026-09 追記: 上の段落は設計の意図であって、Phase 1 の実装ではない。**
> Phase 1 は**常に厳密集計**であり、近似経路もそれを要求するオプションも**存在しない**（下記「Phase 1 の実装上の限界」・[ADR 0024](./decisions/0024-remove-exact-counts-option.md)）。
> **近似が実際に要るかどうかは、下記「`aggregateScope` の実測」で 10k / 100k / 1M の3点を測った。**
> 費用は**テナント全体の集計**に在り（1M で 408ms）、**subject で絞った集計には無い**（全規模で 1ms 未満）。
> **ただし「何 ms なら割に合わないか」の閾値をこの repo は定義していないので、
> 「近似が要る」とはまだ結論していない。**欄を足すかどうかは、その閾値を決めてからである。
> **欄を先に足すと、[ADR 0011](./decisions/0011-no-window-count-in-ann-stage.md) の `count(*) OVER ()` と同じ事故になる**
> ——区別を表す欄が、名乗りどおりの値を持たないまま置かれる。

**Phase 1 の実装上の限界(2026-09 追記、本 PR)**: 上記は近似経路を持つことを前提に書かれているが、`MemoryStore.aggregateScope`(roadmap.md 段階4/5 の実装)は Phase 1 では**常に厳密集計のみ**を実装しており、近似経路(例えば `pg_stats`/`reltuples` に基づく安価な推定)は無い。**近似を要求するオプションも持たない**——以前は `RecallQuery.exactCounts` という欄が型に在ったが、値を受け取って黙って無視していた（呼び出し側は「頼んだ」と思い込める形だった）ため、[ADR 0024](./decisions/0024-remove-exact-counts-option.md) で**削除した**（「予約・未実装」と書き残すのではなく消した。理由は ADR を参照）。これは 100万件級のテナントで `aggregateScope` のコストが無視できなくなる可能性を先送りしたものであり、隠さずここに書く(PR 本文「設計上の疑義」参照)。

### `aggregateScope` の実測（2026-09 追記）

上の「先送りにした」コストを、規模を振って測った（GitHub Actions run 34009301567、
PostgreSQL 17 + pgvector、`packages/postgres/src/bench/scale-bench.ts`、擬似の合成ベクトル・
実 API 不使用）。

| 規模（行数） | subject 数 | 変種 | 所要時間（中央値） | プランの要点 |
|---:|---:|---|---:|---|
| 10,000 | 200 | 全体 | 9.0ms | Seq Scan あり（HashAggregate） |
| 10,000 | 200 | subjectId 指定（小さい subject） | 0.9ms | Seq Scan 無し（GroupAggregate + idx_memories_by_subject） |
| 100,000 | 2,000 | 全体 | 45.8ms | Seq Scan あり（Finalize HashAggregate、並列） |
| 100,000 | 2,000 | subjectId 指定（小さい subject） | 0.7ms | Seq Scan 無し |
| 1,000,000 | 20,000 | 全体 | 408.0ms | Seq Scan あり（Finalize HashAggregate、並列） |
| 1,000,000 | 20,000 | subjectId 指定（小さい subject） | 0.7ms | Seq Scan 無し |

**読み方**: コストは「テナント全体を集計する」呼び出しに在り、「subject で絞って集計する」
呼び出しには無い。全体集計は 10k→9.0ms / 100k→45.8ms / 1M→408.0ms と規模に応じて伸びる
（`Seq Scan` を伴う `HashAggregate`）。一方 subject 指定は全規模でおおむね 0.7〜0.9ms の
横ばいで、`idx_memories_by_subject` を使った索引スキャンに乗っている。

**⚠ この数値だけから「近似が要る／要らない」を結論しないこと。** 「何 ms なら割に合わないか」
の閾値を、この repo はまだ定義していない。ここでは生の数値とスケーリングの傾向だけを示し、
閾値の判断は読む人に委ねる。

**⚠ 測っていないこと**:

- ~~大きい subject を測っていない~~ → **測った**（run 34010394105、全体100,000行固定・次元256固定、
  狙いの subject の行数は `SELECT count(*)` で実測）。`aggregateScope` は subject が大きいほど伸びる:
  **10行で 0.8ms / 1,000行で 1.2ms / 10,000行で 5.2ms**。
  ⟹ **subject で絞れている限り、テナント全体の集計（100,000行で 45.8ms、1,000,000行で 408ms）
  とは桁が違う。** ただし**全体行数は 100,000 に固定しており、振っていない。**
  同じ subject の大きさでも全体行数が変われば結果は変わりうる。
- **同時実行下では測っていない**（単発クエリの中央値のみ）。
- 1,000,000行を超える規模、および `subject` 以外の軸（`taxonomy` / `time_window`）での
  集計は測っていない。

このベンチは同時に `PostgresVectorStore.search` の subject フィルタ（段1の ANN クエリ）も
測っており、そちらの実測と見立ての訂正は
[ADR 0023](./decisions/0023-subject-filter-in-ann-stage.md) の追記節に書いた
（本節が対象とする `aggregateScope` とは別のクエリである）。

**回し方**: `pnpm --filter @mnemora/postgres run bench:scale`。環境変数
`BENCH_SCOPE_SCALES` / `BENCH_VECTOR_SCALES` / `BENCH_VECTOR_DIMENSIONS` で規模・次元数を
調整できる（既定値・詳細は `packages/postgres/src/bench/scale-bench.ts` 冒頭のコメントを参照）。
**このベンチは CI に常時つないでいない**——一時的な計測ジョブで1回回した実測であり、
手で回す口として repo に残っている。

### Phase 1 の範囲

**Phase 1 では第3階(群カウント)のみを実装する。digest 帯(第2階)は Phase 2 に送る。** 理由は、digest 帯が taxonomy(分類語彙)を要するのに対し、群カウントは `subject` 単位だけでも成立するからである。Phase 1 の `IndexBand.groups` の既定 `axis` は `'subject'` とする。`taxonomy` 軸によるグルーピングは、taxonomy の `registered` / `proposed` 状態(`./memory-model.md` の taxonomy strict/open の節を参照)を扱う必要があり、digest 帯と合わせて Phase 2 に含める。`time_window` 軸は型として持つが Phase 1 で既定にはしない。

最も価値のある性質——「0件でも何が在るか言える」——は、digest を持たなくても群カウントだけで既に得られる。これが Phase 1 の範囲をこう切った理由である。

**⚠ 2026-09 訂正（digest 帯の実装 PR、[ADR 0073](./decisions/0073-digest-band-bounded-without-taxonomy.md)）: 「digest 帯が taxonomy(分類語彙)を要する」という上の理由は誤りだった。**

**digest 帯は taxonomy を要さない。**`DigestEntry` は `{ memoryId, digest }` だけで `axis` を持たない（`axis` を持つのは `GroupCount` のほうである）。`digest` は Phase 1 の `memories` 列であり `NOT NULL` である。taxonomy を要するのは、**同じ段落の後半が既に書いているとおり `taxonomy` 軸によるグルーピングのほう**であって、帯そのものではない。したがって帯は `labels` / `memory_labels` を待たずに実装できる——schema も migration も変更していない。

**⛔ ただし Phase 1 / Phase 2 の線は動いていない。**オーナーの指示により**「1件1行の要旨を出す機能」1つだけを前倒しで実装した**。`taxonomy` 軸によるグルーピング・`labels` / `memory_labels`・その他の Phase 2 の項目は**前倒しされていない**。**1つの機能が前に出ただけであり、Phase 2 が始まったわけではない。**

**⚠ そして帯には上限が要る。**上の「1テナントが100万件の Memory を持ちうる設計で、digest 1行ずつでもプロンプトに載せれば数十万文字になる」という段落が述べているとおり、**上限のない digest 帯はこの文書が明示的に落とした案である**。実装は**件数・帯全体の文字数・1件あたりの長さの3つ**の上限を持ち、どの上限で切れたかを `IndexBand.digestBandCoverage.limitedBy` で名乗る。**切り詰められたものは第3階の群カウントに乗り続けるため、被覆不変条件は壊れない**——三階建てはそのために在る。理由と採らなかった案は [ADR 0073](./decisions/0073-digest-band-bounded-without-taxonomy.md)。


---

## 6. 焼かれる量の計測と予算

```ts
type RecallUsage = {
  chars: number              // 返した全量（memories tier + 目次帯）
  estimatedTokens: number
  counter: 'heuristic' | 'exact'
  byTier: { full: number; digest: number; index: number }
  indexChars: number         // 目次帯の実費。budget の対象外（下記）
  share?: number             // budget 申告時のみ: memories tier / budget。1 を超えない
}

type RecallBudget = {
  maxMemoryChars?: number    // memories tier の上限。目次帯は含まない
  maxMemoryTokens?: number   // 同上（トークン）
  promptBudgetTokens?: number
}

interface TokenCounter {
  count(text: string): { tokens: number; counter: 'heuristic' | 'exact' }
}
```

### ⚠ 目次帯は予算の対象外である（2026-09 訂正）

**`budget` が縛るのは `memories` tier だけである。目次帯（`IndexBand`）は予算の対象外であり、
`budget` をどれだけ小さくしても削られない。**

理由は [ADR 0008](./decisions/0008-absence-taxonomy.md) の芯にある——目次帯の唯一の存在理由は
**「recall が0件でも、何が在るかは言える」**ことである。これを予算の対象にすると、
**呼び出し側が渡した数字ひとつでその保証が消える。予算次第で消える保証は、保証ではない。**

**当初案は予算の項目を `maxChars` / `maxTokens` と呼んでいた。これは誤りだった**——
「recall 全体の上限」と読める名前でありながら、実際には `memories` tier しか縛らない。
名前を `maxMemoryChars` / `maxMemoryTokens` に改め、**何に対する上限なのかを名前に出す。**
名前で誤解を潰しておかないと、次に誰かが「予算なのに効かないのは変だ」と言って
目次帯を予算に含めにいく。**そのとき止めるのは、名前ではなく上に書いた理由である。**

### ⚠ `share` は「予算の何割を使ったか」であり、「全体でいくらか」ではない（2026-09 訂正）

当初の実装は `share` の分子に**目次帯を含めていた**。目次帯は予算の対象外なので、
予算が縛っていない量まで分子に数えることになり、**`share` が 100% を超えた**
（サンプルアプリで 248.3% を実測）。

**1つの数で2つの問いに答えようとすると、どちらかが嘘になる。**

| 問い | 答える値 |
|---|---|
| 私が渡した予算のうち、記憶がどれだけ使ったか | `share`（**1 を超えない**） |
| この応答は全体でいくらかかったか | `chars`（= `memories` tier + `indexChars`） |

⟹ **`share` の分子は `memories` tier だけとする。**段4の切り詰めが `memories` tier を
予算内に収めることを保証しているので、この定義なら `share` は 1 を超えない
（`RecallUsageSchema` が型としても 1 以下しか受け付けない）。
全体量を知りたい呼び出し側は `chars` を見るか、`chars - indexChars` で予算対象分を取れる。

**これは「無い」の種類を潰さない、という規律を*数*に当てたものである**——
割合として成立しない数を、割合の顔で返さない。

`budget` は `recall()` への入力、`usage` は出力である。この二つを分けて持つことに意味がある——後述する。

### 正直に書くべき限界: mnemora はプロンプトを組み立てない

`usage.share` が測れるのは「呼び出し側が `budget` を申告した場合の、その予算に対する割合」だけである。**「プロンプト全体の何割を mnemora の出力が占めているか」は mnemora には原理的に測れない。** mnemora が返した文字列を呼び出し側がどう他の文脈(システムプロンプト、ツール定義、会話履歴)と組み合わせるかは mnemora の関知するところではないからである。alteroid が「セッション構築時点からの増分%」を出せているのは、alteroid 自身がプロンプト全体を組み立てているクローンだからである。mnemora とアプリケーションの間にはこの非対称性があり、それを明記しておく([./roadmap.md](./roadmap.md) のリスク「認知レイヤーが利用側のプロンプト構築と密結合になるリスク」と同根)。

### セッション基準値を持たない

alteroid の増分計測は「セッション構築時点」を基準にしており、その基準値は**プロセス内のメモリ変数**として保持されている。これは「1クローン = 1長寿命プロセス」という前提に強く依存する設計である。mnemora は多テナント・マルチインスタンスで動くことを前提としており、「セッション」という概念自体を持たない——セッションの概念は呼び出し側にある。この基準値を mnemora 側に持ち込むと、それをどこかに永続化する必要が生じ、mnemora が状態を持つことになる。したがって**mnemora は「セッション構築時点からの増分」を持たない**という決定をしている。mnemora が返すのは「1回の recall が返した量」(`usage`)と、予算が申告されていればその割合(`share`)だけである。

### ⚠ 最も重い発見: 計測は行動を変えると仮定しない

alteroid のコード自身が「この計測機能が効くかは未検証」と明記している。実測ログには、文字数が 37,515 から 51,751(+38%)まで増えたのを見ながら、クローンが畳む(要約・削除する)行動を取らなかった事例が記録されている。**「測って見せれば行動が変わる」という前提を、検証済みのものとして輸入してはならない。** mnemora は計測(`usage`)を提供するが、それが肥大を抑止すると主張しない。

### 設計上の帰結

抑止するのは計測ではなく、実際に超えたら落とす**強制力のある予算**である。したがって mnemora は計測(`usage`)と強制(`budget`)を型として分け、両方を持つ。`usage` だけを返して「見えるようにしたのだから後は呼び出し側の判断」で済ませない。`budget` を渡された recall は、パイプライン段4で実際に候補を切り詰める。渡されなければ切り詰めは起こらず、`usage` は観測専用の値になる。

### トークン数の推定

core はモデル固有のトークナイザに依存しない。`TokenCounter` interface を core に置き、既定実装は文字数ベースの推定(ヒューリスティック)とする。実装を差し替えれば特定モデルの正確なトークナイザ(`counter: 'exact'`)に切り替えられる。**推定値には必ず `counter: 'heuristic' | 'exact'` を付ける**——これも「推定値を実測値の顔で出さない」という原則3の適用である。この計測(`usage`)は Phase 1 に含める。「載せる量を測る」はコスト管理の一部であり、後から足す性質のものではない。

---

## 7. スコア内訳と説明

`RecalledMemory` はスコアの内訳を要素ごとに個別に見える形で持つ。

```ts
type RecalledMemory = {
  memoryId: string
  digest: string
  retrievedVia: 'ann' | 'tag_match' | 'recency' | 'mandatory_companion'
  companionOf?: string          // 矛盾の相手として同伴取得された場合、その相手の memoryId
  provenanceKind: ProvenanceKind // 本人が述べた事実か、AI の推論か（オーナーの原則7）
  score: ScoreBreakdown
}

type ScoreBreakdown = {
  similarity?: number   // ANN 経由でのみ存在。距離から変換した類似度
  decay: number          // decay(now, lastReinforcedAt, strength, halfLife) の値
  tagMatch: number
  freshness: number      // 1 で頭打ち（ADR 0036）。まだ起きていない出来事は古びようがない
  strength: number
  total: number           // 段2で使った最終スコア
}
```

Memory 本体(内容・provenance の詳細・状態)の型は `./memory-model.md` に譲る。ここで持つのは recall という文脈固有の付加情報——「どの経路で拾われたか」「スコアの内訳」「同伴取得ならどの矛盾の相手として来たか」、そして**「本人が述べた事実か、AI の推論か」**である。

**`provenanceKind` だけは `Memory` 本体からの持ち出しである(2026-09 追記)。**理由は `./memory-model.md` §2 が既に書いていた——「recall がデフォルトで `stated` と `inferred` を**区別して返す**」ために `provenance_kind` を列に上げている。**列は最初から在ったが、`recall()` の返り値に出ていなかった。**オーナーが `../roadmap.md` §5.5 の回答で「含める。ただし `provenance.kind` で区別して返す」という条件を明示したため、この欠落を塞いだ([ADR 0035](./decisions/0035-recalled-memory-provenance-kind.md))。

**⚠ 持ち出すのは `kind` だけである。**`model` / `promptVersion` / `basis` / `confidence` は返さない。求められているのは**区別**であって中身の追加ではなく、毎回の返り値を太らせない(問い1)。それらが要る呼び出し側は `MemoryStore.get()` を引く——「1件を詳しく見る」は別の問いである。

**「なぜこれが返ったか」は自然文ではなく構造で返す。** `explain.stages` と `RecalledMemory.score` を組み合わせれば「段1でベクトル距離0.12として拾われ、段2で decay 0.9 × tagMatch 1.2 × freshness 1.0 × strength 0.8 を掛けて total 0.83 になり、k=10 の9位で予算内に収まった」という説明を機械的に再構成できる。この構造から自然文の説明文を組み立てるのは呼び出し側の仕事であり、mnemora の仕事ではない。理由は §6 で述べたのと同じ——mnemora はどんな言語で・どんなトーンで・誰に向けて説明するかを知らない。mnemora が保証するのは、説明を組み立てるために必要な材料が欠けていないことだけである。

---

## 8. 矛盾がある場合の提示

段3(矛盾の解決と必須の同伴取得)が recall パイプライン上でどう働くかを述べる。データモデル側の詳細(`status` の遷移、`contradicts` の対向関係、`superseded_by_id` 列)は `./memory-model.md` に譲る。

recall は既定で `status = 'active'` の Memory のみを候補にする。ただし `contested`(判定できない矛盾)の Memory は、候補になった時点で**単独では返さない**。対向する Memory(`contradicts` の相手)をスコアに関係なく候補集合へ追加する。これが段3の仕事であり、`RecalledMemory.retrievedVia = 'mandatory_companion'` として、それがスコアで選ばれたのではなく矛盾解決のために強制的に足されたことを型で示す。

**予算(段4)と衝突したときの優先順位: 同伴を落とすくらいなら本体を落とす。** `contested` の Memory とその対向は必ずペアで扱い、ペアを分割して片方だけを予算内に残すことはしない。予算が両方を載せられない場合、そのペア全体を候補から外し、`Omission { kind: 'budget_dropped', ... }` に含める(あるいは、そのペアの片方だけを「争われている」という印を付けて残す設計も選択肢としてあり得るが、Phase 1 の既定は「両方落とす」とし、争われている主張を争われていない顔で出すという事故を避ける側に倒す)。**争われている主張を、争われていない顔で出すくらいなら、両方とも出さない**——これが原則1の recall パイプライン上の実装である。
